begin;
-- Local integration only. No mode switch, scheduler, evaluation or delivery worker.
create schema purchase_writer_internal;
revoke all on schema purchase_writer_internal from public, anon, authenticated, service_role;
create table purchase_writer_internal.originals(name text primary key, definition text not null);
create table purchase_writer_internal.grants as
select table_name,privilege_type from information_schema.table_privileges
where table_schema='public' and grantee='service_role';

-- Preserve the legacy bodies and signatures, but expose only gate-first wrappers.
do $migration$
declare f record; args text; body text; prelude text; postlude text; declaration text;
begin
  for f in select p.oid,p.proname,p.prorettype,p.proretset,p.proargnames,
      pg_get_function_arguments(p.oid) parameters,pg_get_function_result(p.oid) result,
      pg_get_function_identity_arguments(p.oid) identity,pg_get_functiondef(p.oid) definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname=any(array['save_review','cache_exchange_rate','create_product_reading',
      'claim_product_reading','complete_product_reading','create_product_repair',
      'confirm_product_reading','mutate_list','configure_list_basket','set_basket_item',
      'claim_basket_events','finish_basket_event','record_basket_snapshot']) order by p.proname
  loop
    insert into purchase_writer_internal.originals values(f.proname,f.definition);
    execute replace(f.definition,'FUNCTION public.'||f.proname||'(', 'FUNCTION purchase_writer_internal.'||f.proname||'(');
    execute format('revoke all on function purchase_writer_internal.%I(%s) from public,anon,authenticated,service_role',f.proname,f.identity);
    args:=array_to_string(f.proargnames,','); prelude:=''; postlude:=''; declaration:='';
    if f.proname='save_review' then
      postlude:='perform public.invalidate_purchase_inputs(array[p_product_id]);';
    elsif f.proname='cache_exchange_rate' then
      postlude:='perform public.invalidate_purchase_inputs(''{}'',true);';
    elsif f.proname='confirm_product_reading' then
      declaration:='already_confirmed boolean;';
      prelude:=$code$
        select status='confirmed' into already_confirmed from public.product_readings where id=p_id;
        if exists(select 1 from public.lists where id=(p_confirmation->>'list_id')::uuid and purchase_mode='alternatives') then
          raise exception using errcode='PT409',message='purchase_configuration_required';
        end if;
      $code$;
      postlude:=$code$
        if not coalesce(already_confirmed,false) then
          perform public.invalidate_purchase_inputs(array[(answer->>'product_id')::uuid]);
        end if;
      $code$;
    elsif f.proname in ('configure_list_basket','set_basket_item') then
      prelude:=$code$
        if exists(select 1 from public.lists where id=p_id and purchase_mode='alternatives') then
          raise exception using errcode='PT409',message='purchase_configuration_required';
        end if;
      $code$;
    elsif f.proname='record_basket_snapshot' then
      prelude:=$code$
        if exists(select 1 from public.lists where id=p_id and purchase_mode='alternatives') then return; end if;
      $code$;
    end if;
    if f.proretset then
      body:=format('return query select * from purchase_writer_internal.%I(%s);',f.proname,args);
    elsif f.prorettype='void'::regtype then
      body:=format('perform purchase_writer_internal.%I(%s); %s return;',f.proname,args,postlude);
    else
      declaration:=declaration||format('answer %s;',f.result);
      body:=format('answer:=purchase_writer_internal.%I(%s); %s return answer;',f.proname,args,postlude);
    end if;
    execute format('create or replace function public.%I(%s) returns %s language plpgsql security definer
      set search_path='''' set default_transaction_isolation=''serializable'' as %L',
      f.proname,f.parameters,f.result,'declare '||declaration||' begin perform public.enter_purchase_operation(); '||prelude||body||' end');
  end loop;
end $migration$;

-- Legacy projections must never change an alternatives configuration/version.
do $migration$
declare definition text;
begin
  select pg_get_functiondef('public.snapshot_basket_change()'::regprocedure) into definition;
  insert into purchase_writer_internal.originals values('snapshot_basket_change',definition);
  execute replace(definition,
    'select list_id from public.basket_items where product_id = new.id order by list_id',
    'select i.list_id from public.basket_items i join public.lists l on l.id=i.list_id where i.product_id=new.id and l.purchase_mode=''legacy'' order by i.list_id');
  select pg_get_functiondef('public.snapshot_exchange_rate_change()'::regprocedure) into definition;
  insert into purchase_writer_internal.originals values('snapshot_exchange_rate_change',definition);
  execute replace(definition,'where l.currency in', 'where l.purchase_mode=''legacy'' and l.currency in');
  select pg_get_functiondef('purchase_writer_internal.claim_basket_events(uuid)'::regprocedure) into definition;
  execute replace(definition,'where budget is not null','where purchase_mode=''legacy'' and budget is not null');
  select pg_get_functiondef('purchase_writer_internal.finish_basket_event(uuid,boolean)'::regprocedure) into definition;
  execute replace(definition,'where id = e.list_id and composition_version', 'where purchase_mode=''legacy'' and id = e.list_id and composition_version');
end $migration$;

-- Replace the two direct product REST writers with narrow service-only RPCs.
create function public.mutate_product(p_id uuid,p_operation text,p_changes jsonb default '{}')
returns setof public.products language plpgsql security definer set search_path=''
set default_transaction_isolation='serializable' as $$
declare p public.products; updated public.products;
begin
  perform public.enter_purchase_operation();
  if p_operation='delete' then
    -- Retained offer FKs reject referenced products, atomically including the fence.
    return query delete from public.products where id=p_id returning *;
    return;
  end if;
  if p_operation is distinct from 'edit' or jsonb_typeof(p_changes) is distinct from 'object' or p_changes='{}'::jsonb
    or exists(select 1 from jsonb_object_keys(p_changes) k where k not in
      ('status','name','reference_price','target_type','target_price','target_percent','check_interval_hours'))
    or (p_changes ? 'status' and p_changes-'status'<>'{}'::jsonb) then
    raise exception using errcode='PT400',message='invalid_product_edit';
  end if;
  select * into p from public.products where id=p_id and status<>'pending_confirmation' for update;
  if not found then return; end if;
  updated:=jsonb_populate_record(p,p_changes);
  if updated.status not in ('active','paused','error') or length(btrim(updated.name)) not between 1 and 300
    or updated.reference_price is null or updated.reference_price<=0 or updated.check_interval_hours not in (3,6,12,24)
    or (p_changes ? 'status' and updated.status not in ('active','paused')) then
    raise exception using errcode='PT400',message='invalid_product_edit';
  end if;
  return query update public.products set status=updated.status,name=updated.name,reference_price=updated.reference_price,
    target_type=updated.target_type,target_price=updated.target_price,target_percent=updated.target_percent,
    check_interval_hours=updated.check_interval_hours where id=p_id returning *;
  perform public.invalidate_purchase_inputs(array[p_id]);
end $$;

create function public.record_notification(p_notification jsonb)
returns void language plpgsql security definer set search_path=''
set default_transaction_isolation='serializable' as $$
begin
  perform public.enter_purchase_operation();
  insert into public.notifications(product_id,type,channel,status,payload,error,sent_at)
  values((p_notification->>'product_id')::uuid,p_notification->>'type',p_notification->>'channel',
    p_notification->>'status',p_notification->'payload',p_notification->>'error',
    (p_notification->>'sent_at')::timestamptz);
end $$;

create function public.save_product_alert_state(p_id uuid,p_checked_at timestamptz,p_expected jsonb,p_changes jsonb)
returns setof public.products language plpgsql security definer set search_path=''
set default_transaction_isolation='serializable' as $$
begin
  perform public.enter_purchase_operation();
  if jsonb_typeof(p_changes) is distinct from 'object' or p_changes='{}'::jsonb
    or exists(select 1 from jsonb_object_keys(p_changes) k where k not in ('alert_state','last_alert_price','last_alert_at')) then
    raise exception using errcode='PT400',message='invalid_alert_state';
  end if;
  return query update public.products p set
    alert_state=case when p_changes ? 'alert_state' then p_changes->>'alert_state' else p.alert_state end,
    last_alert_price=case when p_changes ? 'last_alert_price' then (p_changes->>'last_alert_price')::numeric else p.last_alert_price end,
    last_alert_at=case when p_changes ? 'last_alert_at' then (p_changes->>'last_alert_at')::timestamptz else p.last_alert_at end
    where p.id=p_id and p.last_checked_at=p_checked_at and p.status in ('active','error')
    and p.alert_state=p_expected->>'alert_state'
    and p.last_alert_price is not distinct from (p_expected->>'last_alert_price')::numeric
    and p.last_alert_at is not distinct from (p_expected->>'last_alert_at')::timestamptz returning p.*;
end $$;

revoke all on function public.record_notification(jsonb),public.mutate_product(uuid,text,jsonb),public.save_product_alert_state(uuid,timestamptz,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.record_notification(jsonb),public.mutate_product(uuid,text,jsonb),public.save_product_alert_state(uuid,timestamptz,jsonb,jsonb) to service_role;
-- Prevent bypass through direct REST DML, including locks from FK cascades.
revoke insert,update,delete,truncate on public.products,public.price_checks,public.product_readings,
  public.lists,public.basket_items,public.exchange_rates,public.basket_events,public.basket_snapshots,public.notifications from service_role;
-- Trigger helpers are reachable only through the protected mutations.
revoke execute on function public.snapshot_basket_change(),public.snapshot_exchange_rate_change(),public.version_basket_configuration()
  from service_role;
notify pgrst,'reload schema';
commit;
