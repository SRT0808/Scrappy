begin;

-- Offers retain their individual targets unchanged; membership temporarily masks
-- goal delivery. Dissolution therefore restores goals without copying values.
create table public.product_groups (
 id uuid primary key, name text not null check(length(btrim(name)) between 1 and 300),
 currency text not null check(currency ~ '^[A-Z]{3}$'), image_product_id uuid,
 reference_price numeric(12,2) not null check(reference_price>0),
 target_type text not null check(target_type in ('price','percent')),
 target_value numeric(12,2) not null check(target_value>=0),
 paused boolean not null default false, dissolved boolean not null default false,
 version bigint not null default 1, alert_state text not null default 'armed',
 last_alert_price numeric, created_at timestamptz not null default now(),
 check(alert_state in ('armed','triggered')),
 check(target_type<>'percent' or target_value>0 and target_value<=100)
);
create table public.product_group_members (
 product_id uuid primary key references public.products(id) on delete cascade,
 group_id uuid not null references public.product_groups(id),
 added_at timestamptz not null default now()
);
create index product_group_members_group on public.product_group_members(group_id);
-- Serialize membership changes with individual deliveries already authorized.
-- An expired claim is ambiguous: never let its late receipt modify restored goals.
create table public.product_goal_deliveries (
 product_id uuid primary key references public.products(id) on delete cascade,
 token uuid not null, expires_at timestamptz not null
);
alter table public.product_goal_deliveries enable row level security;
revoke all on public.product_goal_deliveries from public,anon,authenticated,service_role;

create function public.begin_product_goal_delivery(p_id uuid,p_checked_at timestamptz)
returns uuid language plpgsql security definer set search_path=''
set default_transaction_isolation='serializable' as $$
declare token uuid:=gen_random_uuid();
begin
 perform public.enter_purchase_operation(); perform pg_advisory_xact_lock(220026);
 if exists(select 1 from public.product_group_members where product_id=p_id)
   or not exists(select 1 from public.products where id=p_id and last_checked_at=p_checked_at and status in ('active','error'))
   or exists(select 1 from public.product_goal_deliveries where product_id=p_id and expires_at>clock_timestamp()) then
   return null;
 end if;
 insert into public.product_goal_deliveries values(p_id,token,clock_timestamp()+interval '5 minutes')
 on conflict(product_id) do update set token=excluded.token,expires_at=excluded.expires_at;
 return token;
end $$;
create function public.finish_product_goal_delivery(p_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path=''
set default_transaction_isolation='serializable' as $$
begin
 perform public.enter_purchase_operation();
 delete from public.product_goal_deliveries where product_id=p_id and token=p_token;
end $$;

alter function public.save_product_alert_state(uuid,timestamptz,jsonb,jsonb) rename to save_ungrouped_alert_state;
revoke all on function public.save_ungrouped_alert_state(uuid,timestamptz,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.save_product_alert_state(p_id uuid,p_checked_at timestamptz,p_expected jsonb,p_changes jsonb)
returns setof public.products language plpgsql security definer set search_path=''
set default_transaction_isolation='serializable' as $$
begin
 perform public.enter_purchase_operation(); perform pg_advisory_xact_lock(220026);
 if exists(select 1 from public.product_group_members where product_id=p_id) then return; end if;
 return query select * from public.save_ungrouped_alert_state(p_id,p_checked_at,p_expected,p_changes);
end $$;
create function public.complete_product_goal_delivery(p_id uuid,p_checked_at timestamptz,p_expected jsonb,p_changes jsonb,p_token uuid)
returns setof public.products language plpgsql security definer set search_path=''
set default_transaction_isolation='serializable' as $$
begin
 perform public.enter_purchase_operation(); perform pg_advisory_xact_lock(220026);
 if not exists(select 1 from public.product_goal_deliveries where product_id=p_id and token=p_token and expires_at>clock_timestamp()) then return; end if;
 return query select * from public.save_product_alert_state(p_id,p_checked_at,p_expected,p_changes);
end $$;
create table public.product_group_events (
 id uuid primary key default gen_random_uuid(), group_id uuid not null references public.product_groups(id),
 version bigint not null, kind text not null check(kind in ('goal_reached','dropped_further')),
 status text not null default 'claimed' check(status in ('claimed','sent','failed')),
 snapshot jsonb not null, created_at timestamptz not null default now()
);
alter table public.product_groups enable row level security;
alter table public.product_group_members enable row level security;
alter table public.product_group_events enable row level security;
revoke all on public.product_groups,public.product_group_members,public.product_group_events from public,anon,authenticated,service_role;
grant select on public.product_groups,public.product_group_members,public.product_group_events to service_role;

create function public.product_group_target(g public.product_groups) returns numeric
language sql immutable set search_path='' as $$
 select case when g.target_type='percent' then g.reference_price*(1-g.target_value/100) else g.target_value end
$$;

create function public.product_group_offer(p public.products) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',p.id,'name',coalesce(p.name,p.domain),'domain',p.domain,'url',p.url,
 'image_url',p.image_url,'currency',p.currency,'reference_price',p.reference_price,
 'target_type',p.target_type,'target_value',case when p.target_type='percent' then p.target_percent else p.target_price end,
 'price',p.last_price,'checked_at',p.last_checked_at,'status',p.status,'interval',p.check_interval_hours,
 'excluded',case when p.status='paused' then 'Revisiones pausadas'
 when p.status='pending_confirmation' or p.last_price is null or p.last_success_at is null then 'Sin precio confirmado'
 when p.consecutive_failures>0 or p.status='error' or p.last_checked_at is distinct from p.last_success_at
   then 'Lectura fallida o precio no confirmado'
 when p.last_success_at < statement_timestamp()-make_interval(hours=>p.check_interval_hours*2) then 'Precio desactualizado'
 when lower(regexp_replace(regexp_replace(coalesce(p.last_availability,''),'^.*[/#]',''),'[[:space:]_-]+','','g'))
   in ('outofstock','soldout','discontinued','agotado','agotada','sinstock','nodisponible','oos') then 'Agotado'
 when p.last_price<=0 then 'Sin precio válido' else null end)
$$;

create function public.read_product_groups(p_id uuid default null,p_history boolean default false)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(g)||jsonb_build_object('target',public.product_group_target(g),
 'offers',coalesce((select jsonb_agg(public.product_group_offer(p)||
 jsonb_build_object('history',case when p_history then coalesce((select jsonb_agg(
 jsonb_build_object('time',c.checked_at,'price',case when c.ok and c.currency=p.currency then c.price else null end)
 order by c.checked_at,c.id) from public.price_checks c where c.product_id=p.id),'[]'::jsonb) else '[]'::jsonb end)
 order by p.domain,p.id) from public.product_group_members m join public.products p on p.id=m.product_id where m.group_id=g.id),'[]'::jsonb),
 'events',case when p_history then coalesce((select jsonb_agg(e) from (select id,kind,status,snapshot,created_at
 from public.product_group_events where group_id=g.id order by created_at desc,id desc)e),'[]'::jsonb) else '[]'::jsonb end
 ) order by g.created_at desc,g.id),'[]'::jsonb)
 from public.product_groups g where (p_id is null and not g.dissolved) or g.id=p_id
$$;

create function public.mutate_product_group(p_id uuid,p_version bigint,p_action text,p_body jsonb)
returns jsonb language plpgsql security definer set search_path=''
set default_transaction_isolation='serializable' as $$
declare g public.product_groups; old_target numeric; ids uuid[]; n integer; c text; p public.products;
begin
 perform public.enter_purchase_operation();
 -- One lock order for membership, edits and claims. No DML grants permit bypass.
 perform pg_advisory_xact_lock(220026);
 if p_id is null or p_body is null or jsonb_typeof(p_body)<>'object' then
   raise sqlstate 'PT400' using message='invalid_group'; end if;
 if p_action='create' then
   if exists(select 1 from public.product_groups where id=p_id) then
     raise sqlstate 'PT409' using message='group_exists'; end if;
   if p_body->>'same_product' is distinct from 'true' then raise sqlstate 'PT400' using message='confirm_identity'; end if;
   select array_agg(value::uuid order by value) into ids from jsonb_array_elements_text(p_body->'product_ids');
   n:=cardinality(ids);
   if n is null or n<2 or n>50 or n<>(select count(distinct x) from unnest(ids)x) then
     raise sqlstate 'PT400' using message='invalid_members'; end if;
   perform 1 from public.products where id=any(ids) order by id for update;
   if exists(select 1 from public.product_goal_deliveries where product_id=any(ids) and expires_at>clock_timestamp()) then
     raise sqlstate 'PT409' using message='individual_notice_in_flight'; end if;
   if (select count(*) from public.products where id=any(ids) and status<>'pending_confirmation'
     and currency is not null and target_type is not null)<>n
     or exists(select 1 from public.product_group_members where product_id=any(ids)) then
     raise sqlstate 'PT409' using message='invalid_membership'; end if;
   select min(currency) into c from public.products where id=any(ids);
   if (select count(distinct currency) from public.products where id=any(ids))<>1 then
     raise sqlstate 'PT400' using message='currency_mismatch'; end if;
   insert into public.product_groups(id,name,currency,reference_price,target_type,target_value,image_product_id)
   values(p_id,btrim(p_body->>'name'),c,(p_body->>'reference_price')::numeric,p_body->>'target_type',
    (p_body->>'target_value')::numeric,(p_body->>'image_product_id')::uuid) returning * into g;
   insert into public.product_group_members(product_id,group_id) select x,p_id from unnest(ids)x;
 else
   select * into g from public.product_groups where id=p_id and not dissolved for update;
   if not found then raise sqlstate 'PT404' using message='group_not_found'; end if;
   if p_version is distinct from g.version then raise sqlstate 'PT409' using message='group_changed'; end if;
   old_target:=public.product_group_target(g);
   if p_action='edit' then
     if not exists(select 1 from public.product_group_members where group_id=p_id and product_id=(p_body->>'image_product_id')::uuid) then
       raise sqlstate 'PT400' using message='invalid_group_image'; end if;
     update public.product_groups set name=btrim(p_body->>'name'), reference_price=(p_body->>'reference_price')::numeric,
      target_type=p_body->>'target_type',target_value=(p_body->>'target_value')::numeric,
      image_product_id=(p_body->>'image_product_id')::uuid where id=p_id returning * into g;
     if old_target is distinct from public.product_group_target(g) then
       update public.product_groups set alert_state='armed',last_alert_price=null where id=p_id;
     end if;
   elsif p_action='pause' then
     if jsonb_typeof(p_body->'paused') is distinct from 'boolean' then raise sqlstate 'PT400' using message='invalid_pause'; end if;
     update public.product_groups set paused=(p_body->>'paused')::boolean where id=p_id;
   elsif p_action='add' then
     if p_body->>'same_product' is distinct from 'true' then raise sqlstate 'PT400' using message='confirm_identity'; end if;
     select * into p from public.products where id=(p_body->>'product_id')::uuid for update;
     if exists(select 1 from public.product_goal_deliveries where product_id=p.id and expires_at>clock_timestamp()) then
       raise sqlstate 'PT409' using message='individual_notice_in_flight'; end if;
     if not found or p.status='pending_confirmation' or p.currency is distinct from g.currency
       or p.target_type is null then raise sqlstate 'PT400' using message='invalid_offer'; end if;
     if exists(select 1 from public.product_group_members where product_id=p.id)
       or (select count(*) from public.product_group_members where group_id=p_id)>=50 then
       raise sqlstate 'PT409' using message='offer_already_grouped'; end if;
     insert into public.product_group_members values(p.id,p_id,now());
     update public.product_groups set alert_state='armed',last_alert_price=null where id=p_id;
   elsif p_action='remove' then
     delete from public.product_group_members where group_id=p_id and product_id=(p_body->>'product_id')::uuid;
     if not found then raise sqlstate 'PT404' using message='offer_not_found'; end if;
   elsif p_action='dissolve' then
     delete from public.product_group_members where group_id=p_id;
   else raise sqlstate 'PT400' using message='invalid_action'; end if;
   update public.product_groups set version=version+1 where id=p_id returning * into g;
 end if;
 if (select count(*) from public.product_group_members where group_id=p_id)<2 then
   delete from public.product_group_members where group_id=p_id;
   update public.product_groups set dissolved=true where id=p_id;
 else
   if not exists(select 1 from public.product_group_members where group_id=p_id and product_id=g.image_product_id) then
     update public.product_groups set image_product_id=(select min(product_id::text)::uuid
       from public.product_group_members where group_id=p_id) where id=p_id;
   end if;
 end if;
 return public.read_product_groups(p_id,true)->0;
exception when unique_violation then raise sqlstate 'PT409' using message='membership_conflict';
 when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range then
 raise sqlstate 'PT400' using message='invalid_group';
end $$;

-- Grouped goals are immutable at the offer editor. Originals and alert state stay
-- untouched, including when the group is paused. Other offer edits still work.
create function public.guard_grouped_offer() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (old.reference_price,old.target_type,old.target_price,old.target_percent) is distinct from
    (new.reference_price,new.target_type,new.target_price,new.target_percent)
   and exists(select 1 from public.product_group_members where product_id=old.id) then
   raise sqlstate 'PT409' using message='edit_shared_goal_in_group'; end if;
 return new;
end $$;
create trigger guard_grouped_offer before update on public.products for each row execute function public.guard_grouped_offer();

create function public.group_after_offer_delete() returns trigger language plpgsql security definer set search_path='' as $$
begin
 -- Removing an offer must be explicit through the group before deleting it.
 if exists(select 1 from public.product_group_members where product_id=old.id) then
   raise sqlstate 'PT409' using message='remove_offer_from_group_first'; end if;
 return old;
end $$;
create trigger group_before_offer_delete before delete on public.products for each row execute function public.group_after_offer_delete();

create function public.claim_product_group_events() returns setof public.product_group_events
language plpgsql security definer set search_path='' set default_transaction_isolation='serializable' as $$
declare g public.product_groups; offer jsonb; kind text; e public.product_group_events; price numeric; excluded integer;
begin
 perform public.enter_purchase_operation(); perform pg_advisory_xact_lock(220026);
 for g in select * from public.product_groups where not dissolved and not paused order by id for update loop
   select x into offer from (select public.product_group_offer(p) x from public.product_group_members m
    join public.products p on p.id=m.product_id where m.group_id=g.id)s
    where x->>'excluded' is null order by (x->>'price')::numeric,x->>'id' limit 1;
   if offer is null then continue; end if;
   price:=(offer->>'price')::numeric; kind:=null;
   if price>public.product_group_target(g)*1.03 then
     update public.product_groups set alert_state='armed' where id=g.id;
   elsif price<=public.product_group_target(g) then
     if g.alert_state='armed' then kind:='goal_reached';
     elsif price<=g.last_alert_price*0.95 then kind:='dropped_further'; end if;
   end if;
   if kind is null then continue; end if;
   select count(*) into excluded from public.product_group_members m join public.products p on p.id=m.product_id
    where m.group_id=g.id and public.product_group_offer(p)->>'excluded' is not null;
   insert into public.product_group_events(group_id,version,kind,snapshot)
    values(g.id,g.version,kind,jsonb_build_object('name',g.name,'currency',g.currency,'target',public.product_group_target(g),
     'price',price,'offer',offer,'excluded',excluded)) returning * into e;
   -- Advance at claim time: a lost receipt is ambiguous and is never replayed.
   update public.product_groups set alert_state='triggered',last_alert_price=price where id=g.id;
   return next e;
 end loop;
end $$;
create function public.finish_product_group_event(p_id uuid,p_sent boolean) returns void
language plpgsql security definer set search_path='' set default_transaction_isolation='serializable' as $$
begin
 perform public.enter_purchase_operation();
 if p_sent is null then raise sqlstate 'PT400' using message='missing_receipt'; end if;
 update public.product_group_events set status=case when p_sent then 'sent' else 'failed' end where id=p_id and status='claimed';
 if not found then raise sqlstate 'PT409' using message='event_finished'; end if;
end $$;

revoke all on function public.product_group_target(public.product_groups),public.product_group_offer(public.products),
 public.begin_product_goal_delivery(uuid,timestamptz),public.finish_product_goal_delivery(uuid,uuid),
 public.save_product_alert_state(uuid,timestamptz,jsonb,jsonb),public.complete_product_goal_delivery(uuid,timestamptz,jsonb,jsonb,uuid),
 public.guard_grouped_offer(),public.group_after_offer_delete(),public.read_product_groups(uuid,boolean),
 public.mutate_product_group(uuid,bigint,text,jsonb),public.claim_product_group_events(),public.finish_product_group_event(uuid,boolean)
 from public,anon,authenticated,service_role;
grant execute on function public.read_product_groups(uuid,boolean),public.mutate_product_group(uuid,bigint,text,jsonb),
 public.begin_product_goal_delivery(uuid,timestamptz),public.finish_product_goal_delivery(uuid,uuid),
 public.save_product_alert_state(uuid,timestamptz,jsonb,jsonb),public.complete_product_goal_delivery(uuid,timestamptz,jsonb,jsonb,uuid),
 public.claim_product_group_events(),public.finish_product_group_event(uuid,boolean) to service_role;
notify pgrst,'reload schema';
commit;
