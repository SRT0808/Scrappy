set local role service_role;
do $$
declare l uuid; a uuid; b uuid; s jsonb; before_state jsonb; events integer;
begin
    if has_function_privilege('anon', 'public.claim_basket_events(uuid)', 'EXECUTE')
       or has_function_privilege('authenticated', 'public.configure_list_basket(uuid,numeric,text)', 'EXECUTE')
       or has_table_privilege('anon', 'public.basket_events', 'SELECT') then
        raise exception 'Public basket permissions';
    end if;
    l := (public.mutate_list('create', p_name => 'Basket fixture')->>'id')::uuid;
    if public.list_basket_summary(l) is not null then raise exception 'Basket enabled by default'; end if;
    perform public.configure_list_basket(l, 100.10, 'PEN');
    if (public.list_basket_summary(l)->>'complete')::boolean then raise exception 'Empty basket complete'; end if;
    insert into public.products(list_id, url, domain, currency, status, last_price, last_success_at)
    values (l, 'https://fixture.invalid/a', 'fixture.invalid', 'PEN', 'active', 40.05, now()) returning id into a;
    insert into public.products(list_id, url, domain, currency, status, last_price, last_success_at)
    values (l, 'https://fixture.invalid/b', 'fixture.invalid', 'PEN', 'paused', 60.05, now()) returning id into b;
    s := public.list_basket_summary(l);
    if (s->>'total')::numeric <> 100.10 or not (s->>'complete')::boolean or (s->>'valid_count')::int <> 2 then
        raise exception 'Decimal sum / paused inclusion';
    end if;
    select jsonb_agg(jsonb_build_object('id', id, 'state', alert_state, 'price', last_alert_price, 'at', last_alert_at) order by id)
    into before_state from public.products where list_id = l;
    select count(*) into events from public.claim_basket_events(l);
    if events <> 1 then raise exception 'Exact boundary did not claim'; end if;
    if (select count(*) from public.claim_basket_events(l)) <> 0 then raise exception 'Duplicate claim'; end if;
    perform public.configure_list_basket(l, 100.10, 'PEN');
    if (select count(*) from public.claim_basket_events(l)) <> 0 then raise exception 'Unchanged budget rearmed'; end if;
    update public.products set currency = 'USD' where id = b;
    s := public.list_basket_summary(l);
    if (s->>'complete')::boolean or (s->>'total')::numeric <> 40.05 then raise exception 'Mixed currencies summed'; end if;
    if (select count(*) from public.claim_basket_events(l)) <> 0 then raise exception 'Incomplete triggered'; end if;
    update public.products set currency = 'PEN' where id = b;
    if (select count(*) from public.claim_basket_events(l)) <> 0 then raise exception 'Incomplete rearmed'; end if;
    update public.products set last_price = 60.06 where id = b;
    perform public.claim_basket_events(l);
    update public.products set last_price = 60.05 where id = b;
    if (select count(*) from public.claim_basket_events(l)) <> 1 then raise exception 'Second crossing missing'; end if;
    update public.products set consecutive_failures = 1 where id = a;
    if (public.list_basket_summary(l)->>'complete')::boolean then raise exception 'Failed reading accepted'; end if;
    update public.products set consecutive_failures = 0, last_price = null where id = a;
    if (public.list_basket_summary(l)->>'complete')::boolean then raise exception 'Missing reading accepted'; end if;
    update public.products set last_price = 40.05, status = 'pending_confirmation' where id = a;
    if (public.list_basket_summary(l)->>'complete')::boolean then raise exception 'Pending product accepted'; end if;
    update public.products set status = 'active' where id = a;
    if before_state <> (select jsonb_agg(jsonb_build_object('id', id, 'state', alert_state, 'price', last_alert_price, 'at', last_alert_at) order by id) from public.products where list_id = l) then
        raise exception 'Individual alert state changed';
    end if;
    perform public.configure_list_basket(l, null, null);
    if public.list_basket_summary(l) is not null or (select count(*) from public.claim_basket_events(l)) <> 0 then
        raise exception 'Disabled basket claimed';
    end if;
    begin
        perform public.configure_list_basket(l, 0, 'PEN');
        raise exception 'Invalid budget accepted';
    exception when sqlstate 'PT400' then null; end;
    begin
        perform public.configure_list_basket(l, 1.001, 'PEN');
        raise exception 'Fractional cent accepted';
    exception when sqlstate 'PT400' then null; end;
    begin
        perform public.configure_list_basket(l, null, 'PEN');
        raise exception 'Partial configuration accepted';
    exception when sqlstate 'PT400' then null; end;
end;
$$;
reset role;
