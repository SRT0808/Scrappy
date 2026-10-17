-- Offline preservation fixtures.
insert into public.lists(id,name,position,budget,currency)
select md5('list'||n)::uuid,'Basket '||n,n,case when n=1 then 100 end,
case when n=2 then 'USD' else 'PEN' end from generate_series(1,4) n;
insert into public.products(id,url,domain,name,currency,reference_price,last_price,last_success_at,status,consecutive_failures)
select md5('product'||n)::uuid,'https://example.test/'||n,'example.test',case when n=2 then null else 'Product '||n end,
case when n%2=0 then 'USD' else 'PEN' end,20,10,'2026-10-16 12:00Z',
case when n=3 then 'error' when n=4 then 'paused' else 'active' end,case when n=3 then 1 else 0 end from generate_series(1,35) n;
insert into public.basket_items(id,list_id,product_id,quantity,position,created_at)
select md5('item'||n)::uuid,md5('list1')::uuid,md5('product'||n)::uuid,
case when n=1 then 2147483647 else 2 end,n,'2026-01-01 12:00Z' from generate_series(1,33) n;
insert into public.basket_items(id,list_id,product_id,quantity,position)
values(md5('shared')::uuid,md5('list2')::uuid,md5('product1')::uuid,3,0);
insert into public.basket_items(id,list_id,product_id,quantity,position)
values(md5('fx')::uuid,md5('list3')::uuid,md5('product34')::uuid,2,0);
update public.products set alert_state='triggered',last_alert_price=10,last_alert_at='2026-10-16 12:00Z',
    target_type='price',target_price=11 where id=md5('product3')::uuid;
update public.products set last_price=null,last_success_at=null,status='pending_confirmation'
where id=md5('product5')::uuid;
update public.products set last_availability='OutOfStock' where id=md5('product6')::uuid;
insert into public.price_checks(product_id,checked_at,ok,price,currency,method)
select id,'2026-10-16 12:00Z',last_price is not null,last_price,currency,'json_ld' from public.products;
insert into public.price_checks(product_id,checked_at,ok,error_code)
values(md5('product3')::uuid,'2026-10-16 12:05Z',false,'fixture_failure');
insert into public.notifications(product_id,type,channel,status,payload)
values(md5('product1')::uuid,'target','ntfy','sent','{"kept":true}');
insert into public.exchange_rates(rate_date,rate,source,fetched_at)
values('2026-10-16',3.754321,'BCRPData:PD04638PD','2026-10-16 12:00Z');
select public.claim_basket_events(null);
update public.lists set basket_reached=true,basket_alert_epoch=7 where id=md5('list1')::uuid;
insert into public.basket_events(list_id,name,budget,currency,total,status,composition_version,alert_epoch)
select id,name,100,currency,50,'claimed',composition_version,7 from public.lists where id=md5('list1')::uuid;
create table shadow_original(name text,rows jsonb);
do $$ declare r record; begin
for r in select tablename from pg_tables where schemaname='public' and tablename not like 'shadow_%' loop
execute format('insert into shadow_original select %L,coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), ''[]''::jsonb) from public.%I t',r.tablename,r.tablename);
end loop;
end $$;
create table shadow_summary as select id,public.basket_summary_at(id,'2026-10-16 12:00Z') summary from public.lists;
-- The live catalog uses statement_timestamp(); compare all but that volatile field.
create table shadow_catalog as select jsonb_agg(entry #- '{basket,calculated_at}' order by ord) catalog
from jsonb_array_elements(public.read_lists_with_baskets()) with ordinality as x(entry,ord);
create table shadow_function as select pg_get_functiondef('public.read_lists_with_baskets()'::regprocedure) definition;
-- Fixture helpers are not migration objects; exclude them from both grant sets.
create table shadow_grants as select table_name,grantee,privilege_type from information_schema.table_privileges
where table_schema='public' and left(table_name,7) <> 'shadow_';
