-- =============================================================================
-- LMBR.ai migration 003 — bids
-- Built by Worklighter.
--
-- The bids row is the central workflow entity for a single customer RFQ
-- moving through the LMBR.ai pipeline (received → extracting → reviewing →
-- routing → quoting → comparing → pricing → approved → sent → archived).
--
-- RLS split:
--   • Pure traders only see bids where they are the creator or the
--     assigned trader — a hard privacy rule so split-role desks stay siloed.
--   • trader_buyers, buyers, managers, and owners see every bid in their
--     tenant (trader_buyers need dual visibility; buyers need to see
--     incoming work; managers/owners need full oversight).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
do $$ begin
  create type bid_status as enum (
    'received',
    'extracting',
    'reviewing',
    'routing',
    'quoting',
    'comparing',
    'pricing',
    'approved',
    'sent',
    'archived'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type consolidation_mode as enum (
    'structured', 'consolidated', 'phased', 'hybrid'
  );
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- bids
-- -----------------------------------------------------------------------------
create table if not exists public.bids (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  created_by uuid not null references public.users(id) on delete restrict,
  assigned_trader_id uuid references public.users(id) on delete set null,
  customer_name text not null,
  customer_email text,
  job_name text,
  job_address text,
  job_state text,
  job_region text,
  status bid_status not null default 'received',
  due_date timestamptz,
  consolidation_mode consolidation_mode not null default 'structured',
  raw_file_url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bids_company_status_idx on public.bids(company_id, status);
create index if not exists bids_company_created_idx on public.bids(company_id, created_at desc);
create index if not exists bids_assigned_trader_idx on public.bids(assigned_trader_id);
create index if not exists bids_created_by_idx on public.bids(created_by);
create index if not exists bids_due_date_idx on public.bids(due_date);

drop trigger if exists trg_bids_updated_at on public.bids;
create trigger trg_bids_updated_at
before update on public.bids
for each row execute function public.set_updated_at();

alter table public.bids enable row level security;

-- SELECT — managers/owners/trader_buyers/buyers see all tenant bids;
-- pure traders only see bids they created or are assigned.
drop policy if exists bids_select on public.bids;
create policy bids_select on public.bids
  for select using (
    company_id = public.current_company_id()
    and (
      public.is_manager_or_owner()
      or public.has_role('trader_buyer')
      or public.has_role('buyer')
      or (
        public.has_role('trader')
        and (assigned_trader_id = auth.uid() or created_by = auth.uid())
      )
    )
  );

-- INSERT — any tenant user can create a bid; they must own it.
drop policy if exists bids_insert on public.bids;
create policy bids_insert on public.bids
  for insert
  with check (
    company_id = public.current_company_id()
    and created_by = auth.uid()
  );

-- UPDATE — mirrors SELECT visibility.
drop policy if exists bids_update on public.bids;
create policy bids_update on public.bids
  for update
  using (
    company_id = public.current_company_id()
    and (
      public.is_manager_or_owner()
      or public.has_role('trader_buyer')
      or public.has_role('buyer')
      or (
        public.has_role('trader')
        and (assigned_trader_id = auth.uid() or created_by = auth.uid())
      )
    )
  )
  with check (company_id = public.current_company_id());

-- DELETE — managers/owners only.
drop policy if exists bids_delete_manager on public.bids;
create policy bids_delete_manager on public.bids
  for delete
  using (
    company_id = public.current_company_id()
    and public.is_manager_or_owner()
  );
