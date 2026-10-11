begin;

create function public.read_basket_detail(p_id uuid, p_days integer default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_result jsonb;
begin
    if p_days is not null and p_days not in (7,14,30,90) then
        raise sqlstate 'PT400' using message = 'Invalid history range';
    end if;
    select jsonb_build_object('id', l.id, 'name', l.name, 'basket', public.list_basket_summary(l.id),
        'versions', (select coalesce(jsonb_agg(v order by v desc), '[]'::jsonb) from
            (select distinct composition_version as v from public.basket_snapshots where list_id = p_id
             union select l.composition_version) versions),
        'snapshots', (select coalesce(jsonb_agg(to_jsonb(s) order by calculated_at, id), '[]'::jsonb)
            from public.basket_snapshots s where list_id = p_id
            and (p_days is null or calculated_at >= statement_timestamp() - make_interval(days => p_days))))
    into v_result from public.lists l where l.id = p_id;
    if v_result is null then raise sqlstate 'PT404' using message = 'Basket not found'; end if;
    return v_result;
end $$;

-- A stale editor cannot overwrite a newer basket composition.
create function public.set_basket_item(p_id uuid, p_product_id uuid, p_quantity integer, p_version bigint)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_version bigint;
begin
    if p_version is null or p_quantity is not null and p_quantity <= 0 then
        raise sqlstate 'PT400' using message = 'Invalid quantity or version';
    end if;
    select composition_version into v_version from public.lists where id = p_id for update;
    if not found then raise sqlstate 'PT404' using message = 'Basket not found'; end if;
    if v_version <> p_version then raise sqlstate 'PT409' using message = 'Composition changed'; end if;
    if p_quantity is null then
        delete from public.basket_items where list_id = p_id and product_id = p_product_id;
    else
        perform 1 from public.products where id = p_product_id for key share;
        if not found then raise sqlstate 'PT404' using message = 'Product not found'; end if;
        insert into public.basket_items(list_id,product_id,quantity,position)
        select p_id,p_product_id,p_quantity,coalesce(max(position)+1,0) from public.basket_items where list_id=p_id
        on conflict (list_id,product_id) do update set quantity=excluded.quantity
        where public.basket_items.quantity is distinct from excluded.quantity;
    end if;
    return public.read_basket_detail(p_id);
end $$;
revoke all on function public.read_basket_detail(uuid,integer), public.set_basket_item(uuid,uuid,integer,bigint)
    from public, anon, authenticated;
grant execute on function public.read_basket_detail(uuid,integer), public.set_basket_item(uuid,uuid,integer,bigint) to service_role;
notify pgrst, 'reload schema';
commit;
