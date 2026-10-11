begin;

alter table public.lists add column basket_evaluated_summary jsonb,
    add column basket_alert_epoch bigint not null default 0;
alter table public.basket_events
    add column composition_version bigint,
    add column alert_epoch bigint not null default 0,
    add column reference_total numeric,
    add column savings numeric,
    add column savings_percent numeric,
    add column price_signature jsonb,
    add column exchange_rates jsonb not null default '[]'::jsonb,
    add column cause text not null default 'prices' check (cause in ('prices','conversion'));
-- Legacy events did not record a version; do not assign them today's composition.
update public.basket_events set composition_version = 0;
alter table public.basket_events alter column composition_version set not null;
-- Row locks serialize new claims; a nonunique index also preserves old ambiguous claims.
create index basket_event_pending_idx on public.basket_events(list_id, composition_version)
    where status = 'claimed';

create function public.basket_price_signature(p_summary jsonb)
returns jsonb language sql immutable set search_path = '' as $$
    select jsonb_agg(jsonb_build_array(x->>'product_id', x->>'quantity', x->>'currency',
        x->>'reference_price', x->>'last_price') order by x->>'product_id')
    from jsonb_array_elements(p_summary->'lines') x;
$$;

create or replace function public.claim_basket_events(p_list_id uuid default null)
returns setof public.basket_events language plpgsql security invoker set search_path = '' as $$
declare l public.lists; s jsonb; previous jsonb; e public.basket_events; cause text;
begin
    for l in select * from public.lists where budget is not null
        and (p_list_id is null or id = p_list_id) order by id for update loop
        s := public.list_basket_summary(l.id);
        previous := l.basket_evaluated_summary;
        update public.lists set basket_evaluated_summary = s where id = l.id;
        if not (s->>'complete')::boolean then continue; end if;
        if (s->>'total')::numeric > l.budget * 1.03 then
            if l.basket_reached or exists(select 1 from public.basket_events where list_id=l.id
                and composition_version=l.composition_version and alert_epoch=l.basket_alert_epoch
                and status='claimed') then
                update public.lists set basket_reached = false, basket_alert_epoch = basket_alert_epoch + 1
                where id = l.id;
            end if;
        elsif (s->>'total')::numeric <= l.budget and not l.basket_reached
            and not exists(select 1 from public.basket_events where list_id = l.id
                and composition_version = l.composition_version and status = 'claimed') then
            cause := case when (previous->>'complete')::boolean
                and (previous->>'composition_version')::bigint = l.composition_version
                and (previous->>'total')::numeric > l.budget
                and previous->'exchange_rates' is distinct from s->'exchange_rates'
                and public.basket_price_signature(previous) = public.basket_price_signature(s)
                then 'conversion' else 'prices' end;
            if cause = 'prices' and exists(select 1 from public.basket_events f
                where f.list_id = l.id and f.composition_version = l.composition_version
                and f.alert_epoch = l.basket_alert_epoch
                and f.status = 'failed' and f.cause = 'conversion' and f.total = (s->>'total')::numeric
                and f.exchange_rates = s->'exchange_rates'
                and f.price_signature = public.basket_price_signature(s)) then
                cause := 'conversion';
            end if;
            insert into public.basket_events(list_id,name,budget,currency,total,composition_version,alert_epoch,
                reference_total,savings,savings_percent,exchange_rates,cause,price_signature)
            values(l.id,l.name,l.budget,l.currency,(s->>'total')::numeric,l.composition_version,l.basket_alert_epoch,
                (s->>'reference_total')::numeric,(s->>'savings')::numeric,
                (s->>'savings_percent')::numeric,s->'exchange_rates',cause,public.basket_price_signature(s)) returning * into e;
            return next e;
        end if;
    end loop;
end $$;

create function public.finish_basket_event(p_id uuid, p_sent boolean)
returns void language plpgsql security invoker set search_path = '' as $$
declare e public.basket_events;
begin
    if p_sent is null then raise sqlstate 'PT400' using message = 'Missing delivery result'; end if;
    -- Lock basket before event, matching claim order. A receipt for an old version cannot arm the new one.
    perform 1 from public.lists where id = (select list_id from public.basket_events where id = p_id) for update;
    update public.basket_events set status = case when p_sent then 'sent' else 'failed' end
    where id = p_id and status = 'claimed' returning * into e;
    if not found then raise sqlstate 'PT409' using message = 'Event already finished'; end if;
    if p_sent then
        update public.lists set basket_reached = true
        where id = e.list_id and composition_version = e.composition_version and basket_alert_epoch = e.alert_epoch;
    end if;
end $$;

alter table public.product_readings
    add column repair_product_id uuid references public.products(id) on delete set null,
    add column repair_baseline jsonb;

create function public.create_product_repair(p_id uuid, p_product_id uuid, p_url text, p_selector text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare p public.products; r public.product_readings; result jsonb;
begin
    select * into r from public.product_readings where id = p_id for update;
    if found then
        if r.repair_product_id is distinct from p_product_id then
            raise sqlstate 'PT409' using message = 'Reading ID already used';
        end if;
    end if;
    result := public.create_product_reading(p_id,p_url,p_selector);
    select * into r from public.product_readings where id = p_id;
    if r.repair_product_id is not null and r.repair_product_id <> p_product_id then
        raise sqlstate 'PT409' using message = 'Reading ID already used';
    end if;
    select * into p from public.products where id = p_product_id for update;
    if not found then raise sqlstate 'PT404' using message = 'Product not found'; end if;
    update public.product_readings set repair_product_id = p_product_id,
        repair_baseline = coalesce(repair_baseline,jsonb_build_object('url',p.url,'name',p.name,
            'currency',p.currency,'last_checked_at',p.last_checked_at)) where id = p_id;
    return result || jsonb_build_object('repair_product_id',p_product_id);
end $$;

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
    v_existing public.products;
begin
    select * into v_row from public.product_readings where id = p_id for update;
    if not found then raise sqlstate 'PT404' using message = 'Reading not found'; end if;
    -- Replays return the original product, even if the caller changed its form.
    if v_row.status = 'confirmed' and v_row.product_id is not null then
        return to_jsonb(v_row) - array['recipe','selector','domain','updated_at'];
    end if;
    if v_row.status <> 'ready' then raise sqlstate 'PT409' using message = 'Reading not ready'; end if;
    if v_row.repair_baseline is not null and v_row.repair_product_id is null then
        raise sqlstate 'PT404' using message = 'Product not found';
    end if;
    if v_row.repair_product_id is not null then
        select * into v_existing from public.products where id = v_row.repair_product_id for update;
        if not found then raise sqlstate 'PT404' using message = 'Product not found'; end if;
        if v_row.repair_baseline is distinct from jsonb_build_object('url',v_existing.url,
            'name',v_existing.name,'currency',v_existing.currency,'last_checked_at',v_existing.last_checked_at) then
            raise sqlstate 'PT409' using message = 'Product changed; read again';
        end if;
        if p_confirmation->>'same_product' is distinct from 'true'
            or p_confirmation->>'currency' is distinct from v_existing.currency then
            raise sqlstate 'PT400' using message = 'Confirm the same article and currency';
        end if;
        p_confirmation := p_confirmation || jsonb_build_object('list_id',null,
            'reference_price',v_existing.reference_price::text,'target_type',v_existing.target_type,
            'target_value',case when v_existing.target_type = 'price' then v_existing.target_price::text
                else v_existing.target_percent::text end,'check_interval_hours',v_existing.check_interval_hours);
    end if;
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
    if v_row.repair_product_id is not null then
        if coalesce(btrim(v_choice->>'name'),'') = ''
            or btrim(p_confirmation->>'name') is distinct from btrim(v_choice->>'name')
            or v_choice->>'currency' is distinct from v_existing.currency then
            raise sqlstate 'PT400' using message = 'Confirm the extracted name and currency';
        end if;
        v_product := v_existing.id;
        -- Alert configuration/state, identity and memberships remain intact; this is a real observation.
        update public.products set url = v_row.url, domain = v_row.domain,
            last_price = v_price, last_checked_at = statement_timestamp(), last_success_at = statement_timestamp(),
            last_method = v_row.result->>'method', last_availability = v_choice->>'availability',
            consecutive_failures = 0, status = case when status = 'paused' then 'paused' else 'active' end
        where id = v_product;
    else
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
    end if;
    insert into public.price_checks(product_id,checked_at,ok,price,currency,availability,method,confidence,warnings)
    values(v_product,case when v_row.repair_product_id is not null then statement_timestamp() else v_row.updated_at end,true,v_price,v_currency,v_choice->>'availability',v_row.result->>'method',v_row.result->>'confidence',
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

revoke all on function public.basket_price_signature(jsonb), public.finish_basket_event(uuid,boolean),
    public.create_product_repair(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.basket_price_signature(jsonb), public.finish_basket_event(uuid,boolean),
    public.create_product_repair(uuid,uuid,text,text) to service_role;
notify pgrst, 'reload schema';
commit;
