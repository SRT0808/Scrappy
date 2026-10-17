do $$ declare r record; actual jsonb; role_name text; t text; begin
for r in select * from shadow_original loop
execute format('select coalesce(jsonb_agg(to_jsonb(t) %s order by (to_jsonb(t) %s)::text), ''[]''::jsonb) from public.%I t',
case when r.name='lists' then '- ''purchase_mode''' else '' end,
case when r.name='lists' then '- ''purchase_mode''' else '' end,r.name) into actual;
if actual is distinct from r.rows then raise exception 'Conservation failed: %',r.name; end if;
end loop;
if exists(select 1 from shadow_summary s where summary is distinct from public.basket_summary_at(s.id,'2026-10-16 12:00Z'))
or (select jsonb_agg(entry #- '{basket,calculated_at}' order by ord)
    from jsonb_array_elements(public.read_lists_with_baskets()) with ordinality as x(entry,ord))
    is distinct from (select catalog from shadow_catalog) then raise exception 'Legacy summaries changed'; end if;
if exists(select 1 from public.lists where purchase_mode <> 'legacy') or exists(select 1 from public.purchase_evaluations)
or exists(select 1 from public.purchase_events) then raise exception 'Unexpected activation'; end if;
if (select count(*) from public.purchase_configurations) <> (select count(*) from public.lists)
or (select count(*) from public.purchase_needs) <> (select count(*) from public.basket_items) then raise exception 'Missing shadow'; end if;
if exists(select 1 from public.basket_items i join public.lists l on l.id=i.list_id
left join public.purchase_needs n on (n.list_id,n.version,n.id)=(i.list_id,l.composition_version,i.id)
left join public.purchase_offers o on (o.list_id,o.version,o.id)=(n.list_id,n.version,n.id)
left join public.purchase_coverages c on (c.list_id,c.version,c.offer_id,c.need_id)=(n.list_id,n.version,n.id,n.id)
left join public.purchase_alternatives a on (a.list_id,a.version,a.id)=(n.list_id,n.version,n.id)
left join public.purchase_alternative_needs an on (an.list_id,an.version,an.alternative_id,an.need_id)=(n.list_id,n.version,n.id,n.id)
left join public.purchase_alternative_items ai on (ai.list_id,ai.version,ai.alternative_id,ai.offer_id)=(n.list_id,n.version,n.id,n.id)
where n.id is null or o.id is null or c.offer_id is null or a.id is null or an.need_id is null or ai.offer_id is null
or n.required_quantity <> i.quantity or ai.purchase_units <> i.quantity or c.quantity <> 1
or n.position <> i.position or a.position <> i.position or n.created_at <> i.created_at
or n.legacy_item_id <> i.id or o.product_id <> i.product_id or n.unit <> 'unit' or n.allow_surplus) then raise exception 'Line projection mismatch'; end if;
if exists(select 1 from public.purchase_alert_state s join public.lists l on l.id=s.list_id
where s.version<>l.composition_version or s.budget_reached<>l.basket_reached or s.budget_epoch<>l.basket_alert_epoch or s.last_evaluation_id is not null)
or exists(select 1 from public.purchase_configurations c join public.lists l on l.id=c.list_id
where c.version<>l.composition_version or c.budget is distinct from l.budget or c.currency<>l.currency
or c.configuration->>'version' <> c.version::text or c.winner_enabled or not c.budget_enabled) then raise exception 'Configuration/state mismatch'; end if;
if exists(select 1 from public.purchase_configurations c where
    jsonb_array_length(c.configuration->'needs') <> (select count(*) from public.purchase_needs n where (n.list_id,n.version)=(c.list_id,c.version))
    or jsonb_array_length(c.configuration->'offers') <> (select count(*) from public.purchase_offers o where (o.list_id,o.version)=(c.list_id,c.version))
    or jsonb_array_length(c.configuration->'alternatives') <> (select count(*) from public.purchase_alternatives a where (a.list_id,a.version)=(c.list_id,c.version)))
then raise exception 'Canonical projection incomplete'; end if;
if not exists(select 1 from public.purchase_configurations where list_id=md5('list4')::uuid
    and configuration->'needs'='[]'::jsonb and configuration->'offers'='[]'::jsonb and configuration->'alternatives'='[]'::jsonb)
or exists(select 1 from public.purchase_offers where product_id=md5('product35')::uuid)
or (select count(*) from public.purchase_offers where product_id=md5('product1')::uuid)<>2
then raise exception 'Empty/standalone/shared fixture mismatch'; end if;
foreach role_name in array array['anon','authenticated','service_role'] loop
for t in select tablename from pg_tables where schemaname='public' and tablename like 'purchase_%' loop
if not (select relrowsecurity from pg_class where oid=('public.'||t)::regclass) then raise exception 'Missing RLS'; end if;
if has_table_privilege(role_name,'public.'||t,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
or (role_name <> 'service_role' and has_table_privilege(role_name,'public.'||t,'SELECT'))
or (role_name = 'service_role' and not has_table_privilege(role_name,'public.'||t,'SELECT')) then raise exception 'Unsafe grants: % %',role_name,t; end if;
end loop;
end loop;
if exists(select 1 from information_schema.table_privileges where table_schema='public' and table_name like 'purchase_%' and grantee='PUBLIC') then raise exception 'PUBLIC access'; end if;
end $$;
set role anon;
do $$ begin
begin perform * from public.purchase_needs; raise exception 'Anonymous read accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated;
do $$ begin
begin perform * from public.purchase_needs; raise exception 'Authenticated read accepted'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role service_role;
do $$ begin
if not exists(select 1 from public.purchase_configurations) then raise exception 'Service read failed'; end if;
begin delete from public.purchase_needs; raise exception 'Immutable shadow changed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
begin delete from public.products where id=md5('product1')::uuid;
raise exception 'Referenced tracker deleted'; exception when restrict_violation or foreign_key_violation then null; end;
begin insert into public.purchase_coverages values(md5('list2')::uuid,
(select composition_version from public.lists where id=md5('list2')::uuid),md5('shared')::uuid,md5('item1')::uuid,1);
raise exception 'Cross-list reference accepted'; exception when foreign_key_violation then null; end;
begin insert into public.purchase_pins values(md5('list1')::uuid,
(select composition_version+1 from public.lists where id=md5('list1')::uuid),md5('item1')::uuid);
raise exception 'Cross-version reference accepted'; exception when foreign_key_violation then null; end;
end $$;
begin;
delete from public.lists where id=md5('list1')::uuid;
do $$ begin
if exists(select 1 from public.purchase_configurations where list_id=md5('list1')::uuid)
or not exists(select 1 from public.products where id=md5('product1')::uuid)
or not exists(select 1 from public.purchase_offers where list_id=md5('list2')::uuid) then raise exception 'List cascade damaged shared tracker'; end if;
end $$;
rollback;

-- RLS remains a second boundary even if a read grant is accidentally introduced.
begin;
grant select on public.purchase_needs to anon, authenticated;
set local role anon;
do $$ begin
if exists(select 1 from public.purchase_needs) then raise exception 'Anonymous RLS bypass'; end if;
end $$;
set local role authenticated;
do $$ begin
if exists(select 1 from public.purchase_needs) then raise exception 'Authenticated RLS bypass'; end if;
end $$;
rollback;
begin;
do $$ begin
perform public.set_basket_item(md5('list1')::uuid,md5('product1')::uuid,2,
    (select composition_version from public.lists where id=md5('list1')::uuid));
if (select required_quantity from public.purchase_needs where id=md5('item1')::uuid) <> 2147483647 then raise exception 'Shadow was overwritten'; end if;
end $$;
rollback;
