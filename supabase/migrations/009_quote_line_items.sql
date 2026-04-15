-- =============================================================================
-- LMBR.ai migration 009 — quote_line_items
-- Built by Worklighter.
--
-- Per-line cost / margin / sell-price breakdown for a quote. building_tag
-- and phase_number are denormalized from the source line_item so the PDF
-- renderer can group rows under their original building without joining
-- back — this matters for hybrid consolidation where the vendor-facing
-- aggregate and the customer-facing breakdown must co-exist.
--
-- The customer-facing PDF (quotes.pdf_url) renders from sell_price only.
-- cost_price / margin_percent exist in this table for internal reporting
-- and for the Worklighter margin-stacking agent — they never appear on
-- the released document.
-- =============================================================================

create table if not exists public.quote_line_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  line_item_id uuid not null references public.line_items(id) on delete restrict,
  vendor_bid_line_item_id uuid references public.vendor_bid_line_items(id) on delete set null,
  company_id uuid not null references public.companies(id) on delete cascade,
  cost_price numeric(14,4) not null default 0,
  margin_percent numeric(7,4) not null default 0,
  sell_price numeric(14,4) not null default 0,
  extended_sell numeric(14,2) not null default 0,
  building_tag text,
  phase_number integer,
  sort_order integer not null default 0,
  unique (quote_id, line_item_id)
);

create index if not exists qli_quote_idx on public.quote_line_items(quote_id, sort_order);
create index if not exists qli_line_item_idx on public.quote_line_items(line_item_id);
create index if not exists qli_vbli_idx on public.quote_line_items(vendor_bid_line_item_id);
create index if not exists qli_company_idx on public.quote_line_items(company_id);

alter table public.quote_line_items enable row level security;

-- Inherit quote visibility via the quote_id subquery.
drop policy if exists qli_tenant on public.quote_line_items;
create policy qli_tenant on public.quote_line_items
  for all
  using (
    company_id = public.current_company_id()
    and quote_id in (select id from public.quotes)
  )
  with check (
    company_id = public.current_company_id()
    and quote_id in (select id from public.quotes)
  );
