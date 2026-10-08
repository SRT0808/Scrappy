begin;

create table public.lists (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    emoji text,
    position integer not null default 0,
    created_at timestamptz not null default now()
);

create table public.products (
    id uuid primary key default gen_random_uuid(),
    list_id uuid not null references public.lists(id),
    url text not null,
    domain text not null,
    name text,
    image_url text,
    currency text check (currency ~ '^[A-Z]{3}$'),
    reference_price numeric(12,2) check (reference_price >= 0),
    target_type text check (target_type in ('price', 'percent')),
    target_price numeric(12,2) check (target_price >= 0),
    target_percent numeric(5,2) check (target_percent > 0 and target_percent <= 100),
    check_interval_hours integer not null default 3
        check (check_interval_hours in (3, 6, 12, 24)),
    status text not null default 'pending_confirmation'
        check (status in ('pending_confirmation', 'active', 'paused', 'error')),
    last_price numeric(12,2) check (last_price >= 0),
    last_checked_at timestamptz,
    last_success_at timestamptz,
    consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
    alert_state text not null default 'armed' check (alert_state in ('armed', 'triggered')),
    last_alert_price numeric(12,2) check (last_alert_price >= 0),
    last_alert_at timestamptz,
    last_method text,
    created_at timestamptz not null default now()
);

create index products_list_id_idx on public.products(list_id);

create table public.price_checks (
    id uuid primary key default gen_random_uuid(),
    product_id uuid not null references public.products(id) on delete cascade,
    checked_at timestamptz not null default now(),
    ok boolean not null,
    price numeric(12,2) check (price >= 0),
    currency text check (currency ~ '^[A-Z]{3}$'),
    method text,
    confidence text,
    error_code text,
    warnings jsonb not null default '[]'::jsonb
);

create index price_checks_product_checked_idx on public.price_checks(product_id, checked_at desc);

create table public.domain_recipes (
    domain text primary key,
    fetch_mode text not null default 'http' check (fetch_mode in ('http', 'dynamic', 'stealth')),
    price_selector text,
    name_selector text,
    adaptive_state jsonb,
    updated_at timestamptz not null default now()
);

create table public.notifications (
    id uuid primary key default gen_random_uuid(),
    product_id uuid references public.products(id) on delete set null,
    type text not null,
    channel text not null check (channel in ('ntfy', 'email')),
    status text not null check (status in ('sent', 'failed')),
    payload jsonb not null default '{}'::jsonb,
    error text,
    sent_at timestamptz not null default now()
);

create index notifications_product_id_idx on public.notifications(product_id);

create table public.runs (
    id uuid primary key default gen_random_uuid(),
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    trigger text not null check (trigger in ('cron', 'dispatch', 'local')),
    checked integer not null default 0 check (checked >= 0),
    ok_count integer not null default 0 check (ok_count >= 0),
    fail_count integer not null default 0 check (fail_count >= 0),
    check (checked = ok_count + fail_count),
    check (finished_at is null or finished_at >= started_at)
);

create table public.login_attempts (
    ip inet not null,
    attempted_at timestamptz not null default now(),
    success boolean not null
);

create index login_attempts_ip_time_idx on public.login_attempts(ip, attempted_at desc);

create table public.settings (
    key text primary key,
    value jsonb not null
);

alter table public.lists enable row level security;
alter table public.products enable row level security;
alter table public.price_checks enable row level security;
alter table public.domain_recipes enable row level security;
alter table public.notifications enable row level security;
alter table public.runs enable row level security;
alter table public.login_attempts enable row level security;
alter table public.settings enable row level security;

revoke all on table public.lists, public.products, public.price_checks,
    public.domain_recipes, public.notifications, public.runs,
    public.login_attempts, public.settings from anon, authenticated;
grant usage on schema public to service_role;
grant all on table public.lists, public.products, public.price_checks,
    public.domain_recipes, public.notifications, public.runs,
    public.login_attempts, public.settings to service_role;

commit;
