do $$
declare
    v_ip inet := '2001:db8::5c:1234';
    v_retry integer;
    v_count integer;
    v_invalid inet;
begin
    delete from public.login_attempts where ip in (v_ip, '2001:db8::5c:1235'::inet);
    if has_function_privilege('anon', 'public.record_login_attempt(inet,boolean)', 'EXECUTE')
       or has_function_privilege('authenticated', 'public.record_login_attempt(inet,boolean)', 'EXECUTE')
       or not has_function_privilege('service_role', 'public.record_login_attempt(inet,boolean)', 'EXECUTE') then
        raise exception 'Invalid RPC permissions';
    end if;
    if not (select relrowsecurity from pg_class where oid = 'public.login_attempts'::regclass) then
        raise exception 'Login attempt RLS is disabled';
    end if;
    if (select prosecdef from pg_proc where oid = 'public.record_login_attempt(inet,boolean)'::regprocedure) then
        raise exception 'RPC must use invoker permissions';
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'login_attempts') then
        raise exception 'Login attempts must have no public policies';
    end if;
    foreach v_invalid in array array[null::inet, '192.0.2.0/24'::inet, '2001:db8::/64'::inet] loop
        begin
            perform public.record_login_attempt(v_invalid, false);
            raise exception 'Invalid IP was accepted';
        exception when raise_exception then
            if sqlerrm <> 'Invalid login attempt' then raise; end if;
        end;
    end loop;
    begin
        perform public.record_login_attempt(v_ip, null);
        raise exception 'Null success was accepted';
    exception when raise_exception then
        if sqlerrm <> 'Invalid login attempt' then raise; end if;
    end;
    for i in 1..5 loop
        if public.record_login_attempt(v_ip, i = 5) <> 0 then
            raise exception 'Blocked before the fifth attempt';
        end if;
    end loop;
    v_retry := public.record_login_attempt(v_ip, true);
    if v_retry not between 899 and 900 then raise exception 'Sixth attempt not blocked'; end if;
    select count(*) into v_count from public.login_attempts where ip = v_ip;
    if v_count <> 5 then raise exception 'Blocked attempt was inserted'; end if;
    if (select count(*) from public.login_attempts where ip = v_ip and success) <> 1 then
        raise exception 'Success flag not recorded';
    end if;
    if public.record_login_attempt('2001:db8::5c:1235', false) <> 0 then
        raise exception 'Different IP incorrectly blocked';
    end if;
    update public.login_attempts set attempted_at = clock_timestamp() - interval '15 minutes' where ip = v_ip;
    if public.record_login_attempt(v_ip, false) <> 0 then raise exception 'Window boundary blocked'; end if;
    update public.login_attempts set attempted_at = clock_timestamp() - interval '2 days' where ip = v_ip;
    perform public.record_login_attempt(v_ip, false);
    select count(*) into v_count from public.login_attempts where ip = v_ip;
    if v_count <> 1 then raise exception 'Old IP records not pruned'; end if;
end;
$$;

-- Execute with the same privileges as the API (invoker security and RLS).
set local role service_role;
delete from public.login_attempts where ip = '192.0.2.234';
do $$
begin
    if public.record_login_attempt('192.0.2.234', false) <> 0 then
        raise exception 'Service role cannot record attempts';
    end if;
end;
$$;
reset role;

-- Verify denial by executing as each public role, not only inspecting ACLs.
set local role anon;
do $$
begin
    begin
        perform public.record_login_attempt('192.0.2.234', false);
        raise exception 'Anonymous RPC call was allowed';
    exception when insufficient_privilege then null;
    end;
    begin
        perform 1 from public.login_attempts;
        raise exception 'Anonymous table access was allowed';
    exception when insufficient_privilege then null;
    end;
end;
$$;
reset role;
set local role authenticated;
do $$
begin
    begin
        perform public.record_login_attempt('192.0.2.234', false);
        raise exception 'Authenticated RPC call was allowed';
    exception when insufficient_privilege then null;
    end;
    begin
        insert into public.login_attempts values ('192.0.2.234', clock_timestamp(), false);
        raise exception 'Authenticated table write was allowed';
    exception when insufficient_privilege then null;
    end;
end;
$$;
reset role;
