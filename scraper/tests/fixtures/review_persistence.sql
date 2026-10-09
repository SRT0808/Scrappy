-- Installed functions are tested inside a transaction that rolls back fixture data.
do $$
declare
    list_id uuid;
    product_id uuid;
    interval_hours integer;
    t timestamptz := '2026-10-08T12:00:00Z';
    row public.products;
    checks jsonb;
    previous_count integer;
begin
    assert not has_function_privilege('anon', 'public.due_products(timestamptz,uuid)', 'EXECUTE');
    assert not has_function_privilege('authenticated', 'public.save_review(uuid,timestamptz,timestamptz,boolean,jsonb)', 'EXECUTE');
    assert has_function_privilege('service_role', 'public.save_review(uuid,timestamptz,timestamptz,boolean,jsonb)', 'EXECUTE');
    insert into public.lists(name) values ('Transactional review test') returning id into list_id;
    foreach interval_hours in array array[3, 6, 12, 24] loop
        insert into public.products(list_id, url, domain, currency, status, check_interval_hours, last_checked_at,
                                    last_price, last_success_at, last_method, consecutive_failures)
        values (list_id, 'https://review-test.invalid/product', 'review-test.invalid', 'PEN', 'active', interval_hours,
                t - make_interval(hours => interval_hours), 100, t - interval '1 day', 'json_ld', 2)
        returning id into product_id;
        assert not exists(select 1 from public.due_products(t - interval '1 microsecond') where id = product_id);
        assert exists(select 1 from public.due_products(t) where id = product_id);
        assert exists(select 1 from public.due_products(t + interval '1 microsecond') where id = product_id);
        assert exists(select 1 from public.due_products(t - interval '1 hour', product_id));
    end loop;
    update public.products set last_checked_at = null where id = product_id;
    assert exists(select 1 from public.due_products(t) where id = product_id);
    update public.products set status = 'paused' where id = product_id;
    assert not exists(select 1 from public.due_products(t, product_id));
    update public.products set status = 'pending_confirmation' where id = product_id;
    assert not exists(select 1 from public.due_products(t) where id = product_id);
    update public.products set status = 'error' where id = product_id;
    assert exists(select 1 from public.due_products(t) where id = product_id);
    update public.products set status = 'active' where id = product_id;

    checks := jsonb_build_array(jsonb_build_object('checked_at', t, 'ok', false, 'price', '40.00',
        'currency', 'USD', 'method', 'meta', 'confidence', '1.0', 'error_code', 'currency_mismatch', 'warnings', '[]'::jsonb));
    perform public.save_review(product_id, null, t, false, checks);
    select * into row from public.products where id = product_id;
    assert row.last_price = 100 and row.last_checked_at = t;
    assert row.last_success_at = t - interval '1 day' and row.last_method = 'json_ld';
    assert row.status = 'error';
    assert row.consecutive_failures = 3 and row.alert_state = 'armed' and row.last_alert_price is null;
    assert (select count(*) = 1 from public.price_checks where price_checks.product_id = row.id and not ok and price = 40);

    checks := jsonb_build_array(jsonb_build_object('checked_at', t + interval '3 hours', 'ok', true,
        'price', '40.00', 'currency', 'PEN', 'method', 'meta', 'confidence', '1.0', 'warnings', '[]'::jsonb));
    checks := checks || checks;
    perform public.save_review(product_id, t, t + interval '3 hours', true, checks);
    select * into row from public.products where id = product_id;
    assert row.status = 'active';
    assert row.last_price = 40 and row.last_method = 'meta' and row.consecutive_failures = 0;
    assert row.last_success_at = t + interval '3 hours';
    assert (select count(*) = 3 from public.price_checks where price_checks.product_id = row.id);

    -- Stale writers cannot append history or overwrite newer state.
    begin
        perform public.save_review(product_id, t, t + interval '6 hours', true, checks);
        raise exception 'Expected stale writer rejection';
    exception when raise_exception then
        assert sqlerrm = 'El producto cambió durante la revisión.';
    end;
    assert (select count(*) = 3 from public.price_checks where price_checks.product_id = row.id);

    -- A bad second history row rolls back the entire RPC, including the first.
    previous_count := (select count(*) from public.price_checks where price_checks.product_id = row.id);
    checks := jsonb_set(checks, '{1,currency}', '"bad-currency"'::jsonb);
    begin
        perform public.save_review(product_id, row.last_checked_at, t + interval '6 hours', false,
            jsonb_set(checks, '{1,ok}', 'false'::jsonb));
        raise exception 'Expected constraint rejection';
    exception when check_violation then
        null;
    end;
    assert (select count(*) = previous_count from public.price_checks where price_checks.product_id = row.id);
    assert (select last_price = 40 and last_checked_at = t + interval '3 hours'
            from public.products where id = product_id);
end;
$$;
