set local role service_role;
do $$
declare
    v_a uuid;
    v_b uuid;
    v_product uuid;
    v_ids uuid[];
    v_reversed uuid[];
    v_before jsonb;
    v_result jsonb;
    v_position integer;
begin
    if has_function_privilege('anon', 'public.mutate_list(text,uuid,text,text,boolean,uuid[])', 'EXECUTE')
       or has_function_privilege('authenticated', 'public.mutate_list(text,uuid,text,text,boolean,uuid[])', 'EXECUTE') then
        raise exception 'Public RPC permissions';
    end if;
    if (select prosecdef from pg_proc where oid = 'public.mutate_list(text,uuid,text,text,boolean,uuid[])'::regprocedure) then
        raise exception 'Must use invoker security';
    end if;
    if not (select relrowsecurity from pg_class where oid = 'public.lists'::regclass)
       or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'lists') then
        raise exception 'Invalid list RLS';
    end if;
    select coalesce(max(position) + 1, 0) into v_position from public.lists;
    v_result := public.mutate_list('create', p_name => ' SQL fixture A ', p_emoji => '📱');
    v_a := (v_result->>'id')::uuid;
    if v_result->>'name' <> 'SQL fixture A' or (v_result->>'position')::integer <> v_position then
        raise exception 'Create failed';
    end if;
    v_b := (public.mutate_list('create', p_name => 'SQL fixture B')->>'id')::uuid;
    if (select position from public.lists where id = v_b) <> v_position + 1 then raise exception 'Append failed'; end if;
    v_result := public.mutate_list('rename', v_a, 'Renamed');
    if v_result->>'name' <> 'Renamed' or v_result->>'emoji' <> '📱' then raise exception 'Rename failed'; end if;
    v_result := public.mutate_list('rename', v_a, 'Renamed', null, true);
    if v_result->>'emoji' is not null then raise exception 'Emoji clear failed'; end if;
    select array_agg(id order by position, created_at, id), jsonb_agg(to_jsonb(l) order by id)
    into v_ids, v_before from public.lists l;
    for v_reversed in select invalid.ids from (values (v_ids || v_a), (array[v_a]), (array[gen_random_uuid()])) as invalid(ids) loop
        begin
            perform public.mutate_list('reorder', p_ids => v_reversed);
            raise exception 'Invalid order accepted';
        exception when sqlstate 'PT400' or sqlstate 'PT409' then null;
        end;
    end loop;
    if (select jsonb_agg(to_jsonb(l) order by id) from public.lists l) <> v_before then
        raise exception 'Rejected order changed data';
    end if;
    select array_agg(id order by position desc, created_at desc, id desc) into v_reversed from public.lists;
    v_result := public.mutate_list('reorder', p_ids => v_reversed);
    if (select array_agg(id order by position) from public.lists) <> v_reversed
       or (select min(position) from public.lists) <> 0
       or (select max(position) from public.lists) <> cardinality(v_reversed) - 1 then
        raise exception 'Reorder failed';
    end if;
    insert into public.products(list_id, url, domain) values (v_a, 'https://fixture.invalid/list', 'fixture.invalid') returning id into v_product;
    begin
        perform public.mutate_list('delete', v_a);
        raise exception 'Nonempty deletion accepted';
    exception when foreign_key_violation then null;
    end;
    if not exists (select 1 from public.lists where id = v_a)
       or not exists (select 1 from public.products where id = v_product) then raise exception 'Product lost'; end if;
    perform public.mutate_list('delete', v_b);
    if exists (select 1 from public.lists where id = v_b)
       or (select max(position) from public.lists) <> (select count(*) - 1 from public.lists) then
        raise exception 'Delete/compact failed';
    end if;
    begin
        perform public.mutate_list('delete', v_b);
        raise exception 'Missing list accepted';
    exception when sqlstate 'PT404' then null;
    end;
    begin
        perform public.mutate_list('rename', v_b, 'Missing');
        raise exception 'Missing rename accepted';
    exception when sqlstate 'PT404' then null;
    end;
    begin
        perform public.mutate_list('create', p_name => ' ');
        raise exception 'Blank name accepted';
    exception when sqlstate 'PT400' then null;
    end;
    begin
        perform public.mutate_list('reorder', p_ids => array[null::uuid]);
        raise exception 'Null ID accepted';
    exception when sqlstate 'PT400' then null;
    end;
end;
$$;
reset role;
set local role anon;
do $$
begin
    begin
        perform public.mutate_list('create', p_name => 'Denied');
        raise exception 'Anonymous write allowed';
    exception when insufficient_privilege then null;
    end;
    begin
        perform 1 from public.lists;
        raise exception 'Anonymous read allowed';
    exception when insufficient_privilege then null;
    end;
end;
$$;
reset role;
