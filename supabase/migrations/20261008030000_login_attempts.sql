begin;

-- Serialize check-and-insert across serverless instances for the same address.
create function public.record_login_attempt(p_ip inet, p_success boolean)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
    v_now timestamptz;
    v_count integer;
    v_oldest timestamptz;
begin
    if p_ip is null or p_success is null
       or masklen(p_ip) <> (case family(p_ip) when 4 then 32 else 128 end) then
        raise exception 'Invalid login attempt';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('scrappy:login:' || host(p_ip), 0));
    v_now := clock_timestamp();
    delete from public.login_attempts where ip = p_ip and attempted_at <= v_now - interval '1 day';
    select count(*), min(attempted_at) into v_count, v_oldest
    from public.login_attempts
    where ip = p_ip and attempted_at > v_now - interval '15 minutes';
    if v_count >= 5 then
        return greatest(1, ceil(extract(epoch from v_oldest + interval '15 minutes' - v_now))::integer);
    end if;
    insert into public.login_attempts(ip, attempted_at, success) values (p_ip, v_now, p_success);
    return 0;
end;
$$;

revoke all on function public.record_login_attempt(inet, boolean) from public, anon, authenticated;
grant execute on function public.record_login_attempt(inet, boolean) to service_role;

commit;
