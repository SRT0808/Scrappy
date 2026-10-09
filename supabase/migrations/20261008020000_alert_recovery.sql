begin;

create or replace function public.due_products(p_now timestamptz, p_product_id uuid default null)
returns setof public.products
language sql stable security invoker set search_path = ''
as $$
    select p.* from public.products p
    where p.status in ('active', 'error')
      and (p_product_id is null or p.id = p_product_id)
      and (p_product_id is not null or p.last_checked_at is null
           or p.last_checked_at + make_interval(hours => p.check_interval_hours) <= p_now)
    order by p.last_checked_at nulls first, p.id;
$$;

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
        (product_id, checked_at, ok, price, currency, method, confidence, error_code, warnings)
    select p_product_id, (c ->> 'checked_at')::timestamptz,
        (c ->> 'ok')::boolean, (c ->> 'price')::numeric,
        c ->> 'currency', c ->> 'method', c ->> 'confidence',
        c ->> 'error_code', coalesce(c -> 'warnings', '[]'::jsonb)
    from jsonb_array_elements(p_checks) c;

    update public.products set
        last_checked_at = p_checked_at,
        last_price = case when p_accepted then (final_check ->> 'price')::numeric else last_price end,
        last_success_at = case when p_accepted then p_checked_at else last_success_at end,
        last_method = case when p_accepted then final_check ->> 'method' else last_method end,
        status = case when p_accepted then 'active'
                      when consecutive_failures + 1 >= 3 then 'error' else status end,
        consecutive_failures = case when p_accepted then 0 else consecutive_failures + 1 end
    where id = p_product_id;
end;
$$;

revoke all on function public.due_products(timestamptz, uuid),
    public.save_review(uuid, timestamptz, timestamptz, boolean, jsonb)
    from public, anon, authenticated;
grant execute on function public.due_products(timestamptz, uuid),
    public.save_review(uuid, timestamptz, timestamptz, boolean, jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
