begin;

-- Shadow only: no activation, engine, evaluation or event writer is installed.
lock table public.lists, public.products, public.basket_items in access exclusive mode;
alter table public.lists add column purchase_mode text not null default 'legacy'
    check (purchase_mode in ('legacy', 'alternatives'));

create table public.purchase_configurations (
    list_id uuid not null references public.lists(id) on delete cascade,
    version bigint not null,
    schema_version integer not null default 2 check (schema_version = 2),
    configuration jsonb not null,
    currency text not null check (currency ~ '^[A-Z]{3}$'),
    budget numeric(12,2) check (budget > 0 and budget <= 9999999999.99),
    budget_enabled boolean not null default true,
    winner_enabled boolean not null default false,
    minimum_savings numeric(12,2) not null default 0 check (minimum_savings >= 0),
    created_at timestamptz not null default now(),
    primary key (list_id, version)
);

create table public.purchase_needs (
    list_id uuid not null, version bigint not null,
    id uuid not null, name text not null check (char_length(name) between 1 and 100),
    required_quantity numeric(24,6) not null check (required_quantity > 0 and required_quantity < 'Infinity'::numeric),
    unit text not null check (unit in ('ml','g','unit')),
    position integer not null check (position >= 0), allow_surplus boolean not null default false,
    legacy_item_id uuid, created_at timestamptz not null,
    check (unit <> 'unit' or required_quantity = trunc(required_quantity)),
    unique (list_id,version,legacy_item_id), primary key (list_id,version,id),
    foreign key (list_id,version) references public.purchase_configurations(list_id,version) on delete cascade
);

create table public.purchase_offers (
    list_id uuid not null, version bigint not null,
    id uuid not null, product_id uuid not null references public.products(id) on delete restrict,
    max_purchase_units integer check (max_purchase_units > 0),
    unique (list_id,version,product_id), primary key (list_id,version,id),
    foreign key (list_id,version) references public.purchase_configurations(list_id,version) on delete cascade
);

create table public.purchase_coverages (
    list_id uuid not null, version bigint not null,
    offer_id uuid not null, need_id uuid not null,
    quantity numeric(24,6) not null check (quantity > 0 and quantity < 'Infinity'::numeric),
    primary key (list_id,version,offer_id,need_id),
    foreign key (list_id,version) references public.purchase_configurations(list_id,version) on delete cascade,
    foreign key (list_id,version,offer_id) references public.purchase_offers(list_id,version,id),
    foreign key (list_id,version,need_id) references public.purchase_needs(list_id,version,id)
);

create table public.purchase_extras (
    list_id uuid not null, version bigint not null,
    id uuid not null, offer_id uuid not null, name text not null check (char_length(name) between 1 and 100),
    quantity numeric(24,6) not null check (quantity > 0 and quantity < 'Infinity'::numeric),
    unit text not null check (unit in ('ml','g','unit')), accepted boolean not null default false,
    check (unit <> 'unit' or quantity = trunc(quantity)), primary key (list_id,version,id),
    foreign key (list_id,version) references public.purchase_configurations(list_id,version) on delete cascade,
    foreign key (list_id,version,offer_id) references public.purchase_offers(list_id,version,id)
);

create table public.purchase_alternatives (
    list_id uuid not null, version bigint not null,
    id uuid not null, name text not null check (char_length(name) between 1 and 100),
    position integer not null check (position >= 0), primary key (list_id,version,id),
    foreign key (list_id,version) references public.purchase_configurations(list_id,version) on delete cascade
);

create table public.purchase_alternative_needs (
    list_id uuid not null, version bigint not null,
    alternative_id uuid not null, need_id uuid not null,
    primary key (list_id,version,alternative_id,need_id),
    foreign key (list_id,version) references public.purchase_configurations(list_id,version) on delete cascade,
    foreign key (list_id,version,alternative_id) references public.purchase_alternatives(list_id,version,id),
    foreign key (list_id,version,need_id) references public.purchase_needs(list_id,version,id)
);

create table public.purchase_alternative_items (
    list_id uuid not null, version bigint not null,
    alternative_id uuid not null, offer_id uuid not null,
    purchase_units integer not null check (purchase_units > 0),
    primary key (list_id,version,alternative_id,offer_id),
    foreign key (list_id,version) references public.purchase_configurations(list_id,version) on delete cascade,
    foreign key (list_id,version,alternative_id) references public.purchase_alternatives(list_id,version,id),
    foreign key (list_id,version,offer_id) references public.purchase_offers(list_id,version,id)
);

create table public.purchase_pins (
    list_id uuid not null, version bigint not null,
    alternative_id uuid not null, primary key (list_id,version,alternative_id),
    foreign key (list_id,version) references public.purchase_configurations(list_id,version) on delete cascade,
    foreign key (list_id,version,alternative_id) references public.purchase_alternatives(list_id,version,id)
);

create table public.purchase_reference_items (
    list_id uuid not null, version bigint not null,
    alternative_id uuid not null, primary key (list_id,version,alternative_id),
    foreign key (list_id,version) references public.purchase_configurations(list_id,version) on delete cascade,
    foreign key (list_id,version,alternative_id) references public.purchase_alternatives(list_id,version,id)
);

create table public.purchase_evaluations (
    list_id uuid not null, version bigint not null,
    id uuid not null default gen_random_uuid(), evaluated_at timestamptz not null,
    input_signature text not null, engine_version text not null, inputs jsonb not null, result jsonb not null,
    primary key (id), unique (list_id,version,id), unique (list_id,version,input_signature,engine_version),
    foreign key (list_id,version) references public.purchase_configurations(list_id,version) on delete cascade
);

create table public.purchase_alert_state (
    list_id uuid not null, version bigint not null,
    last_evaluation_id uuid, budget_reached boolean not null, budget_epoch bigint not null,
    previous_purchase_signature jsonb, transition_number bigint not null default 0 check (transition_number >= 0),
    primary key (list_id,version),
    foreign key (list_id,version) references public.purchase_configurations(list_id,version) on delete cascade,
    foreign key (list_id,version,last_evaluation_id) references public.purchase_evaluations(list_id,version,id)
);

create table public.purchase_events (
    list_id uuid not null, version bigint not null,
    id uuid not null default gen_random_uuid(), evaluation_id uuid not null,
    transition_number bigint not null check (transition_number >= 0), payload jsonb not null,
    reasons text not null check (reasons in ('budget','winner','both')),
    status text not null default 'claimed' check (status in ('claimed','sent','failed')),
    primary key (id), unique (list_id,version,transition_number),
    foreign key (list_id,version) references public.purchase_configurations(list_id,version) on delete cascade,
    foreign key (list_id,version,evaluation_id) references public.purchase_evaluations(list_id,version,id)
);

create index purchase_offers_product_idx on public.purchase_offers(product_id);

-- The deferred FK permits building the canonical projection from inserted rows.
alter table public.purchase_needs alter constraint purchase_needs_list_id_version_fkey deferrable initially deferred;
alter table public.purchase_offers alter constraint purchase_offers_list_id_version_fkey deferrable initially deferred;
alter table public.purchase_coverages alter constraint purchase_coverages_list_id_version_fkey deferrable initially deferred;
alter table public.purchase_alternatives alter constraint purchase_alternatives_list_id_version_fkey deferrable initially deferred;
alter table public.purchase_alternative_needs alter constraint purchase_alternative_needs_list_id_version_fkey deferrable initially deferred;
alter table public.purchase_alternative_items alter constraint purchase_alternative_items_list_id_version_fkey deferrable initially deferred;

-- Names identify presentation units, not guessed physical contents.
insert into public.purchase_needs
select i.list_id,l.composition_version,i.id,left(coalesce(nullif(p.name,''),'Producto'),100),
    i.quantity,'unit',i.position,false,i.id,i.created_at
from public.basket_items i join public.lists l on l.id=i.list_id join public.products p on p.id=i.product_id;
insert into public.purchase_offers
select i.list_id,l.composition_version,i.id,i.product_id,null
from public.basket_items i join public.lists l on l.id=i.list_id;
insert into public.purchase_coverages
select list_id,version,id,id,1 from public.purchase_needs;
insert into public.purchase_alternatives
select list_id,version,id,name,position from public.purchase_needs;
insert into public.purchase_alternative_needs
select list_id,version,id,id from public.purchase_needs;
insert into public.purchase_alternative_items
select list_id,version,id,id,required_quantity::integer from public.purchase_needs;

insert into public.purchase_configurations(list_id,version,currency,budget,configuration,created_at)
select l.id,l.composition_version,l.currency,l.budget,jsonb_build_object(
    'schema_version',2,'version',l.composition_version::text,'currency',l.currency,'budget',l.budget::text,
    'budget_enabled',true,'winner_enabled',false,'minimum_savings','0.00',
    'needs',coalesce((select jsonb_agg((to_jsonb(n)-'list_id'-'version') ||
        jsonb_build_object('required_quantity',n.required_quantity::text) order by n.position,n.id)
        from public.purchase_needs n where n.list_id=l.id),'[]'::jsonb),
    'offers',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'product_id',o.product_id,
        'max_purchase_units',null,'coverage',jsonb_build_array(jsonb_build_object('need_id',o.id,'quantity','1')),
        'extras','[]'::jsonb) order by o.id) from public.purchase_offers o where o.list_id=l.id),'[]'::jsonb),
    'alternatives',coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'name',n.name,'position',n.position,
        'scope',jsonb_build_array(n.id),'items',jsonb_build_array(jsonb_build_object('offer_id',n.id,
        'purchase_units',n.required_quantity::integer))) order by n.position,n.id)
        from public.purchase_needs n where n.list_id=l.id),'[]'::jsonb),
    'pins','[]'::jsonb,'reference','[]'::jsonb),l.created_at
from public.lists l;
insert into public.purchase_alert_state(list_id,version,budget_reached,budget_epoch)
select id,composition_version,basket_reached,basket_alert_epoch from public.lists;

-- Flush deferred backfill checks before ALTER TABLE enables RLS.
set constraints all immediate;

-- Do not leak the additive mode field through the existing list response.
create or replace function public.read_lists_with_baskets()
returns jsonb language sql stable security invoker set search_path = '' as $$
    select coalesce(jsonb_agg((to_jsonb(l) - 'basket_reached' - 'purchase_mode')
        || jsonb_build_object('basket', public.list_basket_summary(l.id))
        order by l.position, l.created_at, l.id), '[]'::jsonb) from public.lists l;
$$;

-- No write grants or publishing RPC until validation and the v2 consumer exist.
alter table public.purchase_configurations enable row level security;
revoke all on public.purchase_configurations from public, anon, authenticated, service_role;
grant select on public.purchase_configurations to service_role;
alter table public.purchase_needs enable row level security;
revoke all on public.purchase_needs from public, anon, authenticated, service_role;
grant select on public.purchase_needs to service_role;
alter table public.purchase_offers enable row level security;
revoke all on public.purchase_offers from public, anon, authenticated, service_role;
grant select on public.purchase_offers to service_role;
alter table public.purchase_coverages enable row level security;
revoke all on public.purchase_coverages from public, anon, authenticated, service_role;
grant select on public.purchase_coverages to service_role;
alter table public.purchase_extras enable row level security;
revoke all on public.purchase_extras from public, anon, authenticated, service_role;
grant select on public.purchase_extras to service_role;
alter table public.purchase_alternatives enable row level security;
revoke all on public.purchase_alternatives from public, anon, authenticated, service_role;
grant select on public.purchase_alternatives to service_role;
alter table public.purchase_alternative_needs enable row level security;
revoke all on public.purchase_alternative_needs from public, anon, authenticated, service_role;
grant select on public.purchase_alternative_needs to service_role;
alter table public.purchase_alternative_items enable row level security;
revoke all on public.purchase_alternative_items from public, anon, authenticated, service_role;
grant select on public.purchase_alternative_items to service_role;
alter table public.purchase_pins enable row level security;
revoke all on public.purchase_pins from public, anon, authenticated, service_role;
grant select on public.purchase_pins to service_role;
alter table public.purchase_reference_items enable row level security;
revoke all on public.purchase_reference_items from public, anon, authenticated, service_role;
grant select on public.purchase_reference_items to service_role;
alter table public.purchase_evaluations enable row level security;
revoke all on public.purchase_evaluations from public, anon, authenticated, service_role;
grant select on public.purchase_evaluations to service_role;
alter table public.purchase_alert_state enable row level security;
revoke all on public.purchase_alert_state from public, anon, authenticated, service_role;
grant select on public.purchase_alert_state to service_role;
alter table public.purchase_events enable row level security;
revoke all on public.purchase_events from public, anon, authenticated, service_role;
grant select on public.purchase_events to service_role;

commit;
