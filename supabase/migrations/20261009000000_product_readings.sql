begin;

create table public.product_readings (
    id uuid primary key,
    url text not null check (length(url) <= 2048),
    domain text not null,
    selector text check (length(selector) between 1 and 500),
    status text not null default 'queued' check (status in ('queued','reading','ready','failed','confirmed')),
    result jsonb,
    recipe jsonb not null default '{}'::jsonb,
    product_id uuid references public.products(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
alter table public.product_readings enable row level security;
revoke all on public.product_readings from anon, authenticated;
grant all on public.product_readings to service_role;

create function public.create_product_reading(p_id uuid, p_url text, p_selector text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_row public.product_readings;
begin
    if p_id is null or p_url is null or length(p_url) > 2048
       or p_url !~ '^https?://[a-zA-Z0-9.-]+(:80|:443)?(/|$)'
       or (p_selector is not null and length(p_selector) not between 1 and 500) then
        raise sqlstate 'PT400' using message = 'Invalid reading';
    end if;
    insert into public.product_readings(id,url,domain,selector)
    values(p_id,p_url,lower(split_part(split_part(substring(p_url from '://(.*)'), '/', 1), ':', 1)),p_selector)
    on conflict (id) do nothing;
    select * into v_row from public.product_readings where id = p_id for update;
    if v_row.url <> p_url or v_row.selector is distinct from p_selector then
        raise sqlstate 'PT409' using message = 'Reading ID already used';
    end if;
    return to_jsonb(v_row) - array['recipe','selector','domain','updated_at'];
end $$;

create function public.claim_product_reading(p_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_row public.product_readings;
begin
    update public.product_readings set status = 'reading', updated_at = now()
    where id = p_id and status = 'queued' returning * into v_row;
    if not found then return null; end if;
    return to_jsonb(v_row);
end $$;

create function public.complete_product_reading(p_id uuid, p_result jsonb, p_recipe jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
begin
    if jsonb_typeof(p_result) is distinct from 'object'
       or jsonb_typeof(p_result->'candidates') is distinct from 'array'
       or jsonb_array_length(p_result->'candidates') > 5
       or jsonb_typeof(p_recipe) is distinct from 'object' then
        raise sqlstate 'PT400' using message = 'Invalid extraction';
    end if;
    update public.product_readings set result = p_result, recipe = p_recipe,
      status = case when p_result->>'price' is not null or jsonb_array_length(p_result->'candidates') > 0 then 'ready' else 'failed' end,
      updated_at = now() where id = p_id and status = 'reading';
    if not found then raise sqlstate 'PT409' using message = 'Reading already completed'; end if;
end $$;

create function public.confirm_product_reading(p_id uuid, p_confirmation jsonb)
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
    perform 1 from public.lists where id = v_list for key share;
    if not found then raise sqlstate 'PT404' using message = 'List not found'; end if;
    insert into public.products(list_id,url,domain,name,image_url,currency,reference_price,target_type,
      target_price,target_percent,check_interval_hours,status,last_price,last_checked_at,last_success_at,last_method)
    values(v_list,v_row.url,v_row.domain,btrim(p_confirmation->>'name'),v_row.result->>'image_url',v_currency,
      v_reference,p_confirmation->>'target_type',
      case when p_confirmation->>'target_type' = 'price' then v_target else round(v_reference*(1-v_target/100),2) end,
      case when p_confirmation->>'target_type' = 'percent' then v_target else null end,
      (p_confirmation->>'check_interval_hours')::integer,'active',v_price,v_row.updated_at,v_row.updated_at,v_row.result->>'method')
    returning id into v_product;
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

revoke all on function public.create_product_reading(uuid,text,text), public.claim_product_reading(uuid),
    public.complete_product_reading(uuid,jsonb,jsonb), public.confirm_product_reading(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.create_product_reading(uuid,text,text), public.claim_product_reading(uuid),
    public.complete_product_reading(uuid,jsonb,jsonb), public.confirm_product_reading(uuid,jsonb) to service_role;
commit;
