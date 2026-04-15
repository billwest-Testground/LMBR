-- =============================================================================
-- LMBR.ai migration 004 — line_items
-- Built by Worklighter.
--
-- Lumber-list rows extracted from the customer RFQ. Each line item belongs
-- to a single bid and is grouped by (building_tag, phase_number) to
-- preserve the customer's structural intent all the way through to the
-- quote PDF.
--
-- Consolidation source mapping: when the trader selects consolidated or
-- hybrid mode, the system inserts new line_items with is_consolidated=true
-- whose original_line_item_id points back at the source row. That
-- back-pointer is the core of hybrid mode — vendors see the aggregated
-- tally while the customer quote rebuilds the per-building breakdown.
--
-- RLS: line_items inherit bid visibility via a subquery against
-- public.bids, so RLS on bids cascades naturally (pure traders cannot see
-- line items for bids they cannot see).
-- =============================================================================

create table if not exists public.line_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bid_id uuid not null references public.bids(id) on delete cascade,
  building_tag text,
  phase_number integer,
  species text not null,
  dimension text not null,
  grade text,
  length text,
  quantity numeric(14,4) not null,
  unit text not null default 'PCS' check (unit in ('PCS', 'MBF', 'MSF')),
  board_feet numeric(14,4),
  notes text,
  is_consolidated boolean not null default false,
  original_line_item_id uuid references public.line_items(id) on delete set null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists line_items_bid_idx on public.line_items(bid_id, sort_order);
create index if not exists line_items_bid_building_idx
  on public.line_items(bid_id, building_tag, phase_number);
create index if not exists line_items_original_idx
  on public.line_items(original_line_item_id);
create index if not exists line_items_company_idx on public.line_items(company_id);

alter table public.line_items enable row level security;

-- Inherit bid visibility — the bids RLS policy already restricts pure
-- traders to their own bids, and the subquery below is evaluated under
-- that policy, so line_items for hidden bids are automatically filtered.
drop policy if exists line_items_tenant on public.line_items;
create policy line_items_tenant on public.line_items
  for all
  using (
    company_id = public.current_company_id()
    and bid_id in (select id from public.bids)
  )
  with check (
    company_id = public.current_company_id()
    and bid_id in (select id from public.bids)
  );
