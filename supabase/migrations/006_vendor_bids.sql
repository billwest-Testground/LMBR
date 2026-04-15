-- =============================================================================
-- LMBR.ai migration 006 — vendor_bids + vendor_bid_line_items
-- Built by Worklighter.
--
-- Vendor responses to the Buyer's solicitations. One vendor_bid row per
-- (bid, vendor); child vendor_bid_line_items hold the extracted price lines
-- matched back to the original consolidated request.
-- =============================================================================

do $$ begin
  create type vendor_bid_status as enum ('requested', 'received', 'extracted', 'declined', 'expired');
exception when duplicate_object then null; end $$;

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
