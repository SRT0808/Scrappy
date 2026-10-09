begin;

create function public.mutate_list(
    p_operation text, p_id uuid default null, p_name text default null,
    p_emoji text default null, p_set_emoji boolean default false, p_ids uuid[] default null
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
    v_list public.lists;
    v_result jsonb;
begin
    if p_operation is null or p_operation not in ('create', 'rename', 'reorder', 'delete') then
        raise sqlstate 'PT400' using message = 'Invalid list operation';
    end if;
    if p_operation in ('create', 'rename') and
       (p_name is null or length(btrim(p_name)) not between 1 and 100 or length(p_emoji) > 16) then
        raise sqlstate 'PT400' using message = 'Invalid list fields';
    end if;
    -- Also serialize direct table writes; reads remain available.
    lock table public.lists in share row exclusive mode;
    if p_operation = 'create' then
        insert into public.lists(name, emoji, position)
        select btrim(p_name), p_emoji, coalesce(max(position) + 1, 0) from public.lists
        returning * into v_list;
        return to_jsonb(v_list);
    elsif p_operation = 'rename' then
        update public.lists set name = btrim(p_name),
            emoji = case when p_set_emoji then p_emoji else emoji end
        where id = p_id returning * into v_list;
        if not found then raise sqlstate 'PT404' using message = 'List not found'; end if;
        return to_jsonb(v_list);
    elsif p_operation = 'delete' then
        -- The existing foreign key rejects nonempty lists without deleting products.
        delete from public.lists where id = p_id;
        if not found then raise sqlstate 'PT404' using message = 'List not found'; end if;
        with ordered as (
            select id, (row_number() over (order by position, created_at, id) - 1)::integer as position
            from public.lists
        ) update public.lists l set position = o.position from ordered o where l.id = o.id;
        return 'null'::jsonb;
    end if;
    if p_ids is null or cardinality(p_ids) <> (select count(distinct id) from unnest(p_ids) as x(id)) then
        raise sqlstate 'PT400' using message = 'Invalid list order';
    end if;
    if cardinality(p_ids) <> (select count(*) from public.lists)
       or exists (select 1 from unnest(p_ids) as x(id) where not exists (select 1 from public.lists l where l.id = x.id)) then
        raise sqlstate 'PT409' using message = 'List collection changed';
    end if;
    update public.lists l set position = (x.position - 1)::integer
    from unnest(p_ids) with ordinality as x(id, position) where l.id = x.id;
    select coalesce(jsonb_agg(to_jsonb(l) order by position, created_at, id), '[]'::jsonb)
    into v_result from public.lists l;
    return v_result;
end;
$$;

revoke all on function public.mutate_list(text, uuid, text, text, boolean, uuid[]) from public, anon, authenticated;
grant execute on function public.mutate_list(text, uuid, text, text, boolean, uuid[]) to service_role;

commit;
