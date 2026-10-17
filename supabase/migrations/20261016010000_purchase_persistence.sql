begin;
-- Inactive protocol only: no triggers, existing writers, mode changes or scheduler.
create table public.purchase_operation_gate (
    singleton boolean primary key default true check (singleton), fence bigint not null default 0 check (fence >= 0)
);
insert into public.purchase_operation_gate(singleton) values(true);
alter table public.purchase_evaluations
    add column capture jsonb, add column archive jsonb, add column committed_state_revision bigint,
    add constraint purchase_evaluation_archive_complete check (
        (capture is null and archive is null and committed_state_revision is null) or
        (capture is not null and archive is not null and committed_state_revision > 0
         and inputs = archive->'inputs' and result = archive->'result'));
create table public.purchase_runtime (
    list_id uuid primary key references public.lists(id) on delete cascade,
    configuration_version bigint not null, input_revision bigint not null default 0 check(input_revision >= 0),
    state_revision bigint not null default 0 check(state_revision >= 0), dirty boolean not null default true,
    current_evaluation_id uuid, previous_recommendation jsonb not null default '[]', previous_effective jsonb not null default '[]',
    foreign key(list_id,configuration_version) references public.purchase_configurations(list_id,version) on delete cascade,
    foreign key(list_id,configuration_version,current_evaluation_id) references public.purchase_evaluations(list_id,version,id)
);
insert into public.purchase_runtime(list_id,configuration_version)
select l.id,l.composition_version from public.lists l join public.purchase_configurations c on c.list_id=l.id and c.version=l.composition_version;
alter table public.purchase_runtime enable row level security;
alter table public.purchase_operation_gate enable row level security;
revoke all on public.purchase_runtime,public.purchase_operation_gate from public,anon,authenticated,service_role;
grant select on public.purchase_runtime,public.purchase_operation_gate to service_role;

-- JSON-compatible canonical bytes shared with canonicalJson; token numbers are bounded integers.
create function public.purchase_canonical(j jsonb) returns text
language sql immutable strict set search_path = '' as $$
    select case jsonb_typeof(j)
      when 'object' then '{'||coalesce((select string_agg(to_jsonb(key)::text||':'||public.purchase_canonical(value),',' order by key collate "C") from jsonb_each(j)),'')||'}'
      when 'array' then '['||coalesce((select string_agg(public.purchase_canonical(value),',' order by ord) from jsonb_array_elements(j) with ordinality a(value,ord)),'')||']'
      else j::text end
$$;
create function public.purchase_hash(j jsonb) returns text
language sql immutable strict set search_path = '' as $$ select encode(sha256(convert_to(public.purchase_canonical(j),'UTF8')),'hex') $$;

create function public.enter_purchase_operation() returns void
language plpgsql security definer set search_path = '' as $$
begin
    if current_setting('transaction_isolation') <> 'serializable' then
        raise exception using errcode='PT409',message='serializable_required';
    end if;
    -- This must be the first data access of every participating transaction.
    update public.purchase_operation_gate set fence=fence+1 where singleton;
    if not found then raise exception using errcode='PT409',message='purchase_gate_missing'; end if;
end $$;

-- Internal coherent projection. Never expose recipes or notification credentials.
create function public.purchase_source(p_id uuid,p_at timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
with c as (select c.* from public.purchase_configurations c join public.lists l on l.id=c.list_id and l.composition_version=c.version where c.list_id=p_id),
fx as (select * from public.exchange_rates where rate_date <= (p_at at time zone 'America/Lima')::date order by rate_date desc limit 1),
offers as (
 select o.*,p.currency,p.reference_price,p.last_price,p.last_success_at,p.last_checked_at,p.status,p.consecutive_failures,p.last_availability,
    selected.id check_id, to_jsonb(selected) selected_check,to_jsonb(latest) latest_check
 from c join public.purchase_offers o on o.list_id=c.list_id and o.version=c.version join public.products p on p.id=o.product_id
 left join lateral(select x.* from public.price_checks x where x.product_id=p.id and x.ok and x.price=p.last_price and x.checked_at=p.last_success_at order by x.id desc limit 1) selected on true
 left join lateral(select x.* from public.price_checks x where x.product_id=p.id order by x.checked_at desc,x.id desc limit 1) latest on true
), input as (
 select jsonb_build_object('configurationVersion',c.version::text,'currency',c.currency,
 'needs',coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'quantity',n.required_quantity::text,'unit',n.unit,'allowSurplus',n.allow_surplus) order by n.id) from public.purchase_needs n where n.list_id=c.list_id and n.version=c.version),'[]'),
 'offers',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'productId',o.product_id,'currency',o.currency,'price',o.last_price::text,
    'confirmed',coalesce(o.last_price>0 and o.last_success_at is not null and o.status<>'pending_confirmation',false),
    'available',lower(regexp_replace(regexp_replace(coalesce(o.last_availability,''),'^.*[/#]',''),'[[:space:]_-]+','','g')) not in ('outofstock','soldout','discontinued','agotado','agotada','sinstock','nodisponible','oos'),
    'pendingFailure',o.consecutive_failures>0 or o.status='error','suspicious',coalesce(o.latest_check->>'error_code' in ('suspicious_price','price_suspicious'),false),
    'priceCheckId',o.check_id,'lastSuccessAt',o.last_success_at,
    'coverage',coalesce((select jsonb_agg(jsonb_build_object('needId',v.need_id,'quantity',v.quantity::text,'unit',n.unit) order by v.need_id) from public.purchase_coverages v join public.purchase_needs n on (n.list_id,n.version,n.id)=(v.list_id,v.version,v.need_id) where (v.list_id,v.version,v.offer_id)=(o.list_id,o.version,o.id)),'[]'),
    'extras',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'quantity',e.quantity::text,'unit',e.unit,'accepted',e.accepted) order by e.id) from public.purchase_extras e where (e.list_id,e.version,e.offer_id)=(o.list_id,o.version,o.id)),'[]'))
    || case when o.max_purchase_units is null then '{}'::jsonb else jsonb_build_object('maxPurchaseUnits',o.max_purchase_units::text) end order by o.id) from offers o),'[]'),
 'alternatives',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,
    'scope',coalesce((select jsonb_agg(n.need_id order by n.need_id) from public.purchase_alternative_needs n where (n.list_id,n.version,n.alternative_id)=(a.list_id,a.version,a.id)),'[]'),
    'items',coalesce((select jsonb_agg(jsonb_build_object('offerId',i.offer_id,'purchaseUnits',i.purchase_units::text) order by i.offer_id) from public.purchase_alternative_items i where (i.list_id,i.version,i.alternative_id)=(a.list_id,a.version,a.id)),'[]')) order by a.id) from public.purchase_alternatives a where (a.list_id,a.version)=(c.list_id,c.version)),'[]'),
 'pins',coalesce((select jsonb_agg(a.alternative_id order by a.alternative_id) from public.purchase_pins a where (a.list_id,a.version)=(c.list_id,c.version)),'[]'),
 'reference',coalesce((select jsonb_agg(a.alternative_id order by a.alternative_id) from public.purchase_reference_items a where (a.list_id,a.version)=(c.list_id,c.version)),'[]'))
 || case when exists(select 1 from offers where currency<>c.currency) and exists(select 1 from fx) then
    (select jsonb_build_object('fx',jsonb_build_object('multiplier',(case when c.currency='PEN' then rate else 1/rate end)::text,
       'from',case when c.currency='PEN' then 'USD' else 'PEN' end,'to',c.currency,'date',rate_date,'source',source,'fetchedAt',fetched_at)) from fx)
    else '{}'::jsonb end value from c
)
select jsonb_build_object('input',input.value,
 'configuration',to_jsonb(c)-'created_at',
 'products',coalesce((select jsonb_agg(jsonb_build_object('id',product_id,'reference_price',reference_price::text,'last_checked_at',last_checked_at,
    'status',status,'failures',consecutive_failures,'availability',last_availability,'selected_check',selected_check,'latest_check',latest_check) order by id) from offers),'[]'),
 'fx',case when exists(select 1 from offers where currency<>c.currency) then (select to_jsonb(fx) || jsonb_build_object('rate',rate::text) from fx) else null end)
from c cross join input
$$;

create function public.capture_purchase_inputs(p_id uuid,p_version bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.lists; r public.purchase_runtime; at_time timestamptz; source jsonb; token jsonb;
begin
    perform public.enter_purchase_operation();
    select * into l from public.lists where id=p_id for update;
    if not found then raise exception using errcode='PT404',message='basket_not_found'; end if;
    if l.purchase_mode<>'alternatives' or l.composition_version<>p_version then raise exception using errcode='PT409',message='configuration_conflict'; end if;
    select * into r from public.purchase_runtime where list_id=p_id for update;
    if not found or r.configuration_version<>p_version then raise exception using errcode='PT409',message='runtime_conflict'; end if;
    at_time:=clock_timestamp(); source:=public.purchase_source(p_id,at_time);
    token:=jsonb_build_object('token_version',1,'list_id',p_id,'configuration_version',p_version::text,'input_revision',r.input_revision::text,
      'state_revision',r.state_revision::text,'mode',l.purchase_mode,'evaluated_at',at_time,'validity_date',(at_time at time zone 'America/Lima')::date,
      'source_fingerprint',public.purchase_hash(source),'engine_version','purchase-cover-v1','limits',jsonb_build_object('maxNodes',100000,'deadlineMs',2000),
      'previous_recommendation',r.previous_recommendation,'previous_effective',r.previous_effective);
    return jsonb_build_object('capture',token||jsonb_build_object('capture_signature',public.purchase_hash(token)),
      'inputs',(source->'input')||jsonb_build_object('evaluatedAt',at_time,'previousRecommendation',r.previous_recommendation,'previousEffective',r.previous_effective));
end $$;

-- Called after ALL source writes, once per transaction, after gate-first entry.
-- No trigger is installed: existing operational writers intentionally do not participate yet.
create function public.invalidate_purchase_inputs(p_products uuid[],p_fx boolean default false,p_configurations uuid[] default '{}') returns void
language plpgsql security definer set search_path = '' as $$
declare l public.lists; config_changed boolean;
begin
    -- A repeated entry still writes before reads; callers must enter before source work.
    perform public.enter_purchase_operation();
    for l in select x.* from public.lists x where x.id=any(p_configurations) or
        (x.purchase_mode='alternatives' and exists(select 1 from public.purchase_offers o join public.products p on p.id=o.product_id
         where o.list_id=x.id and o.version=x.composition_version and (o.product_id=any(p_products) or (p_fx and p.currency<>x.currency))))
        order by x.id for update loop
      config_changed:=l.id=any(p_configurations);
      insert into public.purchase_runtime(list_id,configuration_version) values(l.id,l.composition_version) on conflict do nothing;
      update public.purchase_runtime set configuration_version=l.composition_version,input_revision=input_revision+1,
        state_revision=state_revision+case when config_changed then 1 else 0 end, dirty=true,current_evaluation_id=null,
        previous_recommendation=case when config_changed then '[]'::jsonb else previous_recommendation end,
        previous_effective=case when config_changed then '[]'::jsonb else previous_effective end where list_id=l.id;
    end loop;
end $$;

-- Only the trusted TS adapter may call this RPC: it performs exact engine replay first.
create function public.commit_purchase_evaluation(p_id uuid,p_version bigint,p_signature text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.lists; r public.purchase_runtime; c jsonb:=p_payload->'capture'; s jsonb:=p_payload->'snapshot'; source jsonb;
    identity text; e public.purchase_evaluations; expected_inputs jsonb; rec jsonb; eff jsonb;
begin
    perform public.enter_purchase_operation();
    select * into l from public.lists where id=p_id for update;
    if not found then raise exception using errcode='PT404',message='basket_not_found'; end if;
    select * into r from public.purchase_runtime where list_id=p_id for update;
    if not found then raise exception using errcode='PT409',message='runtime_conflict'; end if;
    if jsonb_typeof(p_payload)<>'object' or (p_payload-'capture'-'snapshot')<>'{}'::jsonb or c is null or s is null
      or public.purchase_hash(c-'capture_signature') is distinct from p_signature or c->>'capture_signature' is distinct from p_signature
      or c->>'list_id' is distinct from p_id::text or c->>'configuration_version' is distinct from p_version::text
      or s->>'list_id' is distinct from p_id::text or s->>'configuration_version' is distinct from p_version::text
      or c->>'token_version' is distinct from '1' or c->>'engine_version' is distinct from 'purchase-cover-v1'
      or s->>'snapshot_version' is distinct from '1' or s->>'schema_version' is distinct from '2'
      or s->>'engine_version' is distinct from c->>'engine_version' or s->'limits' is distinct from c->'limits'
      or c->'limits' is distinct from '{"maxNodes":100000,"deadlineMs":2000}'::jsonb
      or s->>'evaluated_at' is distinct from c->>'evaluated_at'
      then raise exception using errcode='PT400',message='invalid_purchase_payload'; end if;
    if l.purchase_mode<>'alternatives' or c->>'mode'<>'alternatives' or l.composition_version<>p_version or r.configuration_version<>p_version
      or r.input_revision::text is distinct from c->>'input_revision'
      or c->>'validity_date' is distinct from (clock_timestamp() at time zone 'America/Lima')::date::text
      or c->>'validity_date' is distinct from ((c->>'evaluated_at')::timestamptz at time zone 'America/Lima')::date::text
      then raise exception using errcode='PT409',message='input_conflict'; end if;
    source:=public.purchase_source(p_id,(c->>'evaluated_at')::timestamptz);
    if public.purchase_hash(source) is distinct from c->>'source_fingerprint' then raise exception using errcode='PT409',message='source_conflict'; end if;
    expected_inputs:=(source->'input')||jsonb_build_object('evaluatedAt',c->>'evaluated_at','previousRecommendation',c->'previous_recommendation','previousEffective',c->'previous_effective');
    if s->'inputs' is distinct from expected_inputs then raise exception using errcode='PT400',message='projection_mismatch'; end if;
    identity:=public.purchase_hash(jsonb_build_object('capture_signature',p_signature,'input_signature',s->>'input_signature','engine_version',s->>'engine_version'));
    select * into e from public.purchase_evaluations where list_id=p_id and version=p_version and input_signature=identity and engine_version=s->>'engine_version';
    if found then
      if e.capture is distinct from c or e.archive is distinct from s then raise exception using errcode='PT409',message='evaluation_conflict'; end if;
      if r.current_evaluation_id is distinct from e.id or r.dirty or r.state_revision is distinct from e.committed_state_revision then raise exception using errcode='PT409',message='state_conflict'; end if;
      return jsonb_build_object('disposition','existing','evaluation_id',e.id,'capture',e.capture,'snapshot',e.archive);
    end if;
    if r.state_revision::text is distinct from c->>'state_revision'
      or r.previous_recommendation is distinct from c->'previous_recommendation' or r.previous_effective is distinct from c->'previous_effective'
      then raise exception using errcode='PT409',message='state_conflict'; end if;
    insert into public.purchase_evaluations(list_id,version,evaluated_at,input_signature,engine_version,inputs,result,capture,archive,committed_state_revision)
    values(p_id,p_version,(c->>'evaluated_at')::timestamptz,identity,s->>'engine_version',s->'inputs',s->'result',c,s,r.state_revision+1) returning * into e;
    select coalesce(jsonb_agg(jsonb_build_object('offerId',x->>'offerId','purchaseUnits',x->>'purchaseUnits') order by x->>'offerId'),'[]') into rec from jsonb_array_elements(s#>'{result,recommendation,purchases}') x;
    select coalesce(jsonb_agg(jsonb_build_object('offerId',x->>'offerId','purchaseUnits',x->>'purchaseUnits') order by x->>'offerId'),'[]') into eff from jsonb_array_elements(s#>'{result,effective,purchases}') x;
    update public.purchase_runtime set current_evaluation_id=e.id,dirty=false,state_revision=state_revision+1,
      previous_recommendation=case when s#>'{result,recommendation,coverageComplete}'='true'::jsonb and rec<>'[]'::jsonb then rec else previous_recommendation end,
      previous_effective=case when s#>'{result,effective,coverageComplete}'='true'::jsonb and eff<>'[]'::jsonb then eff else previous_effective end where list_id=p_id;
    return jsonb_build_object('disposition','inserted','evaluation_id',e.id,'capture',c,'snapshot',s);
end $$;

create function public.read_current_purchase_evaluation(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
select case when l.purchase_mode='alternatives' and not r.dirty and r.configuration_version=l.composition_version
 and e.version=r.configuration_version and e.capture->>'input_revision'=r.input_revision::text and e.committed_state_revision=r.state_revision
 and e.capture->>'validity_date'=(statement_timestamp() at time zone 'America/Lima')::date::text
 then jsonb_build_object('evaluation_id',e.id,'capture',e.capture,'snapshot',e.archive,'stale_reason',null)
 else jsonb_build_object('evaluation_id',null,'capture',null,'snapshot',null,'stale_reason',
   case when l.purchase_mode<>'alternatives' then 'mode' when r.dirty then 'dirty' when e.id is null then 'missing' when e.capture->>'validity_date'<>(statement_timestamp() at time zone 'America/Lima')::date::text then 'date' else 'revision' end) end
from public.lists l left join public.purchase_runtime r on r.list_id=l.id
left join public.purchase_evaluations e on (e.list_id,e.version,e.id)=(r.list_id,r.configuration_version,r.current_evaluation_id) where l.id=p_id
$$;

-- Freeze history against accidental service writes; parent deletion still cascades.
create function public.reject_purchase_evaluation_update() returns trigger language plpgsql set search_path = '' as $$
begin raise exception using errcode='PT409',message='immutable_purchase_evaluation'; end $$;
create trigger purchase_evaluation_immutable before update on public.purchase_evaluations for each row execute function public.reject_purchase_evaluation_update();

-- No client RPC access, including helper functions. Only the explicit trusted entry points are executable.
do $$ declare f record; begin
 for f in select p.oid::regprocedure identity from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and
 (p.proname in ('enter_purchase_operation','capture_purchase_inputs','invalidate_purchase_inputs','commit_purchase_evaluation','read_current_purchase_evaluation','reject_purchase_evaluation_update','purchase_source','purchase_hash','purchase_canonical')) loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f.identity);
 end loop;
end $$;
grant execute on function public.enter_purchase_operation(),public.capture_purchase_inputs(uuid,bigint),
 public.invalidate_purchase_inputs(uuid[],boolean,uuid[]),public.commit_purchase_evaluation(uuid,bigint,text,jsonb),public.read_current_purchase_evaluation(uuid) to service_role;
commit;
