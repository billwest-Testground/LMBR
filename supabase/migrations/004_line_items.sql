-- =============================================================================
-- LMBR.ai migration 004 — line_items
-- Built by Worklighter.
--
-- Per-row lumber takeoff data. `house` / `phase` preserve the original
-- customer breakdown for the quote PDF; `consolidation_key` groups like
-- items so vendors get one clean line per SKU.
-- =============================================================================

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

drop trigger if exists trg_line_items_updated_at on public.line_items;
create trigger trg_line_items_updated_at
before update on public.line_items
for each row execute function public.set_updated_at();

alter table public.line_items enable row level security;

drop policy if exists line_items_all on public.line_items;
create policy line_items_all on public.line_items
  for all using (company_id = public.jwt_company_id());
