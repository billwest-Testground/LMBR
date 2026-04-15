-- =============================================================================
-- LMBR.ai migration 003 — bids
-- Built by Worklighter.
--
-- Core customer-RFQ table. Tracks the bid through every stage of the LMBR.ai
-- workflow (draft → ingesting → routed → vendor_pending → quoted → won/lost
-- → archived). Manager-gated margin approval fields live here.
-- =============================================================================

do $$ begin
  create type bid_status as enum (
    'draft', 'ingesting', 'routed', 'vendor_pending',
    'quoted', 'won', 'lost', 'archived'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type bid_source as enum ('pdf', 'excel', 'email', 'scan', 'manual');
exception when duplicate_object then null; end $$;

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

drop trigger if exists trg_bids_updated_at on public.bids;
create trigger trg_bids_updated_at
before update on public.bids
for each row execute function public.set_updated_at();

alter table public.bids enable row level security;

drop policy if exists bids_select on public.bids;
create policy bids_select on public.bids
  for select using (company_id = public.jwt_company_id());
drop policy if exists bids_insert on public.bids;
create policy bids_insert on public.bids
  for insert with check (company_id = public.jwt_company_id());
drop policy if exists bids_update on public.bids;
create policy bids_update on public.bids
  for update using (company_id = public.jwt_company_id());
drop policy if exists bids_margin_approve on public.bids;
create policy bids_margin_approve on public.bids
  for update using (
    company_id = public.jwt_company_id() and public.jwt_has_role('manager_owner')
  );
