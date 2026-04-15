-- =============================================================================
-- LMBR.ai — Canonical production schema
-- Built by Worklighter.
--
-- Multi-tenant Postgres schema for LMBR.ai enterprise AI bid automation.
-- Every non-companies row is scoped by company_id with RLS enforced via
-- JWT claim `company_id`. Role-based policies gate manager-only actions
-- such as margin approval and quote release.
--
-- Workflow tables trace the LMBR.ai pipeline:
--   companies → users → user_roles
--   bids → line_items
--   vendors → vendor_bids → vendor_bid_line_items
--   quotes
--   market_prices
--   archive_entries
-- =============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
do $$ begin
  create type user_role as enum ('trader', 'buyer', 'trader_buyer', 'manager_owner');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bid_status as enum (
    'draft', 'ingesting', 'routed', 'vendor_pending',
    'quoted', 'won', 'lost', 'archived'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type bid_source as enum ('pdf', 'excel', 'email', 'scan', 'manual');
exception when duplicate_object then null; end $$;

do $$ begin
  create type vendor_bid_status as enum ('requested', 'received', 'extracted', 'declined', 'expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type quote_status as enum ('draft', 'pending_approval', 'released', 'revised', 'expired');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- updated_at trigger function
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Helper: JWT company_id (tenant) and role
-- -----------------------------------------------------------------------------
create or replace function public.jwt_company_id()
returns uuid
language sql stable
as $$ select nullif(auth.jwt() ->> 'company_id', '')::uuid $$;

create or replace function public.jwt_has_role(target user_role)
returns boolean
language sql stable
as $$
  select coalesce(
    (select target::text = any(
      string_to_array(coalesce(auth.jwt() ->> 'roles', ''), ',')
    )),
    false
  )
$$;

-- -----------------------------------------------------------------------------
-- companies
-- -----------------------------------------------------------------------------
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  legal_name text,
  timezone text not null default 'America/Los_Angeles',
  default_margin_pct numeric(6,4) not null default 0.08,
  manager_approval_threshold numeric(12,2) not null default 0,
  random_lengths_subscription boolean not null default false,
  address jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_companies_updated_at
before update on public.companies
for each row execute function public.set_updated_at();

alter table public.companies enable row level security;

create policy companies_select on public.companies
  for select using (id = public.jwt_company_id());
create policy companies_update on public.companies
  for update using (id = public.jwt_company_id() and public.jwt_has_role('manager_owner'));

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  auth_user_id uuid unique,
  email text not null,
  full_name text not null,
  phone text,
  avatar_url text,
  is_active boolean not null default true,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, email)
);

create index if not exists users_company_id_idx on public.users(company_id);

create trigger trg_users_updated_at
before update on public.users
for each row execute function public.set_updated_at();

alter table public.users enable row level security;

create policy users_select on public.users
  for select using (company_id = public.jwt_company_id());
create policy users_mutate_manager on public.users
  for all using (
    company_id = public.jwt_company_id() and public.jwt_has_role('manager_owner')
  );

-- -----------------------------------------------------------------------------
-- user_roles
-- -----------------------------------------------------------------------------
create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role user_role not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, role)
);

create index if not exists user_roles_company_user_idx on public.user_roles(company_id, user_id);

create trigger trg_user_roles_updated_at
before update on public.user_roles
for each row execute function public.set_updated_at();

alter table public.user_roles enable row level security;

create policy user_roles_select on public.user_roles
  for select using (company_id = public.jwt_company_id());
create policy user_roles_mutate_manager on public.user_roles
  for all using (
    company_id = public.jwt_company_id() and public.jwt_has_role('manager_owner')
  );

-- -----------------------------------------------------------------------------
-- bids
-- -----------------------------------------------------------------------------
create table if not exists public.bids (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_name text not null,
  project_name text,
  job_address text,
  job_state char(2),
  job_region text,
  source bid_source not null,
  source_document_url text,
  status bid_status not null default 'draft',
  owner_trader_id uuid references public.users(id) on delete set null,
  assigned_buyer_id uuid references public.users(id) on delete set null,
  quote_due_at timestamptz,
  total_board_feet numeric(14,2),
  total_cost numeric(14,2),
  total_sell_price numeric(14,2),
  margin_pct numeric(6,4),
  margin_approved_by uuid references public.users(id) on delete set null,
  margin_approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bids_company_status_idx on public.bids(company_id, status);
create index if not exists bids_company_created_idx on public.bids(company_id, created_at desc);

create trigger trg_bids_updated_at
before update on public.bids
for each row execute function public.set_updated_at();

alter table public.bids enable row level security;

create policy bids_select on public.bids
  for select using (company_id = public.jwt_company_id());
create policy bids_insert on public.bids
  for insert with check (company_id = public.jwt_company_id());
create policy bids_update on public.bids
  for update using (company_id = public.jwt_company_id());
-- Only managers can approve margins (populate margin_approved_* fields)
create policy bids_margin_approve on public.bids
  for update using (
    company_id = public.jwt_company_id() and public.jwt_has_role('manager_owner')
  );

-- -----------------------------------------------------------------------------
-- line_items
-- -----------------------------------------------------------------------------
create table if not exists public.line_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bid_id uuid not null references public.bids(id) on delete cascade,
  house text,
  phase text,
  sequence integer not null default 0,
  species text not null,
  grade text,
  nominal_thickness_in numeric(6,2),
  nominal_width_in numeric(6,2),
  length_ft numeric(6,2),
  quantity numeric(12,2) not null,
  unit text not null default 'piece',
  description text not null,
  board_feet numeric(14,2),
  consolidation_key text,
  selected_vendor_bid_id uuid,
  unit_cost numeric(12,4),
  unit_sell_price numeric(12,4),
  extended_cost numeric(14,2),
  extended_sell_price numeric(14,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists line_items_bid_idx on public.line_items(bid_id);
create index if not exists line_items_consolidation_idx on public.line_items(bid_id, consolidation_key);

create trigger trg_line_items_updated_at
before update on public.line_items
for each row execute function public.set_updated_at();

alter table public.line_items enable row level security;

create policy line_items_all on public.line_items
  for all using (company_id = public.jwt_company_id());

-- -----------------------------------------------------------------------------
-- vendors
-- -----------------------------------------------------------------------------
create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  contact_name text,
  contact_email text,
  contact_phone text,
  regions text[] not null default '{}',
  commodities text[] not null default '{}',
  preferred boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendors_company_idx on public.vendors(company_id);

create trigger trg_vendors_updated_at
before update on public.vendors
for each row execute function public.set_updated_at();

alter table public.vendors enable row level security;

create policy vendors_all on public.vendors
  for all using (company_id = public.jwt_company_id());

-- -----------------------------------------------------------------------------
-- vendor_bids
-- -----------------------------------------------------------------------------
create table if not exists public.vendor_bids (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bid_id uuid not null references public.bids(id) on delete cascade,
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  status vendor_bid_status not null default 'requested',
  requested_at timestamptz not null default now(),
  received_at timestamptz,
  expires_at timestamptz,
  source_document_url text,
  raw_text text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendor_bids_bid_vendor_idx on public.vendor_bids(bid_id, vendor_id);

create trigger trg_vendor_bids_updated_at
before update on public.vendor_bids
for each row execute function public.set_updated_at();

alter table public.vendor_bids enable row level security;

create policy vendor_bids_all on public.vendor_bids
  for all using (company_id = public.jwt_company_id());

-- -----------------------------------------------------------------------------
-- vendor_bid_line_items
-- -----------------------------------------------------------------------------
create table if not exists public.vendor_bid_line_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  vendor_bid_id uuid not null references public.vendor_bids(id) on delete cascade,
  matched_line_item_id uuid references public.line_items(id) on delete set null,
  species text not null,
  grade text,
  nominal_thickness_in numeric(6,2),
  nominal_width_in numeric(6,2),
  length_ft numeric(6,2),
  quantity numeric(12,2) not null,
  unit text not null default 'piece',
  unit_price numeric(12,4) not null,
  currency char(3) not null default 'USD',
  price_per text not null default 'mbf',
  freight_included boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vbli_vendor_bid_idx on public.vendor_bid_line_items(vendor_bid_id);
create index if not exists vbli_matched_line_idx on public.vendor_bid_line_items(matched_line_item_id);

create trigger trg_vbli_updated_at
before update on public.vendor_bid_line_items
for each row execute function public.set_updated_at();

alter table public.vendor_bid_line_items enable row level security;

create policy vbli_all on public.vendor_bid_line_items
  for all using (company_id = public.jwt_company_id());

-- -----------------------------------------------------------------------------
-- quotes
-- -----------------------------------------------------------------------------
create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bid_id uuid not null references public.bids(id) on delete cascade,
  quote_number text not null,
  version integer not null default 1,
  status quote_status not null default 'draft',
  customer_name text not null,
  customer_email text,
  project_name text,
  subtotal numeric(14,2) not null default 0,
  freight numeric(14,2) not null default 0,
  tax_rate numeric(6,4) not null default 0,
  tax_amount numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  margin_pct numeric(6,4) not null default 0,
  valid_until timestamptz,
  released_pdf_url text,
  approved_by uuid references public.users(id) on delete set null,
  approved_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, quote_number, version)
);

create index if not exists quotes_bid_idx on public.quotes(bid_id);

create trigger trg_quotes_updated_at
before update on public.quotes
for each row execute function public.set_updated_at();

alter table public.quotes enable row level security;

create policy quotes_select on public.quotes
  for select using (company_id = public.jwt_company_id());
create policy quotes_insert on public.quotes
  for insert with check (company_id = public.jwt_company_id());
create policy quotes_update on public.quotes
  for update using (company_id = public.jwt_company_id());
-- Only managers can release a quote (approved_by / released_at).
create policy quotes_release_manager on public.quotes
  for update using (
    company_id = public.jwt_company_id() and public.jwt_has_role('manager_owner')
  );

-- -----------------------------------------------------------------------------
-- market_prices
-- -----------------------------------------------------------------------------
create table if not exists public.market_prices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  commodity_id text not null,
  region text,
  source text not null,
  unit_price numeric(12,4) not null,
  price_per text not null default 'mbf',
  currency char(3) not null default 'USD',
  recorded_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists market_prices_commodity_recorded_idx
  on public.market_prices(commodity_id, recorded_at desc);

create trigger trg_market_prices_updated_at
before update on public.market_prices
for each row execute function public.set_updated_at();

alter table public.market_prices enable row level security;

create policy market_prices_select on public.market_prices
  for select using (
    company_id is null or company_id = public.jwt_company_id()
  );
create policy market_prices_mutate on public.market_prices
  for all using (company_id = public.jwt_company_id());

-- -----------------------------------------------------------------------------
-- archive_entries
-- -----------------------------------------------------------------------------
create table if not exists public.archive_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bid_id uuid not null references public.bids(id) on delete cascade,
  archived_by uuid references public.users(id) on delete set null,
  outcome text,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists archive_entries_company_idx on public.archive_entries(company_id, created_at desc);

create trigger trg_archive_entries_updated_at
before update on public.archive_entries
for each row execute function public.set_updated_at();

alter table public.archive_entries enable row level security;

create policy archive_entries_all on public.archive_entries
  for all using (company_id = public.jwt_company_id());
