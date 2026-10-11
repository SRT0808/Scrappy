-- Fixtures intentionally exercise every individual status and both alert states.
insert into public.lists(id, name, emoji, position, basket_budget, basket_currency, basket_reached)
values ('10000000-0000-0000-0000-000000000001', 'Configured', 'A', 4, 200.50, 'USD', true),
       ('10000000-0000-0000-0000-000000000002', 'Unconfigured', 'B', 9, null, null, false),
       ('10000000-0000-0000-0000-000000000003', 'Empty', null, 15, null, null, false);
insert into public.products(list_id, url, domain, name, currency, reference_price,
    target_type, target_price, target_percent, status, last_price, last_checked_at,
    last_success_at, consecutive_failures, alert_state, last_alert_price, last_alert_at, created_at)
select '10000000-0000-0000-0000-000000000001', 'https://fixture.invalid/' || n,
    'fixture.invalid', 'Product ' || n, 'USD', 120.25, 'percent', 90.19, 25,
    s, 100.10, '2026-10-10T10:00:00Z', '2026-10-09T10:00:00Z',
    case when s = 'error' then 3 else 0 end,
    case when n % 2 = 0 then 'triggered' else 'armed' end,
    90, '2026-10-08T10:00:00Z', '2026-10-01T10:00:00Z'
from unnest(array['active','paused','error','pending_confirmation']) with ordinality as x(s,n);
insert into public.price_checks(product_id, ok, price, currency, error_code)
select id, true, 100.10, 'USD', null from public.products
union all select id, false, null, null, 'fixture_failure' from public.products;
insert into public.notifications(product_id, type, channel, status, payload)
select id, 'target_reached', 'ntfy', 'sent', '{"fixture":true}' from public.products;
insert into public.product_readings(id, url, domain, status, product_id)
select gen_random_uuid(), url, domain, 'confirmed', id from public.products;
insert into public.basket_events(list_id, name, budget, currency, total, status)
values ('10000000-0000-0000-0000-000000000001', 'Configured', 200.50, 'USD', 190, 'sent');
create temp table before_products as select id, list_id, to_jsonb(p) - 'list_id' as payload from public.products p;
create temp table before_lists as select id,
    (to_jsonb(l) - array['basket_budget','basket_currency']) ||
    jsonb_build_object('budget', basket_budget, 'currency', coalesce(basket_currency, 'PEN')) as payload from public.lists l;
create temp table before_checks as select * from public.price_checks;
create temp table before_notifications as select * from public.notifications;
create temp table before_readings as select * from public.product_readings;
create temp table before_events as select * from public.basket_events;

-- AFTER MIGRATION
do $$
begin
    if exists ((select id, payload from before_products except select id, to_jsonb(p) from public.products p)
        union all (select id, to_jsonb(p) from public.products p except select id, payload from before_products)) then
        raise exception 'Individual IDs, fields or alert state changed';
    end if;
    if exists ((select * from before_lists except select id, to_jsonb(l) from public.lists l)
        union all (select id, to_jsonb(l) from public.lists l except select * from before_lists)) then
        raise exception 'Basket identity, ordering, configuration or state changed';
    end if;
    if exists ((select * from before_checks except select * from public.price_checks)
        union all (select * from public.price_checks except select * from before_checks))
      or exists ((select * from before_notifications except select * from public.notifications)
        union all (select * from public.notifications except select * from before_notifications))
      or exists ((select * from before_readings except select * from public.product_readings)
        union all (select * from public.product_readings except select * from before_readings))
      or exists ((select * from before_events except select * from public.basket_events)
        union all (select * from public.basket_events except select * from before_events)) then
        raise exception 'History or notifications lost or duplicated';
    end if;
    if (select count(*) from public.basket_items) <> (select count(*) from before_products)
      or exists (select 1 from before_products p where not exists (
        select 1 from public.basket_items i where i.product_id=p.id and i.list_id=p.list_id
          and i.quantity=1 and i.created_at=(p.payload->>'created_at')::timestamptz))
      or (select array_agg(product_id order by position) from public.basket_items)
        is distinct from (select array_agg(id order by payload->>'created_at', id) from before_products) then
        raise exception 'Membership or deterministic ordering not preserved';
    end if;
end $$;

set local role service_role;
do $$
declare
    v_product uuid;
    v_independent uuid;
    v_reading uuid := gen_random_uuid();
    v_replay jsonb;
    v_before jsonb;
    v_bad integer;
    v_a uuid := '10000000-0000-0000-0000-000000000001';
    v_b uuid := '10000000-0000-0000-0000-000000000002';
begin
    select id, to_jsonb(p) into v_product, v_before from public.products p where status='active';
    insert into public.basket_items(list_id, product_id, quantity) values(v_b, v_product, 3);
    if (select count(*) from public.basket_items where product_id=v_product) <> 2
        or (select to_jsonb(p) from public.products p where id=v_product) <> v_before then
        raise exception 'Multiple baskets changed the individual tracker';
    end if;
    begin
        insert into public.basket_items(list_id, product_id) values(v_b, v_product);
        raise exception 'Duplicate membership accepted';
    exception when unique_violation then null; end;
    foreach v_bad in array array[0,-1] loop
        begin
            update public.basket_items set quantity=v_bad where product_id=v_product;
            raise exception 'Invalid quantity accepted';
        exception when check_violation then null; end;
    end loop;
    begin
        update public.basket_items set quantity=null where product_id=v_product;
        raise exception 'Null quantity accepted';
    exception when not_null_violation then null; end;
    begin
        insert into public.basket_items(list_id, product_id) values(v_b, gen_random_uuid());
        raise exception 'Dangling product accepted';
    exception when foreign_key_violation then null; end;
    begin
        insert into public.basket_items(list_id, product_id) values(gen_random_uuid(), v_product);
        raise exception 'Dangling basket accepted';
    exception when foreign_key_violation then null; end;
    -- Removal of every membership retains individual history and alert state.
    delete from public.basket_items where product_id=v_product;
    if (select to_jsonb(p) from public.products p where id=v_product) <> v_before
        or (select count(*) from public.price_checks where product_id=v_product) <> 2
        or (select count(*) from public.notifications where product_id=v_product) <> 1 then
        raise exception 'Removing memberships damaged the tracker';
    end if;
    insert into public.products(url, domain) values('https://fixture.invalid/independent','fixture.invalid') returning id into v_independent;
    if exists (select 1 from public.basket_items where product_id=v_independent) then raise exception 'Basket required'; end if;
    -- Preserve confirmation with a list and allow confirmation without one.
    foreach v_b in array array[v_b, null::uuid] loop
        v_reading := gen_random_uuid();
        perform public.create_product_reading(v_reading,'https://fixture.invalid/reading');
        perform public.claim_product_reading(v_reading);
        perform public.complete_product_reading(v_reading,'{"name":"Confirmed","price":"100.10","currency":"PEN","method":"jsonld","candidates":[]}', '{}');
        v_replay := public.confirm_product_reading(v_reading, jsonb_build_object(
            'list_id',v_b,'name','Confirmed','currency','PEN','reference_price','120.00',
            'target_type','price','target_value','90.00','check_interval_hours',6));
        v_independent := (v_replay->>'product_id')::uuid;
        if public.confirm_product_reading(v_reading,'{}')->>'product_id' <> v_independent::text
            or (select count(*) from public.price_checks where product_id=v_independent) <> 1
            or (select count(*) from public.basket_items where product_id=v_independent) <> (case when v_b is null then 0 else 1 end) then
            raise exception 'Confirmation or idempotent replay changed';
        end if;
    end loop;
    -- Deleting a basket deletes only lines, even for products shared elsewhere.
    v_b := '10000000-0000-0000-0000-000000000002';
    insert into public.basket_items(list_id, product_id) values(v_a, v_product),(v_b,v_product);
    perform public.mutate_list('delete',v_a);
    if not exists (select 1 from public.basket_items where list_id=v_b and product_id=v_product)
        or (select to_jsonb(p) from public.products p where id=v_product) <> v_before then
        raise exception 'Deleting a basket damaged another membership or tracker';
    end if;
    perform public.configure_list_basket(v_b, 1000, 'USD');
    if public.list_basket_summary(v_b)->>'product_count' <> '2' then raise exception 'Summary uses obsolete membership'; end if;
    perform public.read_lists_with_baskets();
    perform public.claim_basket_events(v_b);
    perform public.configure_list_basket(v_b, null, null);
    if (select currency from public.lists where id=v_b) <> 'PEN' then raise exception 'Default currency lost'; end if;
    perform 1 from public.due_products(now());
    if (select to_jsonb(p) from public.products p where id=v_product) <> v_before then raise exception 'Basket RPC changed individual alerts'; end if;
end $$;
reset role;
do $$
begin
    if not (select relrowsecurity from pg_class where oid='public.basket_items'::regclass)
        or exists (select 1 from pg_policies where schemaname='public' and tablename='basket_items')
        or has_table_privilege('anon','public.basket_items','SELECT,INSERT,UPDATE,DELETE')
        or has_table_privilege('authenticated','public.basket_items','SELECT,INSERT,UPDATE,DELETE')
        or has_function_privilege('anon','public.confirm_product_reading(uuid,jsonb)','EXECUTE')
        or has_function_privilege('authenticated','public.configure_list_basket(uuid,numeric,text)','EXECUTE') then
        raise exception 'Public access or RLS regression';
    end if;
end $$;
set local role anon;
do $$ begin
    begin
        perform 1 from public.basket_items;
        raise exception 'Anonymous membership read allowed';
    exception when insufficient_privilege then null; end;
end $$;
reset role;
