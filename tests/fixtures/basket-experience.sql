begin;
insert into public.lists(id,name) values ('11111111-1111-4111-8111-111111111111','Experience');
insert into public.products(id,url,domain,name,currency,reference_price,last_price,last_success_at,status)
values ('22222222-2222-4222-8222-222222222222','https://shop.pe/product','shop.pe','Monitor','PEN',100,80,now(),'paused');
create temp table original_product as select * from public.products;
set local role service_role;
select public.set_basket_item('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',2,1);
do $$ declare d jsonb; begin
  d:=public.read_basket_detail('11111111-1111-4111-8111-111111111111',14);
  if d->'basket'->>'current_total' <> '160.00' or d->'basket'->>'reference_total' <> '200.00'
    or d->'basket'->>'composition_version' <> '2' then raise exception 'Invalid basket detail %',d; end if;
  begin
    perform public.set_basket_item('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',3,1);
    raise exception 'Stale composition accepted';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform public.set_basket_item('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',0,2);
    raise exception 'Invalid quantity accepted';
  exception when sqlstate 'PT400' then null; end;
  begin
    perform public.read_basket_detail('11111111-1111-4111-8111-111111111111',1);
    raise exception 'Invalid range accepted';
  exception when sqlstate 'PT400' then null; end;
end $$;
select public.set_basket_item('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',3,2);
do $$ declare d jsonb; begin
  d:=public.read_basket_detail('11111111-1111-4111-8111-111111111111');
  if not (d->'versions' @> '[2,3]'::jsonb) or
    not exists(select 1 from jsonb_array_elements(d->'snapshots') s where s->>'composition_version'='2' and s->>'current_total'='160.00') or
    not exists(select 1 from jsonb_array_elements(d->'snapshots') s where s->>'composition_version'='3' and s->>'current_total'='240.00') then
    raise exception 'History mixed compositions %', d; end if;
end $$;
select public.set_basket_item('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',null,3);
do $$ declare d jsonb; begin
  d:=public.read_basket_detail('11111111-1111-4111-8111-111111111111');
  if d->'basket'->'current_total' <> 'null'::jsonb or d->'basket'->>'complete' <> 'false' then
    raise exception 'Empty basket invented total'; end if;
end $$;
reset role;
do $$ begin
  if exists((select * from public.products) except (select * from original_product)) then
    raise exception 'Membership mutation altered individual tracker'; end if;
  if has_function_privilege('anon','public.read_basket_detail(uuid,integer)','execute')
    or has_function_privilege('authenticated','public.set_basket_item(uuid,uuid,integer,bigint)','execute') then
    raise exception 'Browser can access basket RPC'; end if;
end $$;
select public.mutate_list('delete','11111111-1111-4111-8111-111111111111');
do $$ begin
  if not exists(select 1 from public.products where id='22222222-2222-4222-8222-222222222222') then
    raise exception 'Basket deletion removed product'; end if;
end $$;
rollback;
