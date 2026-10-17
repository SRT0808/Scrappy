begin;
-- Staged local RPC only. A separate activation task must enable v2 consumers/mode.
create schema purchase_publication_internal;
revoke all on schema purchase_publication_internal from public,anon,authenticated,service_role;
create table purchase_publication_internal.publications(list_id uuid, version bigint, primary key(list_id,version));

create function purchase_publication_internal.fields(j jsonb, names text) returns void
language plpgsql set search_path='' as $$
begin
  if jsonb_typeof(j) is distinct from 'object' or
    (select array_agg(k order by k) from jsonb_object_keys(j) k) is distinct from
    (select array_agg(k order by k) from unnest(string_to_array(names,' ')) k) then
    raise exception using errcode='PT400',message='invalid_configuration_fields';
  end if;
end $$;

create function purchase_publication_internal.amount(j jsonb, kind text) returns numeric
language plpgsql immutable set search_path='' as $$
declare n numeric; digits integer;
begin
  digits:=case when kind='money' then 2 when kind='scaled' then 9 else 6 end;
  if jsonb_typeof(j) is distinct from 'string' or length(j#>>'{}')>32 or
    (j#>>'{}') !~ ('^[0-9]+(\.[0-9]{1,'||digits||'})?$') then
    raise exception using errcode='PT400',message='invalid_decimal';
  end if;
  n:=(j#>>'{}')::numeric;
  if n<0 or n>=(case when kind='money' then 10000000000::numeric else 1000000000000000000::numeric end) then
    raise exception using errcode='PT400',message='decimal_limit';
  end if;
  return n;
end $$;

create function purchase_publication_internal.quantity(j jsonb, u text) returns numeric
language plpgsql immutable set search_path='' as $$
declare n numeric;
begin
  n:=purchase_publication_internal.amount(j,case when u in ('L','kg') then 'scaled' else 'quantity' end)*case when u in ('L','kg') then 1000 else 1 end;
  if u is null or u not in ('ml','g','unit','L','kg') or n<=0 or n>=1000000000000000000::numeric
    or n<>trunc(n,6) or (u='unit' and n<>trunc(n)) then raise exception using errcode='PT400',message='invalid_quantity'; end if;
  return n;
end $$;

create function public.save_purchase_configuration(p_id uuid,p_expected_version bigint,p_configuration jsonb) returns jsonb
language plpgsql security definer set search_path='' set default_transaction_isolation='serializable' as $$
declare l public.lists; v bigint; j jsonb; o jsonb; x jsonb; a jsonb; uid uuid; unit_name text;
  canonical jsonb; budget_value numeric; minimum_value numeric; ids jsonb; key_name text;
begin
  -- First database operation, including malformed/missing-list calls.
  perform public.enter_purchase_operation();
  select * into l from public.lists where id=p_id for update;
  if not found then raise exception using errcode='PT404',message='basket_not_found'; end if;
  if l.purchase_mode<>'alternatives' or p_expected_version is distinct from l.composition_version then
    raise exception using errcode='PT409',message='configuration_conflict';
  end if;
  perform purchase_publication_internal.fields(p_configuration,
    'schema_version currency budget budget_enabled winner_enabled minimum_savings needs offers alternatives pins reference');
  if octet_length(p_configuration::text)>262144 then raise exception using errcode='PT400',message='configuration_bytes_limit'; end if;
  if p_configuration->'schema_version' is distinct from '2'::jsonb or
    jsonb_typeof(p_configuration->'currency') is distinct from 'string' or p_configuration->>'currency' not in ('PEN','USD') or
    jsonb_typeof(p_configuration->'budget_enabled') is distinct from 'boolean' or
    jsonb_typeof(p_configuration->'winner_enabled') is distinct from 'boolean' then
    raise exception using errcode='PT400',message='invalid_configuration_settings';
  end if;
  foreach key_name in array array['needs','offers','alternatives','pins','reference'] loop
    if jsonb_typeof(p_configuration->key_name) is distinct from 'array' then
      raise exception using errcode='PT400',message='invalid_configuration_array'; end if;
  end loop;
  if jsonb_array_length(p_configuration->'needs')>32 or jsonb_array_length(p_configuration->'offers')>64 or
    jsonb_array_length(p_configuration->'alternatives')>128 or jsonb_array_length(p_configuration->'pins')>128 or
    jsonb_array_length(p_configuration->'reference')>128 then
    raise exception using errcode='PT400',message='configuration_limit'; end if;
  budget_value:=case when p_configuration->'budget'='null'::jsonb then null else purchase_publication_internal.amount(p_configuration->'budget','money') end;
  minimum_value:=purchase_publication_internal.amount(p_configuration->'minimum_savings','money');
  v:=l.composition_version+1;
  -- Parent first; the canonical projection is replaced before commit and never caller-controlled.
  insert into public.purchase_configurations(list_id,version,configuration,currency,budget,budget_enabled,winner_enabled,minimum_savings)
    values(p_id,v,'{}',p_configuration->>'currency',budget_value,(p_configuration->>'budget_enabled')::boolean,
      (p_configuration->>'winner_enabled')::boolean,minimum_value);
  for j in select value from jsonb_array_elements(p_configuration->'needs') loop
    perform purchase_publication_internal.fields(j,'id name required_quantity unit position allow_surplus');
    if jsonb_typeof(j->'id')<>'string' or jsonb_typeof(j->'name')<>'string' or jsonb_typeof(j->'unit')<>'string' or
      jsonb_typeof(j->'position')<>'number' or (j->>'position') !~ '^[0-9]+$' or jsonb_typeof(j->'allow_surplus')<>'boolean' then
      raise exception using errcode='PT400',message='invalid_need'; end if;
    uid:=(j->>'id')::uuid; unit_name:=j->>'unit';
    insert into public.purchase_needs
      values(p_id,v,uid,j->>'name',purchase_publication_internal.quantity(j->'required_quantity',unit_name),
        case unit_name when 'L' then 'ml' when 'kg' then 'g' else unit_name end,(j->>'position')::integer,(j->>'allow_surplus')::boolean,
        (select legacy_item_id from public.purchase_needs where list_id=p_id and version=p_expected_version and id=uid),
        coalesce((select created_at from public.purchase_needs where list_id=p_id and version=p_expected_version and id=uid),statement_timestamp()));
  end loop;
  for o in select value from jsonb_array_elements(p_configuration->'offers') loop
    perform purchase_publication_internal.fields(o,'id product_id max_purchase_units coverage extras');
    if jsonb_typeof(o->'id')<>'string' or jsonb_typeof(o->'product_id')<>'string' or
      (o->'max_purchase_units'<>'null'::jsonb and (jsonb_typeof(o->'max_purchase_units')<>'number' or (o->>'max_purchase_units') !~ '^[1-9][0-9]*$')) or
      jsonb_typeof(o->'coverage')<>'array' or jsonb_typeof(o->'extras')<>'array' then
      raise exception using errcode='PT400',message='invalid_offer'; end if;
    if jsonb_array_length(o->'coverage')>32 or jsonb_array_length(o->'extras')>32 then raise exception using errcode='PT400',message='configuration_limit'; end if;
    uid:=(o->>'id')::uuid;
    insert into public.purchase_offers values(p_id,v,uid,(o->>'product_id')::uuid,(o->>'max_purchase_units')::integer);
    for x in select value from jsonb_array_elements(o->'coverage') loop
      perform purchase_publication_internal.fields(x,'need_id quantity');
      if jsonb_typeof(x->'need_id')<>'string' then raise exception using errcode='PT400',message='invalid_coverage'; end if;
      select unit into unit_name from public.purchase_needs where list_id=p_id and version=v and id=(x->>'need_id')::uuid;
      insert into public.purchase_coverages values(p_id,v,uid,(x->>'need_id')::uuid,purchase_publication_internal.quantity(x->'quantity',unit_name));
    end loop;
    for x in select value from jsonb_array_elements(o->'extras') loop
      perform purchase_publication_internal.fields(x,'id name quantity unit accepted');
      if jsonb_typeof(x->'id')<>'string' or jsonb_typeof(x->'name')<>'string' or jsonb_typeof(x->'unit')<>'string' or jsonb_typeof(x->'accepted')<>'boolean' then
        raise exception using errcode='PT400',message='invalid_extra'; end if;
      unit_name:=x->>'unit';
      insert into public.purchase_extras values(p_id,v,(x->>'id')::uuid,uid,x->>'name',purchase_publication_internal.quantity(x->'quantity',unit_name),
        case unit_name when 'L' then 'ml' when 'kg' then 'g' else unit_name end,(x->>'accepted')::boolean);
    end loop;
  end loop;
  for a in select value from jsonb_array_elements(p_configuration->'alternatives') loop
    perform purchase_publication_internal.fields(a,'id name position scope items');
    if jsonb_typeof(a->'id')<>'string' or jsonb_typeof(a->'name')<>'string' or jsonb_typeof(a->'position')<>'number' or (a->>'position') !~ '^[0-9]+$' or
      jsonb_typeof(a->'scope')<>'array' or jsonb_typeof(a->'items')<>'array' then raise exception using errcode='PT400',message='invalid_alternative'; end if;
    if jsonb_array_length(a->'scope') not between 1 and 32 or jsonb_array_length(a->'items') not between 1 and 32 then
      raise exception using errcode='PT400',message='invalid_alternative_size'; end if;
    uid:=(a->>'id')::uuid;
    insert into public.purchase_alternatives values(p_id,v,uid,a->>'name',(a->>'position')::integer);
    for x in select value from jsonb_array_elements(a->'scope') loop
      if jsonb_typeof(x)<>'string' then raise exception using errcode='PT400',message='invalid_scope'; end if;
      insert into public.purchase_alternative_needs values(p_id,v,uid,(x#>>'{}')::uuid);
    end loop;
    for x in select value from jsonb_array_elements(a->'items') loop
      perform purchase_publication_internal.fields(x,'offer_id purchase_units');
      if jsonb_typeof(x->'offer_id')<>'string' or jsonb_typeof(x->'purchase_units')<>'number' or (x->>'purchase_units') !~ '^[1-9][0-9]*$' then
        raise exception using errcode='PT400',message='invalid_items'; end if;
      insert into public.purchase_alternative_items values(p_id,v,uid,(x->>'offer_id')::uuid,(x->>'purchase_units')::integer);
    end loop;
  end loop;
  -- Validate declared recipes independently of price/availability. Draft offers may be unused.
  if exists(select 1 from public.purchase_alternative_items i join public.purchase_extras e using(list_id,version,offer_id)
      where i.list_id=p_id and i.version=v and not e.accepted) or
    exists(select 1 from public.purchase_alternative_items i join public.purchase_coverages c using(list_id,version,offer_id)
      where i.list_id=p_id and i.version=v and not exists(select 1 from public.purchase_alternative_needs s
        where (s.list_id,s.version,s.alternative_id,s.need_id)=(i.list_id,i.version,i.alternative_id,c.need_id))) or
    exists(select 1 from public.purchase_alternative_needs s join public.purchase_needs n on (n.list_id,n.version,n.id)=(s.list_id,s.version,s.need_id)
      cross join lateral (select coalesce(sum(c.quantity*i.purchase_units::numeric),0) qty from public.purchase_alternative_items i
        join public.purchase_coverages c using(list_id,version,offer_id) where (i.list_id,i.version,i.alternative_id,c.need_id)=(s.list_id,s.version,s.alternative_id,s.need_id)) q
      where s.list_id=p_id and s.version=v and (q.qty<n.required_quantity or (q.qty>n.required_quantity and not n.allow_surplus))) or
    exists(select 1 from public.purchase_alternative_items i join public.purchase_offers o on (o.list_id,o.version,o.id)=(i.list_id,i.version,i.offer_id)
      where i.list_id=p_id and i.version=v and i.purchase_units>o.max_purchase_units) then
    raise exception using errcode='PT400',message='invalid_alternative_coverage';
  end if;
  foreach key_name in array array['pins','reference'] loop
    ids:=p_configuration->key_name;
    for x in select value from jsonb_array_elements(ids) loop
      if jsonb_typeof(x)<>'string' then raise exception using errcode='PT400',message='invalid_selection'; end if;
      if key_name='pins' then insert into public.purchase_pins values(p_id,v,(x#>>'{}')::uuid);
      else insert into public.purchase_reference_items values(p_id,v,(x#>>'{}')::uuid); end if;
    end loop;
    if exists(select 1 from public.purchase_alternative_needs s where s.list_id=p_id and s.version=v and s.alternative_id in
        (select (value#>>'{}')::uuid from jsonb_array_elements(ids)) group by s.need_id having count(*)>1) or
      exists(select 1 from public.purchase_alternative_items i join public.purchase_offers o on (o.list_id,o.version,o.id)=(i.list_id,i.version,i.offer_id)
        where i.list_id=p_id and i.version=v and i.alternative_id in (select (value#>>'{}')::uuid from jsonb_array_elements(ids))
        group by i.offer_id,o.max_purchase_units having sum(i.purchase_units::numeric)>coalesce(o.max_purchase_units,2147483647)) then
      raise exception using errcode='PT400',message='incompatible_selection'; end if;
  end loop;
  select jsonb_build_object('schema_version',2,'version',v::text,'currency',c.currency,'budget',c.budget::text,
    'budget_enabled',c.budget_enabled,'winner_enabled',c.winner_enabled,'minimum_savings',c.minimum_savings::text,
    'needs',coalesce((select jsonb_agg((to_jsonb(n)-'list_id'-'version')||jsonb_build_object('required_quantity',n.required_quantity::text) order by n.position,n.id)
      from public.purchase_needs n where n.list_id=p_id and n.version=v),'[]'::jsonb),
    'offers',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'product_id',o.product_id,'max_purchase_units',o.max_purchase_units,
      'coverage',coalesce((select jsonb_agg(jsonb_build_object('need_id',s.need_id,'quantity',s.quantity::text) order by s.need_id) from public.purchase_coverages s where (s.list_id,s.version,s.offer_id)=(p_id,v,o.id)),'[]'::jsonb),
      'extras',coalesce((select jsonb_agg((to_jsonb(e)-'list_id'-'version'-'offer_id')||jsonb_build_object('quantity',e.quantity::text) order by e.id) from public.purchase_extras e where (e.list_id,e.version,e.offer_id)=(p_id,v,o.id)),'[]'::jsonb)) order by o.id)
      from public.purchase_offers o where o.list_id=p_id and o.version=v),'[]'::jsonb),
    'alternatives',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'position',a.position,
      'scope',(select jsonb_agg(s.need_id order by s.need_id) from public.purchase_alternative_needs s where (s.list_id,s.version,s.alternative_id)=(p_id,v,a.id)),
      'items',(select jsonb_agg(jsonb_build_object('offer_id',i.offer_id,'purchase_units',i.purchase_units) order by i.offer_id) from public.purchase_alternative_items i where (i.list_id,i.version,i.alternative_id)=(p_id,v,a.id))) order by a.position,a.id)
      from public.purchase_alternatives a where a.list_id=p_id and a.version=v),'[]'::jsonb),
    'pins',coalesce((select jsonb_agg(alternative_id order by alternative_id) from public.purchase_pins where list_id=p_id and version=v),'[]'::jsonb),
    'reference',coalesce((select jsonb_agg(alternative_id order by alternative_id) from public.purchase_reference_items where list_id=p_id and version=v),'[]'::jsonb))
    into canonical from public.purchase_configurations c where c.list_id=p_id and c.version=v;
  update public.purchase_configurations set configuration=canonical where list_id=p_id and version=v;
  insert into public.purchase_alert_state(list_id,version,budget_reached,budget_epoch) values(p_id,v,false,l.basket_alert_epoch+1);
  update public.lists set composition_version=v,currency=p_configuration->>'currency',budget=budget_value,
    basket_reached=false,basket_alert_epoch=basket_alert_epoch+1 where id=p_id;
  perform public.invalidate_purchase_inputs('{}',false,array[p_id]);
  insert into purchase_publication_internal.publications values(p_id,v);
  return canonical;
exception when integrity_constraint_violation or data_exception then
  raise exception using errcode='PT400',message='invalid_configuration_graph';
end $$;

revoke all on all functions in schema purchase_publication_internal from public,anon,authenticated,service_role;
revoke all on function public.save_purchase_configuration(uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.save_purchase_configuration(uuid,bigint,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
