-- BEFORE MIGRATION: retain real historical fields and legacy stock warnings.
insert into public.lists(id,name,currency) values('10000000-0000-0000-0000-000000000001','Legacy','USD');
insert into public.products(id,url,domain,currency,reference_price,status,last_price,last_success_at)
values('20000000-0000-0000-0000-000000000001','https://fixture.invalid/legacy','fixture.invalid','USD',12.10,'active',10.05,now());
insert into public.basket_items(list_id,product_id) values('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001');
insert into public.price_checks(product_id,ok,price,currency,warnings)
values('20000000-0000-0000-0000-000000000001',true,10.05,'USD','["Producto agotado; precio válido, alerta de meta bloqueada."]');
create temp table original_products as select id,to_jsonb(p) as payload from public.products p;
create temp table original_checks as select id,to_jsonb(c) as payload from public.price_checks c;

-- AFTER MIGRATION
set local role service_role;
create function pg_temp.assert(p_condition boolean, p_message text) returns void
language plpgsql as $$ begin if p_condition is distinct from true then raise exception '%', p_message; end if; end $$;

do $$
declare
    a uuid; b uuid; u uuid; p uuid; missing uuid; independent uuid;
    s jsonb; version bigint; snapshots integer; checks integer; before_state jsonb;
    today date := (statement_timestamp() at time zone 'America/Lima')::date;
    at_time timestamptz := statement_timestamp();
begin
    perform pg_temp.assert(not exists(select 1 from original_products o join public.products pr on pr.id=o.id
        where o.payload is distinct from to_jsonb(pr)-'last_availability')
        and not exists(select 1 from original_checks o join public.price_checks c on c.id=o.id
        where o.payload is distinct from to_jsonb(c)-'availability')
        and (select count(*) from public.price_checks)=(select count(*) from original_checks), 'Migration changed individual history');
    s := public.list_basket_summary('10000000-0000-0000-0000-000000000001');
    perform pg_temp.assert(not (s->>'complete')::boolean and (s->>'unavailable_count')::integer=1
        and (select count(*) from public.basket_snapshots)=1, 'Legacy unavailable snapshot');
    a := (public.mutate_list('create', p_name => 'Decimal basket')->>'id')::uuid;
    b := (public.mutate_list('create', p_name => 'Shared basket')->>'id')::uuid;
    perform public.configure_list_basket(a, 200, 'PEN');
    s := public.list_basket_summary(a);
    perform pg_temp.assert(not (s->>'complete')::boolean and s->>'total' is null, 'Empty must not cost zero');
    insert into public.products(url, domain, currency, reference_price, status, last_price, last_success_at)
    values ('https://fixture.invalid/usd', 'fixture.invalid', 'USD', 12.10, 'active', 10.05, at_time) returning id into u;
    insert into public.products(url, domain, currency, reference_price, status, last_price, last_success_at)
    values ('https://fixture.invalid/pen', 'fixture.invalid', 'PEN', 25.05, 'paused', 20.10, at_time) returning id into p;
    insert into public.basket_items(list_id, product_id, quantity) values (a,u,3),(a,p,2),(b,u,1);
    s := public.list_basket_summary(a);
    perform pg_temp.assert((s->>'total')::numeric = 40.20 and not (s->>'complete')::boolean
        and (s->>'fx_missing_count')::integer=1 and s->>'reference_total' is null, 'Missing FX must retain only known subtotal');
    perform pg_temp.assert(not exists (select 1 from public.claim_basket_events(a)), 'Missing FX triggered goal');
    version := (s->>'composition_version')::bigint;
    perform public.cache_exchange_rate(jsonb_build_object('rate_date',today-6,'rate','3.5',
        'from_currency','USD','to_currency','PEN','source','BCRPData:PD04638PD','fetched_at',at_time));
    perform pg_temp.assert(not (public.list_basket_summary(a)->>'complete')::boolean
        and (public.list_basket_summary(a)->>'total')::numeric=145.73
        and (public.list_basket_summary(a)->>'savings')::numeric=31.42
        and not exists(select 1 from public.claim_basket_events(a)), 'Expired cached FX triggered goal');
    insert into public.exchange_rates(rate_date, rate, source) values(today,3.5,'BCRPData:PD04638PD');
    s := public.list_basket_summary(a);
    perform pg_temp.assert((s->>'complete')::boolean and (s->>'valid_count')::integer=2
        and (s->>'total')::numeric=145.73 and (s->>'reference_total')::numeric=177.15
        and (s->>'savings')::numeric=31.42 and (s->>'savings_percent')::numeric=17.74,
        'Decimal quantities / conversions / aggregate rounding');
    perform pg_temp.assert((s->>'composition_version')::bigint=version
        and s->'exchange_rates'->0->>'source'='BCRPData:PD04638PD'
        and s->'exchange_rates'->0->>'date'=today::text, 'FX provenance or version');
    perform pg_temp.assert((public.basket_summary_at(a, at_time + interval '5 days')->>'complete')::boolean
        and not (public.basket_summary_at(a, at_time + interval '6 days')->>'complete')::boolean
        and (public.basket_summary_at(a, at_time + interval '6 days')->>'total')::numeric=145.73,
        'Five calendar days inclusive; expired cache still estimates');
    perform pg_temp.assert(not (public.basket_summary_at(a, (today+6)::timestamp at time zone 'America/Lima')->>'complete')::boolean,
        'Lima calendar boundary');
    select to_jsonb(pr) - 'last_availability' into before_state from public.products pr where id=u;
    update public.products set consecutive_failures=1 where id=u;
    s := public.list_basket_summary(a);
    perform pg_temp.assert(not (s->>'complete')::boolean and (s->>'total')::numeric=145.73
        and (s->>'stale_count')::integer=1 and (s->'lines'->0->>'last_success_at')::timestamptz=at_time,
        'First failure must retain a dated estimate');
    perform pg_temp.assert(not exists (select 1 from public.claim_basket_events(a)), 'Stale price triggered goal');
    update public.products set status='error',consecutive_failures=3 where id=u;
    perform pg_temp.assert((public.list_basket_summary(a)->>'total')::numeric=145.73, 'Error product removed from total');
    update public.products set status='active',consecutive_failures=0 where id=u;
    select count(*) into snapshots from public.basket_snapshots where list_id=a;
    perform public.save_review(u, null, at_time, true, jsonb_build_array(jsonb_build_object(
        'checked_at',at_time,'ok',true,'price','10.05','currency','USD','availability','https://schema.org/OutOfStock')));
    s := public.list_basket_summary(a);
    perform pg_temp.assert(not (s->>'complete')::boolean and (s->>'unavailable_count')::integer=1
        and (s->>'total')::numeric=145.73, 'Accepted unavailable price cannot complete basket');
    perform pg_temp.assert(not exists (select 1 from public.claim_basket_events(a)), 'Unavailable price triggered goal');
    perform public.save_review(u, at_time, at_time + interval '1 second', false,
        jsonb_build_array(jsonb_build_object('checked_at',at_time+interval '1 second','ok',false,'price',null,'error_code','invalid_reading')));
    perform pg_temp.assert((public.list_basket_summary(a)->>'total')::numeric=145.73, 'Rejected read overwrote confirmed price');
    perform public.save_review(u, at_time+interval '1 second', at_time+interval '2 seconds', true,
        jsonb_build_array(jsonb_build_object('checked_at',at_time+interval '2 seconds','ok',true,'price','10.05','currency','USD','availability','InStock')));
    s := public.list_basket_summary(a);
    perform pg_temp.assert((s->>'complete')::boolean and (s->>'composition_version')::bigint=version
        and (select count(*) from public.basket_snapshots where list_id=a)=snapshots+3,
        'Each review, even unchanged price, snapshots without changing composition');
    perform pg_temp.assert((select count(*) from public.basket_snapshots where list_id=b)>=3, 'Shared product snapshots');
    select count(*) into checks from public.price_checks;
    select count(*) into snapshots from public.basket_snapshots where list_id=a;
    update public.basket_items set position=position+1 where list_id=a;
    perform pg_temp.assert((select count(*) from public.basket_snapshots where list_id=a)=snapshots, 'Reordering changed composition');
    update public.basket_items set quantity=4 where list_id=a and product_id=u;
    s := public.list_basket_summary(a);
    perform pg_temp.assert((s->>'composition_version')::bigint=version+1 and (s->>'total')::numeric=180.90
        and exists(select 1 from public.basket_snapshots where list_id=a and composition_version=version and current_total=145.73),
        'Quantity version must preserve previous history');
    update public.products set reference_price=13.10 where id=u;
    perform pg_temp.assert((public.list_basket_summary(a)->>'composition_version')::bigint=version+2,
        'Reference change must start a version');
    update public.exchange_rates set rate=3.6 where rate_date=today;
    perform pg_temp.assert((public.list_basket_summary(a)->>'composition_version')::bigint=version+2
        and exists(select 1 from public.basket_snapshots where list_id=a and exchange_rates->0->>'rate'='3.5'),
        'FX changes must preserve snapshot provenance without changing composition');
    perform public.configure_list_basket(a, 200, 'USD');
    s := public.list_basket_summary(a);
    perform pg_temp.assert((s->>'composition_version')::bigint=version+3 and (s->>'total')::numeric=51.37,
        'PEN to USD inverse / currency version');
    perform public.configure_list_basket(a, 201, 'USD');
    perform pg_temp.assert((public.list_basket_summary(a)->>'composition_version')::bigint=version+4, 'Goal version');
    insert into public.products(url,domain,currency,reference_price) values('https://fixture.invalid/missing','fixture.invalid','USD',50)
        returning id into missing;
    insert into public.basket_items(list_id,product_id) values(a,missing);
    s := public.list_basket_summary(a);
    perform pg_temp.assert((s->>'missing_count')::integer=1 and (s->>'total')::numeric=51.37
        and s->>'savings' is null and not (s->>'complete')::boolean, 'Absent first price is a known subtotal, no savings fiction');
    perform pg_temp.assert(not exists(select 1 from public.claim_basket_events(a)), 'Absent price triggered goal');
    update public.products set currency='EUR' where id=p;
    perform pg_temp.assert(not (public.list_basket_summary(a)->>'complete')::boolean, 'Unsupported FX completed');
    delete from public.basket_items where list_id=a and product_id in(u,p);
    perform pg_temp.assert(public.list_basket_summary(a)->>'total' is null, 'All missing must be null, never zero');
    delete from public.basket_items where list_id=a;
    perform pg_temp.assert((select count(*) from public.price_checks)=checks, 'Composition or FX invented price checks');
    insert into public.products(url,domain) values('https://fixture.invalid/independent','fixture.invalid') returning id into independent;
    update public.products set reference_price=99 where id=independent;
    perform pg_temp.assert(not exists(select 1 from public.basket_snapshots where lines @> jsonb_build_array(jsonb_build_object('product_id',independent))),
        'Independent product created basket history');
    -- Reconfirmation is covered through the actual reading RPC, including stock.
    missing := gen_random_uuid();
    perform public.create_product_reading(missing,'https://fixture.invalid/confirmed');
    perform public.claim_product_reading(missing);
    perform public.complete_product_reading(missing,'{"name":"Confirmed","price":"10.05","currency":"PEN","availability":"OutOfStock","candidates":[]}', '{}');
    s := public.confirm_product_reading(missing,jsonb_build_object('list_id',a,'name','Confirmed','currency','PEN',
        'reference_price','12.10','target_type','price','target_value','9','check_interval_hours',6));
    perform pg_temp.assert((select last_availability from public.products where id=(s->>'product_id')::uuid)='OutOfStock'
        and (public.list_basket_summary(a)->>'unavailable_count')::integer=1, 'Initial confirmed stock was lost');
    -- All historical aggregates remain isolated by version; product alerts were not touched.
    perform pg_temp.assert((select alert_state from public.products where id=u) = before_state->>'alert_state', 'Individual alert changed');
    perform public.read_lists_with_baskets();
    select count(*) into snapshots from public.basket_snapshots;
    perform public.cache_exchange_rate(jsonb_build_object('rate_date',today,'rate','3.6',
        'from_currency','USD','to_currency','PEN','source','BCRPData:PD04638PD','fetched_at',at_time+interval '5 seconds'));
    perform pg_temp.assert((select count(*) from public.basket_snapshots)=snapshots, 'Identical rate created extra snapshots');
    perform public.cache_exchange_rate(jsonb_build_object('rate_date',today,'rate','3.9',
        'from_currency','USD','to_currency','PEN','source','BCRPData:PD04638PD','fetched_at',at_time));
    perform pg_temp.assert((select rate from public.exchange_rates where rate_date=today)=3.6, 'Older fetch overwrote cache');
    begin
        perform public.cache_exchange_rate(jsonb_build_object('rate_date',today+1,'rate','3.6',
            'from_currency','USD','to_currency','PEN','source','BCRPData:PD04638PD','fetched_at',at_time));
        raise exception 'Future FX accepted';
    exception when sqlstate 'PT400' then null; end;
end $$;
reset role;
do $$ begin
    perform pg_temp.assert(not has_table_privilege('anon','public.basket_snapshots','SELECT')
        and not has_table_privilege('authenticated','public.exchange_rates','SELECT')
        and not has_function_privilege('anon','public.cache_exchange_rate(jsonb)','EXECUTE')
        and not has_function_privilege('authenticated','public.basket_summary_at(uuid,timestamptz)','EXECUTE')
        and (select relrowsecurity from pg_class where oid='public.basket_snapshots'::regclass)
        and (select relrowsecurity from pg_class where oid='public.exchange_rates'::regclass), 'RLS/permissions');
end $$;
