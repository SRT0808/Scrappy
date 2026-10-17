-- Local pre-activation reversal only. Never discard v2 history.
begin;
lock table public.lists, public.products, public.basket_items in access exclusive mode;
do $$ begin
    if exists(select 1 from public.lists where purchase_mode <> 'legacy')
        or exists(select 1 from public.purchase_evaluations)
        or exists(select 1 from public.purchase_events) then
        raise exception 'Cannot reverse activated purchase history';
    end if;
end $$;
drop table public.purchase_events;
drop table public.purchase_alert_state;
drop table public.purchase_evaluations;
drop table public.purchase_reference_items;
drop table public.purchase_pins;
drop table public.purchase_alternative_items;
drop table public.purchase_alternative_needs;
drop table public.purchase_alternatives;
drop table public.purchase_extras;
drop table public.purchase_coverages;
drop table public.purchase_offers;
drop table public.purchase_needs;
drop table public.purchase_configurations;
alter table public.lists drop column purchase_mode;
create or replace function public.read_lists_with_baskets()
returns jsonb language sql stable security invoker set search_path = ''
as $$
    select coalesce(jsonb_agg((to_jsonb(l) - 'basket_reached')
        || jsonb_build_object('basket', public.list_basket_summary(l.id))
        order by l.position, l.created_at, l.id), '[]'::jsonb) from public.lists l;
$$;
commit;
