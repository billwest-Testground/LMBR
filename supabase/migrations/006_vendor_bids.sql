-- =============================================================================
-- LMBR.ai migration 006 — vendor_bids
-- Built by Worklighter.
--
-- One row per (bid, vendor) when the Buyer dispatches a request for
-- pricing. submission_method captures how the vendor will respond —
-- digital form, camera-scanned price sheet, or emailed PDF — so the
-- ingest pipeline knows which extraction path to run on raw_response_url.
--
-- Individual price lines live in the separate 007_vendor_bid_line_items
-- table so that a single vendor_bid can carry dozens of line prices
-- without inflating this row.
-- =============================================================================

do $$ begin
  create type vendor_bid_status as enum (
    'pending', 'submitted', 'partial', 'declined', 'expired'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type vendor_submission_method as enum ('form', 'scan', 'email');
exception when duplicate_object then null; end $$;

create table if not exists public.vendor_bids (
  id uuid primary key default gen_random_uuid(),
  bid_id uuid not null references public.bids(id) on delete cascade,
  vendor_id uuid not null references public.vendors(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  sent_at timestamptz,
  due_by timestamptz,
  submitted_at timestamptz,
  status vendor_bid_status not null default 'pending',
  submission_method vendor_submission_method not null default 'form',
  raw_response_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bid_id, vendor_id)
);

create index if not exists vendor_bids_bid_idx on public.vendor_bids(bid_id);
create index if not exists vendor_bids_vendor_idx on public.vendor_bids(vendor_id);
create index if not exists vendor_bids_company_status_idx on public.vendor_bids(company_id, status);

drop trigger if exists trg_vendor_bids_updated_at on public.vendor_bids;
create trigger trg_vendor_bids_updated_at
before update on public.vendor_bids
for each row execute function public.set_updated_at();

alter table public.vendor_bids enable row level security;

-- Vendor dispatch metadata is visible to any tenant user who can see the
-- parent bid. Pricing (vendor_bid_line_items) is restricted separately.
drop policy if exists vendor_bids_tenant on public.vendor_bids;
create policy vendor_bids_tenant on public.vendor_bids
  for all
  using (
    company_id = public.current_company_id()
    and bid_id in (select id from public.bids)
  )
  with check (
    company_id = public.current_company_id()
    and bid_id in (select id from public.bids)
  );
