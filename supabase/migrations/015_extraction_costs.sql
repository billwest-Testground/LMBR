-- =============================================================================
-- LMBR.ai migration 015 — extraction_costs
-- Built by Worklighter.
--
-- Per-phase cost ledger for the tiered ingest engine. Every extraction a
-- bid passes through writes one or more rows here: one for the analyzer
-- pass (usually 0 cents), one for the parser (also 0), optionally one for
-- OCR, optionally one for Claude Mode A or Mode B, and one for the Haiku
-- QA pass. Rolling up by company_id + created_at powers the manager /
-- owner "extraction cost this month" dashboard.
--
-- Why phase-granular instead of a single cost on line_items:
--
--   line_items.cost_cents captures the *line's* cost (how much it cost to
--   get THIS row into the system). extraction_costs captures the *bid's*
--   cost (how much we spent on each agent / OCR call while processing
--   this bid). These are different views — one is item-level for in-row
--   UX, the other is method-level for analytics and threshold tuning.
--
--   Splitting Mode A from Mode B specifically lets us answer "is the
--   0.92 threshold set correctly" empirically. If Mode A is catching
--   most of the spend, the threshold is too conservative; if Mode B is,
--   it's too aggressive.
--
-- This table is write-mostly (fire-and-forget from the orchestrator) and
-- read by managers only. A write failure does not break the ingest flow —
-- the cost-tracker lib logs and swallows errors so a transient DB blip
-- never blocks a bid from reaching the reviewing state.
-- =============================================================================

create table if not exists public.extraction_costs (
  id         uuid primary key default gen_random_uuid(),
  bid_id     uuid not null references public.bids(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  method     text not null,
  cost_cents numeric(8,4) not null,
  created_at timestamptz not null default now()
);

-- Manager dashboard "this month's extraction spend" query: filtered by
-- company and ordered by recency.
create index if not exists extraction_costs_company_created_idx
  on public.extraction_costs(company_id, created_at desc);

-- Per-bid breakdown — used by the review page to show "this bid cost
-- you 0.15 cents" so traders internalize that Excel lists are free and
-- scanned handwriting is not.
create index if not exists extraction_costs_bid_idx
  on public.extraction_costs(bid_id);

-- Method-level rollup for threshold tuning and capacity planning.
create index if not exists extraction_costs_company_method_idx
  on public.extraction_costs(company_id, method);

alter table public.extraction_costs enable row level security;

-- SELECT — any authenticated user in the company can read their own
-- company's extraction costs. The manager / owner dashboard is the
-- primary consumer but traders can also see per-bid totals on the bid
-- review page.
drop policy if exists extraction_costs_select_tenant on public.extraction_costs;
create policy extraction_costs_select_tenant on public.extraction_costs
  for select
  using (company_id = public.current_company_id());

-- INSERT / UPDATE / DELETE — service role only. Orchestrator writes via
-- the admin client; no user-facing mutation path exists. Postgres denies
-- non-service-role writes by default when no policy is declared.
