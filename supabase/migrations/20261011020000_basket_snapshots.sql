begin;

alter table public.lists add column composition_version bigint not null default 1;
alter table public.products add column last_availability text;
alter table public.price_checks add column availability text;
update public.products p set last_availability = (
    -- Legacy reviews already recorded explicit stock suppression as a warning.
    select case when c.warnings @> '["Producto agotado; precio válido, alerta de meta bloqueada."]'::jsonb
        then 'OutOfStock' else c.availability end from public.price_checks c where c.product_id = p.id
    order by c.checked_at desc, c.id desc limit 1
);

create table public.exchange_rates (
    rate_date date primary key,
    from_currency text not null default 'USD' check (from_currency = 'USD'),
    to_currency text not null default 'PEN' check (to_currency = 'PEN'),
    rate numeric not null check (rate > 0 and rate < 1000),
    source text not null check (source = 'BCRPData:PD04638PD'),
    fetched_at timestamptz not null default now()
);
create table public.basket_snapshots (
    id uuid primary key default gen_random_uuid(),
    list_id uuid not null references public.lists(id) on delete cascade,
    composition_version bigint not null,
    calculated_at timestamptz not null,
    reference_total numeric,
    current_total numeric,
    savings numeric,
    savings_percent numeric,
    complete boolean not null,
    valid_count integer not null,
    item_count integer not null,
    stale_count integer not null,
    unavailable_count integer not null,
    missing_count integer not null,
    fx_missing_count integer not null,
    currency text not null,
    exchange_rates jsonb not null,
    lines jsonb not null
);
create index basket_snapshots_history_idx on public.basket_snapshots(list_id, composition_version, calculated_at);
alter table public.exchange_rates enable row level security;
alter table public.basket_snapshots enable row level security;
revoke all on public.exchange_rates, public.basket_snapshots from public, anon, authenticated;
grant all on public.exchange_rates, public.basket_snapshots to service_role;

-- Round only the final aggregate, never each converted unit or line.
create function public.basket_summary_at(p_id uuid, p_at timestamptz)
returns jsonb language sql stable security invoker set search_path = '' as $$
    with fx as (
        select * from public.exchange_rates
        where rate_date <= (p_at at time zone 'America/Lima')::date
        order by rate_date desc limit 1
    ), lines as (
        select i.id, i.product_id, i.quantity, i.position, p.currency,
            p.reference_price, p.last_price, p.last_success_at, p.last_checked_at,
            p.last_price > 0 and p.last_success_at is not null
                and p.status <> 'pending_confirmation' as confirmed,
            p.consecutive_failures > 0 or p.status = 'error' as stale,
            lower(regexp_replace(regexp_replace(coalesce(p.last_availability, ''), '^.*[/#]', ''),
                '[[:space:]_-]+', '', 'g')) in
                ('outofstock','soldout','discontinued','agotado','agotada','sinstock','nodisponible','oos') as unavailable,
            case when p.currency = l.currency then 1::numeric
                when p.currency = 'USD' and l.currency = 'PEN' then fx.rate
                when p.currency = 'PEN' and l.currency = 'USD' then 1 / fx.rate end as multiplier,
            p.currency = l.currency or (p.currency in ('USD','PEN') and l.currency in ('USD','PEN')
                and fx.rate_date >= (p_at at time zone 'America/Lima')::date - 5) as fx_valid,
            case when p.currency <> l.currency and p.currency in ('USD','PEN') and l.currency in ('USD','PEN')
                and fx.rate is not null then jsonb_build_object('from', p.currency, 'to', l.currency,
                    'rate', case when p.currency = 'USD' then fx.rate else 1 / fx.rate end,
                    'date', fx.rate_date, 'source', fx.source) end as conversion
        from public.basket_items i join public.products p on p.id = i.product_id
        join public.lists l on l.id = i.list_id left join fx on true where i.list_id = p_id
    ), measured as (
        select *, coalesce(confirmed and not stale and not unavailable and fx_valid, false) as valid
        from lines
    ), totals as (
        select count(*)::integer as item_count, count(*) filter (where valid)::integer as valid_count,
            count(*) filter (where stale)::integer as stale_count,
            count(*) filter (where unavailable)::integer as unavailable_count,
            count(*) filter (where not coalesce(confirmed, false))::integer as missing_count,
            count(*) filter (where not coalesce(fx_valid, false))::integer as fx_missing_count,
            case when count(*) > 0 and count(*) = count(reference_price * multiplier)
                then round(sum(reference_price * quantity * multiplier), 2) end as reference_total,
            round(sum(last_price * quantity * multiplier) filter (where confirmed), 2) as current_total,
            coalesce(jsonb_agg(distinct conversion) filter (where conversion is not null), '[]'::jsonb) as exchange_rates,
            coalesce(jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', quantity,
                'currency', currency, 'reference_price', reference_price,
                'last_price', case when confirmed then last_price end, 'last_success_at', last_success_at,
                'last_checked_at', last_checked_at, 'stale', stale, 'unavailable', unavailable,
                'valid', valid, 'conversion', conversion) order by position, id), '[]'::jsonb) as lines
        from measured
    ) select jsonb_build_object('budget', l.budget, 'currency', l.currency,
        'composition_version', l.composition_version, 'calculated_at', p_at,
        'reference_total', t.reference_total, 'current_total', t.current_total, 'total', t.current_total,
        'savings', case when t.missing_count = 0 then t.reference_total - t.current_total end,
        'savings_percent', case when t.missing_count = 0 and t.reference_total > 0
            then round((t.reference_total - t.current_total) / t.reference_total * 100, 2) end,
        'item_count', t.item_count, 'product_count', t.item_count, 'valid_count', t.valid_count,
        'stale_count', t.stale_count, 'unavailable_count', t.unavailable_count,
        'missing_count', t.missing_count, 'fx_missing_count', t.fx_missing_count,
        'complete', t.item_count > 0 and t.valid_count = t.item_count,
        'exchange_rates', t.exchange_rates, 'lines', t.lines)
    from public.lists l cross join totals t where l.id = p_id;
$$;
create or replace function public.list_basket_summary(p_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
    select public.basket_summary_at(p_id, statement_timestamp());
$$;

create function public.record_basket_snapshot(p_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare s jsonb;
begin
    -- Serialize versions and snapshots with configuration/membership changes.
    perform 1 from public.lists where id = p_id for update;
    if not found then return; end if;
    s := public.list_basket_summary(p_id);
    insert into public.basket_snapshots(list_id, composition_version, calculated_at,
        reference_total, current_total, savings, savings_percent, complete, valid_count, item_count,
        stale_count, unavailable_count, missing_count, fx_missing_count, currency, exchange_rates, lines)
    values(p_id, (s->>'composition_version')::bigint, (s->>'calculated_at')::timestamptz,
        (s->>'reference_total')::numeric, (s->>'current_total')::numeric,
        (s->>'savings')::numeric, (s->>'savings_percent')::numeric, (s->>'complete')::boolean,
        (s->>'valid_count')::integer, (s->>'item_count')::integer, (s->>'stale_count')::integer,
        (s->>'unavailable_count')::integer, (s->>'missing_count')::integer,
        (s->>'fx_missing_count')::integer, s->>'currency', s->'exchange_rates', s->'lines');
end;
$$;

create function public.snapshot_basket_change()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_id uuid;
begin
    if TG_TABLE_NAME = 'basket_items' then
        if TG_OP = 'UPDATE' and (new.list_id, new.product_id, new.quantity)
            is not distinct from (old.list_id, old.product_id, old.quantity) then return null; end if;
        for v_id in select distinct x from unnest(array[
            case when TG_OP <> 'INSERT' then old.list_id end,
            case when TG_OP <> 'DELETE' then new.list_id end]) x where x is not null order by x loop
            update public.lists set composition_version = composition_version + 1, basket_reached = false where id = v_id;
            perform public.record_basket_snapshot(v_id);
        end loop;
    elsif TG_TABLE_NAME = 'lists' then
        perform public.record_basket_snapshot(new.id);
    else
        for v_id in select list_id from public.basket_items where product_id = new.id order by list_id loop
            if (new.reference_price, new.currency) is distinct from (old.reference_price, old.currency) then
                update public.lists set composition_version = composition_version + 1, basket_reached = false where id = v_id;
            end if;
            perform public.record_basket_snapshot(v_id);
        end loop;
    end if;
    return null;
end;
$$;
create function public.version_basket_configuration()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
    if (new.currency, new.budget) is distinct from (old.currency, old.budget) then
        new.composition_version := old.composition_version + 1;
        new.basket_reached := false;
    end if;
    return new;
end;
$$;
create trigger basket_configuration_version before update of currency, budget on public.lists
    for each row execute function public.version_basket_configuration();
create trigger basket_configuration_snapshot after update of currency, budget on public.lists
    for each row when ((new.currency, new.budget) is distinct from (old.currency, old.budget))
    execute function public.snapshot_basket_change();
create trigger basket_item_snapshot after insert or update or delete on public.basket_items
    for each row execute function public.snapshot_basket_change();
create trigger basket_product_snapshot after update of last_checked_at, last_price, last_success_at,
    consecutive_failures, status, reference_price, currency, last_availability on public.products
    for each row execute function public.snapshot_basket_change();

create function public.snapshot_exchange_rate_change()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_id uuid;
begin
    if TG_OP = 'UPDATE' and (new.rate, new.rate_date, new.source)
        is not distinct from (old.rate, old.rate_date, old.source) then return null; end if;
    for v_id in select distinct l.id from public.lists l join public.basket_items i on i.list_id = l.id
        join public.products p on p.id = i.product_id
        where l.currency in ('USD','PEN') and p.currency in ('USD','PEN') and l.currency <> p.currency
        order by l.id loop
        perform public.record_basket_snapshot(v_id);
    end loop;
    return null;
end;
$$;
create trigger exchange_rate_snapshot after insert or update on public.exchange_rates
    for each row execute function public.snapshot_exchange_rate_change();

create function public.cache_exchange_rate(p_rate jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
begin
    if p_rate->>'from_currency' is distinct from 'USD'
        or p_rate->>'to_currency' is distinct from 'PEN'
        or p_rate->>'source' is distinct from 'BCRPData:PD04638PD'
        or p_rate->>'rate_date' is null or p_rate->>'rate' is null or p_rate->>'fetched_at' is null
        or (p_rate->>'rate_date')::date > (statement_timestamp() at time zone 'America/Lima')::date then
        raise sqlstate 'PT400' using message = 'Invalid reference exchange rate';
    end if;
    insert into public.exchange_rates(rate_date, rate, source, fetched_at)
    values ((p_rate->>'rate_date')::date, (p_rate->>'rate')::numeric,
        p_rate->>'source', (p_rate->>'fetched_at')::timestamptz)
    on conflict (rate_date) do update set rate = excluded.rate, fetched_at = excluded.fetched_at
        where excluded.fetched_at > public.exchange_rates.fetched_at;
end;
$$;

-- No initial synthetic observations: bootstrap only aggregate state.
do $$ declare v_id uuid; begin
    for v_id in select id from public.lists order by id loop
        perform public.record_basket_snapshot(v_id);
    end loop;
end $$;

revoke all on function public.basket_summary_at(uuid,timestamptz), public.record_basket_snapshot(uuid),
    public.snapshot_basket_change(), public.version_basket_configuration(), public.snapshot_exchange_rate_change(), public.cache_exchange_rate(jsonb)
    from public, anon, authenticated;
grant execute on function public.basket_summary_at(uuid,timestamptz), public.record_basket_snapshot(uuid),
    public.snapshot_basket_change(), public.version_basket_configuration(), public.snapshot_exchange_rate_change(), public.cache_exchange_rate(jsonb)
    to service_role;

create or replace function public.save_review(
    p_product_id uuid, p_expected_checked_at timestamptz,
    p_checked_at timestamptz, p_accepted boolean, p_checks jsonb
)
returns void
language plpgsql security invoker set search_path = ''
as $$
declare
    product public.products;
    final_check jsonb;
begin
    select * into strict product from public.products where id = p_product_id for update;
    if product.status not in ('active', 'error')
       or product.last_checked_at is distinct from p_expected_checked_at then
        raise exception 'El producto cambió durante la revisión.';
    end if;
    if p_checked_at is null or p_accepted is null
       or (product.last_checked_at is not null and p_checked_at < product.last_checked_at)
       or jsonb_typeof(p_checks) is distinct from 'array'
       or jsonb_array_length(p_checks) not between 1 and 2 then
        raise exception 'Revisión inválida.';
    end if;
    final_check := p_checks -> -1;
    if (final_check ->> 'ok')::boolean is distinct from p_accepted
       or (p_accepted and (
           (final_check ->> 'price') is null
           or (final_check ->> 'price')::numeric <= 0
           or (final_check ->> 'price')::numeric > 9999999999.99
           or (final_check ->> 'currency') is distinct from product.currency)) then
        raise exception 'Resultado incompatible con el producto.';
    end if;

    insert into public.price_checks
        (product_id, checked_at, ok, price, currency, availability, method, confidence, error_code, warnings)
    select p_product_id, (c ->> 'checked_at')::timestamptz,
        (c ->> 'ok')::boolean, (c ->> 'price')::numeric,
        c ->> 'currency', c ->> 'availability', c ->> 'method', c ->> 'confidence',
        c ->> 'error_code', coalesce(c -> 'warnings', '[]'::jsonb)
    from jsonb_array_elements(p_checks) c;

    update public.products set
        last_checked_at = p_checked_at,
        last_availability = final_check ->> 'availability',
        last_price = case when p_accepted then (final_check ->> 'price')::numeric else last_price end,
        last_success_at = case when p_accepted then p_checked_at else last_success_at end,
        last_method = case when p_accepted then final_check ->> 'method' else last_method end,
        status = case when p_accepted then 'active'
                      when consecutive_failures + 1 >= 3 then 'error' else status end,
        consecutive_failures = case when p_accepted then 0 else consecutive_failures + 1 end
    where id = p_product_id;
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
      target_price,target_percent,check_interval_hours,status,last_price,last_checked_at,last_success_at,last_method,last_availability)
    values(v_row.url,v_row.domain,btrim(p_confirmation->>'name'),v_row.result->>'image_url',v_currency,
      v_reference,p_confirmation->>'target_type',
      case when p_confirmation->>'target_type' = 'price' then v_target else round(v_reference*(1-v_target/100),2) end,
      case when p_confirmation->>'target_type' = 'percent' then v_target else null end,
      (p_confirmation->>'check_interval_hours')::integer,'active',v_price,v_row.updated_at,v_row.updated_at,v_row.result->>'method',v_choice->>'availability')
    returning id into v_product;
    if v_list is not null then
        insert into public.basket_items(list_id, product_id, position)
        select v_list, v_product, coalesce(max(position) + 1, 0)
        from public.basket_items where list_id = v_list;
    end if;
    insert into public.price_checks(product_id,checked_at,ok,price,currency,availability,method,confidence,warnings)
    values(v_product,v_row.updated_at,true,v_price,v_currency,v_choice->>'availability',v_row.result->>'method',v_row.result->>'confidence',
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
