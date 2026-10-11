-- BEFORE MIGRATION
insert into public.lists(id,name,currency,budget) values('10000000-0000-0000-0000-000000000001','Recovery','PEN',100);
insert into public.products(id,url,domain,name,currency,reference_price,target_type,target_price,status,
    last_price,last_success_at,last_checked_at,consecutive_failures,alert_state,last_alert_price,last_alert_at)
values('20000000-0000-0000-0000-000000000001','https://shop.pe/old','shop.pe','Monitor','PEN',150,'price',80,'error',
    90,now()-interval '1 day',now()-interval '1 hour',3,'triggered',70,now()-interval '2 days');
insert into public.basket_items(list_id,product_id,quantity) values('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',1);
insert into public.price_checks(product_id,ok,price,currency) values('20000000-0000-0000-0000-000000000001',true,90,'PEN');
insert into public.notifications(product_id,type,channel,status,payload) values('20000000-0000-0000-0000-000000000001','goal_reached','ntfy','sent','{}');
-- The MVP could leave more than one ambiguous claim across goal edits.
insert into public.basket_events(list_id,name,budget,currency,total)
    values('10000000-0000-0000-0000-000000000001','Recovery',100,'PEN',90),
        ('10000000-0000-0000-0000-000000000001','Recovery',110,'PEN',90);
create temp table original_products as select * from public.products;
create temp table original_checks as select * from public.price_checks;
create temp table original_items as select * from public.basket_items;
create temp table original_notifications as select * from public.notifications;
create temp table original_snapshots as select * from public.basket_snapshots;
-- AFTER MIGRATION
set local role service_role;
create function pg_temp.assert(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception '%',message; end if; end $$;
do $$
declare
    a uuid := '10000000-0000-0000-0000-000000000001';
    p uuid := '20000000-0000-0000-0000-000000000001';
    r uuid := gen_random_uuid(); e public.basket_events; v bigint; n integer; b uuid; u uuid;
    c jsonb := '{"same_product":true,"name":"Monitor","currency":"PEN","candidate_index":null}';
begin
    perform pg_temp.assert(not exists((select * from original_products) except (select * from public.products))
        and not exists((select * from original_checks) except (select * from public.price_checks))
        and not exists((select * from original_items) except (select * from public.basket_items))
        and not exists((select * from original_notifications) except (select * from public.notifications))
        and not exists((select * from original_snapshots) except (select * from public.basket_snapshots)), 'Migration lost legacy data');
    perform pg_temp.assert((select count(*) from public.basket_events where composition_version=0 and status='claimed')=2,
        'Legacy ambiguous claims lost or misversioned');
    perform pg_temp.assert(not exists(select 1 from public.claim_basket_events(a)), 'Error basket triggered');
    v := (select composition_version from public.lists where id=a);
    perform public.create_product_repair(r,p,'https://shop.pe/new');
    perform public.claim_product_reading(r);
    perform public.complete_product_reading(r,'{"name":"Monitor","price":"90.00","currency":"PEN","method":"json_ld","confidence":0.99,"candidates":[],"warnings":[]}', '{}');
    begin
        perform public.confirm_product_reading(r,c || '{"same_product":false}');
        raise exception 'Different article accepted';
    exception when sqlstate 'PT400' then null; end;
    begin
        perform public.confirm_product_reading(r,c || '{"currency":"USD"}');
        raise exception 'Different currency accepted';
    exception when sqlstate 'PT400' then null; end;
    begin
        perform public.confirm_product_reading(r,c || '{"name":"Other"}');
        raise exception 'Unconfirmed name accepted';
    exception when sqlstate 'PT400' then null; end;
    perform public.confirm_product_reading(r,c);
    perform public.confirm_product_reading(r,c);
    perform pg_temp.assert((select count(*) from public.products)=1 and (select count(*) from public.price_checks)=2,
        'Repair/replay duplicated product or observation');
    perform pg_temp.assert((select url='https://shop.pe/new' and status='active' and consecutive_failures=0
        and alert_state='triggered' and last_alert_price=70 and reference_price=150 and target_price=80
        and last_alert_at=(select last_alert_at from original_products) from public.products where id=p), 'Repair lost individual state');
    perform pg_temp.assert(not exists((select * from original_items) except (select * from public.basket_items))
        and not exists((select * from original_snapshots) except (select * from public.basket_snapshots))
        and (select composition_version=v from public.lists where id=a)
        and (public.list_basket_summary(a)->>'complete')::boolean, 'Repair lost history/membership or did not recover');
    select * into e from public.claim_basket_events(a);
    perform pg_temp.assert(e.total=90 and not (select basket_reached from public.lists where id=a), 'Premature delivered state');
    perform pg_temp.assert(not exists(select 1 from public.claim_basket_events(a)), 'Duplicate pending claim');
    perform public.finish_basket_event(e.id,false);
    select * into e from public.claim_basket_events(a);
    perform pg_temp.assert(e.id is not null, 'Both failed channels did not retry');
    perform public.finish_basket_event(e.id,true);
    update public.products set last_price=103 where id=p;
    perform pg_temp.assert(not exists(select 1 from public.claim_basket_events(a)) and
        (select basket_reached from public.lists where id=a), 'Exact 3 percent rearmed');
    update public.products set last_price=90 where id=p;
    perform pg_temp.assert(not exists(select 1 from public.claim_basket_events(a)), 'Band caused duplicate');
    update public.products set last_price=103.01 where id=p;
    perform public.claim_basket_events(a);
    update public.products set consecutive_failures=1,last_price=90 where id=p;
    perform pg_temp.assert(not exists(select 1 from public.claim_basket_events(a)), 'Incomplete triggered');
    update public.products set consecutive_failures=0,last_availability='OutOfStock' where id=p;
    perform pg_temp.assert(not exists(select 1 from public.claim_basket_events(a)), 'Unavailable triggered');
    update public.products set last_availability='InStock' where id=p;
    select * into e from public.claim_basket_events(a);
    perform pg_temp.assert(e.id is not null, 'Rearmed crossing missing');
    perform public.configure_list_basket(a,101,'PEN');
    perform public.finish_basket_event(e.id,true);
    perform pg_temp.assert(not (select basket_reached from public.lists where id=a), 'Old version changed new state');
    select * into e from public.claim_basket_events(a);
    perform pg_temp.assert(e.composition_version=v+1, 'Goal version missing');
    update public.products set last_price=105 where id=p;
    perform public.claim_basket_events(a);
    update public.products set last_price=90 where id=p;
    perform public.claim_basket_events(a);
    perform public.finish_basket_event(e.id,true);
    perform pg_temp.assert(not (select basket_reached from public.lists where id=a), 'Late receipt overwrote a later rearm');
    select * into e from public.claim_basket_events(a);
    perform pg_temp.assert(e.id is not null, 'New crossing lost after late receipt');
    perform public.finish_basket_event(e.id,true);
    -- Repair conflicts with a later review; shared membership stays unchanged.
    b := (public.mutate_list('create',p_name=>'Shared')->>'id')::uuid;
    insert into public.basket_items(list_id,product_id,quantity) values(b,p,2);
    r := gen_random_uuid();
    perform public.create_product_repair(r,p,'https://shop.pe/newer');
    perform public.claim_product_reading(r);
    perform public.complete_product_reading(r,'{"name":"Monitor","price":"85.00","currency":"PEN","method":"json_ld","confidence":0.99,"candidates":[],"warnings":[]}', '{}');
    update public.products set last_checked_at=statement_timestamp()+interval '1 second' where id=p;
    begin
        perform public.confirm_product_reading(r,c);
        raise exception 'Stale repair accepted';
    exception when sqlstate 'PT409' then null; end;
    r := gen_random_uuid();
    update public.products set status='paused' where id=p;
    perform public.create_product_repair(r,p,'https://shop.pe/final');
    perform public.claim_product_reading(r);
    perform public.complete_product_reading(r,'{"name":"Monitor","price":null,"currency":"PEN","method":"json_ld","confidence":0.5,"candidates":[{"name":"Monitor","price":"85.00","currency":"PEN"}],"warnings":[]}', '{}');
    perform public.confirm_product_reading(r,c || '{"candidate_index":0}');
    perform pg_temp.assert((select status='paused' and alert_state='triggered' from public.products where id=p)
        and (select count(*) from public.basket_items where product_id=p)=2
        and (public.list_basket_summary(a)->>'complete')::boolean
        and (public.list_basket_summary(b)->>'complete')::boolean, 'Candidate repair lost pause/multiple memberships');
    -- FX alone crosses a complete basket; amounts and provenance are frozen in the event.
    perform public.configure_list_basket(b,100,'PEN');
    insert into public.products(url,domain,currency,reference_price,last_price,last_success_at,status)
        values('https://shop.pe/usd','shop.pe','USD',40,30,now(),'active') returning id into u;
    delete from public.basket_items where list_id=b;
    insert into public.basket_items(list_id,product_id) values(b,u);
    insert into public.exchange_rates(rate_date,rate,source) values((now() at time zone 'America/Lima')::date,3.5,'BCRPData:PD04638PD');
    perform pg_temp.assert(not exists(select 1 from public.claim_basket_events(b)), 'Above FX goal triggered');
    update public.exchange_rates set rate=3 where rate_date=(now() at time zone 'America/Lima')::date;
    select * into e from public.claim_basket_events(b);
    perform pg_temp.assert(e.cause='conversion' and e.total=90 and e.savings=30
        and e.exchange_rates->0->>'source'='BCRPData:PD04638PD', 'FX-only cause/provenance lost');
    perform public.finish_basket_event(e.id,false);
    select * into e from public.claim_basket_events(b);
    perform pg_temp.assert(e.cause='conversion', 'Conversion cause lost on delivery retry');
    perform public.finish_basket_event(e.id,true);
    perform pg_temp.assert(not exists((select * from original_notifications) except (select * from public.notifications)), 'Individual notifications changed');
    -- Existing new-product confirmation keeps its independent configuration and history.
    r := gen_random_uuid();
    perform public.create_product_reading(r,'https://shop.pe/individual');
    perform public.claim_product_reading(r);
    perform public.complete_product_reading(r,'{"name":"Individual","price":"80.00","currency":"PEN","method":"json_ld","confidence":0.99,"candidates":[],"warnings":[]}', '{}');
    u := (public.confirm_product_reading(r,jsonb_build_object('list_id',null,'name','Individual','currency','PEN',
        'reference_price','120','target_type','percent','target_value','25','check_interval_hours',6))->>'product_id')::uuid;
    perform pg_temp.assert((select reference_price=120 and target_price=90 and target_percent=25
        and alert_state='armed' and last_price=80 from public.products where id=u)
        and (select count(*) from public.price_checks where product_id=u)=1
        and not exists(select 1 from public.basket_items where product_id=u), 'Individual creation regressed');
end $$;
reset role;
do $$ begin
    if has_function_privilege('anon','public.create_product_repair(uuid,uuid,text,text)','execute')
        or has_function_privilege('authenticated','public.finish_basket_event(uuid,boolean)','execute') then
        raise exception 'Public RPC access';
    end if;
end $$;
