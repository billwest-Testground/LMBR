-- =============================================================================
-- LMBR.ai migration 007 — quotes
-- Built by Worklighter.
--
-- Customer-facing quote artifact. Vendor names are intentionally NOT
-- referenced from this table — the clean PDF path never surfaces upstream
-- supplier identities. Release is manager-gated via RLS.
-- =============================================================================

do $$ begin
  create type quote_status as enum ('draft', 'pending_approval', 'released', 'revised', 'expired');
exception when duplicate_object then null; end $$;

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
create policy quotes_release_manager on public.quotes
  for update using (
    company_id = public.jwt_company_id() and public.jwt_has_role('manager_owner')
  );
