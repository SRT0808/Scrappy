begin;

alter table public.lists
    add column basket_budget numeric(12,2) check (basket_budget > 0 and basket_budget <= 9999999999.99),
    add column basket_currency text check (basket_currency ~ '^[A-Z]{3}$'),
    add column basket_reached boolean not null default false,
    add constraint basket_configuration check ((basket_budget is null) = (basket_currency is null));

-- A claim is durable before network delivery: overlapping runs cannot send twice.
create table public.basket_events (
    id uuid primary key default gen_random_uuid(),
    list_id uuid references public.lists(id) on delete set null,
    name text not null,
    budget numeric(12,2) not null,
    currency text not null,
    total numeric not null,
    status text not null default 'claimed' check (status in ('claimed', 'sent', 'failed')),
    created_at timestamptz not null default now()
);
alter table public.basket_events enable row level security;
revoke all on public.basket_events from anon, authenticated;
grant all on public.basket_events to service_role;

create function public.list_basket_summary(p_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$
    select jsonb_build_object(
        'budget', l.basket_budget, 'currency', l.basket_currency,
        'total', coalesce(sum(p.last_price) filter (where
            p.currency = l.basket_currency and p.last_price > 0
            and p.last_success_at is not null and p.consecutive_failures = 0
            and p.status in ('active', 'paused')), 0),
        'product_count', count(p.id),
        'valid_count', count(p.id) filter (where
            p.currency = l.basket_currency and p.last_price > 0
            and p.last_success_at is not null and p.consecutive_failures = 0
            and p.status in ('active', 'paused')),
        'complete', count(p.id) > 0 and count(p.id) = count(p.id) filter (where
            p.currency = l.basket_currency and p.last_price > 0
            and p.last_success_at is not null and p.consecutive_failures = 0
            and p.status in ('active', 'paused'))
    ) from public.lists l left join public.products p on p.list_id = l.id
    where l.id = p_id and l.basket_budget is not null group by l.id;
$$;

create function public.read_lists_with_baskets()
returns jsonb language sql stable security invoker set search_path = ''
as $$
    select coalesce(jsonb_agg((to_jsonb(l) - 'basket_reached' - 'basket_budget' - 'basket_currency')
        || jsonb_build_object('basket', public.list_basket_summary(l.id))
        order by l.position, l.created_at, l.id), '[]'::jsonb) from public.lists l;
$$;

create function public.configure_list_basket(p_id uuid, p_budget numeric, p_currency text)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare v_list public.lists;
begin
    if (p_budget is null) <> (p_currency is null) or
       (p_budget is not null and (p_budget <= 0 or p_budget > 9999999999.99
        or p_budget <> round(p_budget, 2) or p_currency !~ '^[A-Z]{3}$')) then
        raise sqlstate 'PT400' using message = 'Invalid basket configuration';
    end if;
    update public.lists set basket_budget = p_budget, basket_currency = p_currency,
        basket_reached = case when basket_budget is distinct from p_budget
            or basket_currency is distinct from p_currency then false else basket_reached end
    where id = p_id returning * into v_list;
    if not found then raise sqlstate 'PT404' using message = 'List not found'; end if;
    return (to_jsonb(v_list) - 'basket_reached' - 'basket_budget' - 'basket_currency')
        || jsonb_build_object('basket', public.list_basket_summary(p_id));
end;
$$;

create function public.claim_basket_events(p_list_id uuid default null)
returns setof public.basket_events language plpgsql security invoker set search_path = ''
as $$
declare v_list public.lists; v_summary jsonb; v_event public.basket_events;
begin
    -- Deterministic row locks serialize aggregate state independently of products.
    for v_list in select * from public.lists where basket_budget is not null
        and (p_list_id is null or id = p_list_id) order by id for update loop
        v_summary := public.list_basket_summary(v_list.id);
        -- An incomplete basket never triggers or rearms from a misleading subtotal.
        if (v_summary->>'complete')::boolean then
            if (v_summary->>'total')::numeric > v_list.basket_budget then
                update public.lists set basket_reached = false where id = v_list.id;
            elsif not v_list.basket_reached then
                update public.lists set basket_reached = true where id = v_list.id;
                insert into public.basket_events(list_id, name, budget, currency, total)
                values (v_list.id, v_list.name, v_list.basket_budget, v_list.basket_currency,
                    (v_summary->>'total')::numeric) returning * into v_event;
                return next v_event;
            end if;
        end if;
    end loop;
end;
$$;

revoke all on function public.list_basket_summary(uuid), public.read_lists_with_baskets(),
    public.configure_list_basket(uuid,numeric,text), public.claim_basket_events(uuid) from public, anon, authenticated;
grant execute on function public.list_basket_summary(uuid), public.read_lists_with_baskets(),
    public.configure_list_basket(uuid,numeric,text), public.claim_basket_events(uuid) to service_role;

notify pgrst, 'reload schema';
commit;
