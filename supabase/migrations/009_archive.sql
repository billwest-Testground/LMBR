-- =============================================================================
-- LMBR.ai migration 009 — archive_entries
-- Built by Worklighter.
--
-- Immutable archive of completed bids (won / lost). Snapshot column holds a
-- jsonb serialization of the bid, line items, vendor bids, and the released
-- quote for audit and re-quote backfill.
-- =============================================================================

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

create index if not exists archive_entries_company_idx
  on public.archive_entries(company_id, created_at desc);

drop trigger if exists trg_archive_entries_updated_at on public.archive_entries;
create trigger trg_archive_entries_updated_at
before update on public.archive_entries
for each row execute function public.set_updated_at();

alter table public.archive_entries enable row level security;

drop policy if exists archive_entries_all on public.archive_entries;
create policy archive_entries_all on public.archive_entries
  for all using (company_id = public.jwt_company_id());
