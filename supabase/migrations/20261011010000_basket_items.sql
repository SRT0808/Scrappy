begin;

-- Membership belongs to a basket line, never to the individual tracker.
lock table public.lists, public.products in access exclusive mode;

create table public.basket_items (
    id uuid primary key default gen_random_uuid(),
    list_id uuid not null references public.lists(id) on delete cascade,
    product_id uuid not null references public.products(id) on delete cascade,
    quantity integer not null default 1 check (quantity > 0),
    position integer not null default 0 check (position >= 0),
    created_at timestamptz not null default now(),
    unique (list_id, product_id)
);
create index basket_items_product_id_idx on public.basket_items(product_id);
alter table public.basket_items enable row level security;
revoke all on public.basket_items from public, anon, authenticated;
grant all on public.basket_items to service_role;

-- The old model had no per-product position; retain its chronological order.
insert into public.basket_items(list_id, product_id, position, created_at)
select list_id, id,
    (row_number() over (partition by list_id order by created_at, id) - 1)::integer,
    created_at
from public.products;

alter table public.products drop column list_id;
-- Preserve configured budgets/currencies; unconfigured baskets default to PEN.
alter table public.lists drop constraint basket_configuration;
alter table public.lists rename column basket_budget to budget;
alter table public.lists rename column basket_currency to currency;
update public.lists set currency = 'PEN' where currency is null;
alter table public.lists alter column currency set default 'PEN';
alter table public.lists alter column currency set not null;

create or replace function public.list_basket_summary(p_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$
    select jsonb_build_object(
        'budget', l.budget, 'currency', l.currency,
        'total', coalesce(sum(p.last_price * i.quantity) filter (where
            p.currency = l.currency and p.last_price > 0
            and p.last_success_at is not null and p.consecutive_failures = 0
            and p.status in ('active', 'paused')), 0),
        'product_count', count(p.id),
        'valid_count', count(p.id) filter (where
            p.currency = l.currency and p.last_price > 0
            and p.last_success_at is not null and p.consecutive_failures = 0
            and p.status in ('active', 'paused')),
        'complete', count(p.id) > 0 and count(p.id) = count(p.id) filter (where
            p.currency = l.currency and p.last_price > 0
            and p.last_success_at is not null and p.consecutive_failures = 0
            and p.status in ('active', 'paused'))
    ) from public.lists l left join public.basket_items i on i.list_id = l.id
    left join public.products p on p.id = i.product_id
    where l.id = p_id and l.budget is not null group by l.id;
$$;

create or replace function public.read_lists_with_baskets()
returns jsonb language sql stable security invoker set search_path = ''
as $$
    select coalesce(jsonb_agg((to_jsonb(l) - 'basket_reached')
        || jsonb_build_object('basket', public.list_basket_summary(l.id))
        order by l.position, l.created_at, l.id), '[]'::jsonb) from public.lists l;
$$;

create or replace function public.configure_list_basket(p_id uuid, p_budget numeric, p_currency text)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare v_list public.lists;
begin
    if (p_budget is null) <> (p_currency is null) or
       (p_budget is not null and (p_budget <= 0 or p_budget > 9999999999.99
        or p_budget <> round(p_budget, 2) or p_currency !~ '^[A-Z]{3}$')) then
        raise sqlstate 'PT400' using message = 'Invalid basket configuration';
    end if;
    update public.lists set budget = p_budget, currency = coalesce(p_currency, 'PEN'),
        basket_reached = case when budget is distinct from p_budget
            or currency is distinct from p_currency then false else basket_reached end
    where id = p_id returning * into v_list;
    if not found then raise sqlstate 'PT404' using message = 'List not found'; end if;
    return (to_jsonb(v_list) - 'basket_reached')
        || jsonb_build_object('basket', public.list_basket_summary(p_id));
end;
$$;

create or replace function public.claim_basket_events(p_list_id uuid default null)
returns setof public.basket_events language plpgsql security invoker set search_path = ''
as $$
declare v_list public.lists; v_summary jsonb; v_event public.basket_events;
begin
    -- Deterministic row locks serialize aggregate state independently of products.
    for v_list in select * from public.lists where budget is not null
        and (p_list_id is null or id = p_list_id) order by id for update loop
        v_summary := public.list_basket_summary(v_list.id);
        -- An incomplete basket never triggers or rearms from a misleading subtotal.
        if (v_summary->>'complete')::boolean then
            if (v_summary->>'total')::numeric > v_list.budget then
                update public.lists set basket_reached = false where id = v_list.id;
            elsif not v_list.basket_reached then
                update public.lists set basket_reached = true where id = v_list.id;
                insert into public.basket_events(list_id, name, budget, currency, total)
                values (v_list.id, v_list.name, v_list.budget, v_list.currency,
                    (v_summary->>'total')::numeric) returning * into v_event;
                return next v_event;
            end if;
        end if;
    end loop;
end;
$$;

create or replace function public.confirm_product_reading(p_id uuid, p_confirmation jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_row public.product_readings;
    v_choice jsonb;
    v_index integer;
    v_price numeric;
    v_reference numeric;
    v_target numeric;
    v_currency text;
    v_list uuid;
    v_product uuid;
    v_selector text;
begin
    select * into v_row from public.product_readings where id = p_id for update;
    if not found then raise sqlstate 'PT404' using message = 'Reading not found'; end if;
    -- Replays return the original product, even if the caller changed its form.
    if v_row.status = 'confirmed' and v_row.product_id is not null then
        return to_jsonb(v_row) - array['recipe','selector','domain','updated_at'];
    end if;
    if v_row.status <> 'ready' then raise sqlstate 'PT409' using message = 'Reading not ready'; end if;
    if jsonb_typeof(p_confirmation) is distinct from 'object'
       or coalesce(length(btrim(p_confirmation->>'name')),0) not between 1 and 300
       or coalesce(p_confirmation->>'currency','') !~ '^[A-Z]{3}$'
       or coalesce(p_confirmation->>'reference_price','') !~ '^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$'
       or coalesce(p_confirmation->>'target_value','') !~ '^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$'
       or coalesce(p_confirmation->>'target_type','') not in ('price','percent')
       or coalesce(p_confirmation->>'check_interval_hours','') not in ('3','6','12','24') then
        raise sqlstate 'PT400' using message = 'Invalid confirmation';
    end if;
    begin
        v_list := (p_confirmation->>'list_id')::uuid;
        v_index := (p_confirmation->>'candidate_index')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
        raise sqlstate 'PT400' using message = 'Invalid confirmation IDs';
    end;
    if v_index is not null then
        if v_index < 0 or v_index >= jsonb_array_length(v_row.result->'candidates') then
            raise sqlstate 'PT400' using message = 'Invalid candidate';
        end if;
        v_choice := v_row.result->'candidates'->v_index;
    else
        if coalesce((v_row.result->>'confidence')::numeric,0) < 0.8 and jsonb_array_length(v_row.result->'candidates') > 0 then
            raise sqlstate 'PT400' using message = 'Choose an ambiguous candidate';
        end if;
        v_choice := v_row.result;
    end if;
    if coalesce(v_choice->>'price','') !~ '^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$' then
        raise sqlstate 'PT400' using message = 'No readable price';
    end if;
    v_currency := p_confirmation->>'currency';
    if v_choice->>'currency' is not null and v_choice->>'currency' <> v_currency then
        raise sqlstate 'PT400' using message = 'Currency mismatch';
    end if;
    v_price := (v_choice->>'price')::numeric;
    v_reference := (p_confirmation->>'reference_price')::numeric;
    v_target := (p_confirmation->>'target_value')::numeric;
    if v_price <= 0 or v_reference <= 0
       or (p_confirmation->>'target_type' = 'percent' and (v_target <= 0 or v_target > 100)) then
        raise sqlstate 'PT400' using message = 'Invalid price or target';
    end if;
    if v_list is not null then
        perform 1 from public.lists where id = v_list for key share;
        if not found then raise sqlstate 'PT404' using message = 'List not found'; end if;
    end if;
    insert into public.products(url,domain,name,image_url,currency,reference_price,target_type,
      target_price,target_percent,check_interval_hours,status,last_price,last_checked_at,last_success_at,last_method)
    values(v_row.url,v_row.domain,btrim(p_confirmation->>'name'),v_row.result->>'image_url',v_currency,
      v_reference,p_confirmation->>'target_type',
      case when p_confirmation->>'target_type' = 'price' then v_target else round(v_reference*(1-v_target/100),2) end,
      case when p_confirmation->>'target_type' = 'percent' then v_target else null end,
      (p_confirmation->>'check_interval_hours')::integer,'active',v_price,v_row.updated_at,v_row.updated_at,v_row.result->>'method')
    returning id into v_product;
    if v_list is not null then
        insert into public.basket_items(list_id, product_id, position)
        select v_list, v_product, coalesce(max(position) + 1, 0)
        from public.basket_items where list_id = v_list;
    end if;
    insert into public.price_checks(product_id,checked_at,ok,price,currency,method,confidence,warnings)
    values(v_product,v_row.updated_at,true,v_price,v_currency,v_row.result->>'method',v_row.result->>'confidence',
      coalesce(v_row.result->'warnings','[]'::jsonb) || '["Precio confirmado por el dueño."]'::jsonb);
    v_selector := coalesce(v_choice->>'selector',v_row.selector);
    -- Preserve fingerprints for other URLs when learning this confirmed selection.
    insert into public.domain_recipes(domain,fetch_mode,price_selector,adaptive_state)
    values(v_row.domain,coalesce(v_row.recipe->>'fetch_mode','http'),v_selector,
      jsonb_build_object('version','0.4.15','elements',coalesce(v_row.recipe->'adaptive_state'->'elements','{}'::jsonb),
        'confirmed_candidates',jsonb_build_object(v_row.url,jsonb_build_object('name',v_choice->>'name','currency',v_currency,
          'selector',v_selector,'match_index',v_choice->'match_index','match_count',v_choice->'match_count'))))
    on conflict (domain) do update set
      fetch_mode = excluded.fetch_mode,
      price_selector = coalesce(excluded.price_selector,public.domain_recipes.price_selector),
      adaptive_state = coalesce(public.domain_recipes.adaptive_state,'{}'::jsonb) ||
        jsonb_build_object('version','0.4.15',
          'elements',coalesce(public.domain_recipes.adaptive_state->'elements','{}'::jsonb) || (excluded.adaptive_state->'elements'),
          'confirmed_candidates',coalesce(public.domain_recipes.adaptive_state->'confirmed_candidates','{}'::jsonb) || (excluded.adaptive_state->'confirmed_candidates')),
      updated_at = now();
    update public.product_readings set status = 'confirmed', product_id = v_product, updated_at = now()
    where id = p_id returning * into v_row;
    return to_jsonb(v_row) - array['recipe','selector','domain','updated_at'];
end $$;


notify pgrst, 'reload schema';
commit;
