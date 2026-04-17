-- =============================================================================
-- LMBR.ai migration 025 — market_futures
-- Built by Worklighter.
--
-- Cached CME lumber futures data from Barchart. Sentiment signal only —
-- the Cash Index in market_price_snapshots is the thing traders actually
-- price against. Futures give directional context ("the curve is
-- backwardated, the market expects softness by Q3") that matters for
-- the sales conversation but not for the quote-math.
--
-- One row per (symbol, contract_month). Refreshed every 15 minutes by
-- the refresh job at /api/market/futures/refresh; upsert on the unique
-- key so we never accumulate history — only the latest snapshot is
-- displayed. If historical futures become interesting later, switch to
-- append-only and drop the unique index.
--
-- Barchart occasionally returns partial rows (no open_interest on the
-- back months, e.g.). All quantitative columns except last_price are
-- nullable so partial fetches still land.
--
-- RLS:
--   Same shape as market_price_snapshots — authenticated read, service-
--   role write. Futures are public market data; no tenant gate needed.
-- =============================================================================

create table if not exists public.market_futures (
  id uuid primary key default gen_random_uuid(),
  -- Barchart root: 'LBR' for random-length lumber. Keeping this
  -- generic lets us add other commodities (plywood, OSB) later
  -- without a schema change.
  symbol text not null,
  -- Contract month label from Barchart — typically 'MAY26', 'JUL26',
  -- 'NOV26'. Stored as text not date because futures months have
  -- their own convention and are display-first.
  contract_month text not null,
  last_price numeric(14,2) not null check (last_price >= 0),
  -- Day change: signed dollar and percent. Null on partial rows.
  price_change numeric(14,2),
  price_change_pct numeric(8,4),
  open_interest integer,
  volume integer,
  fetched_at timestamptz not null default now(),
  -- Raw response kept as a debug breadcrumb so a bad parse doesn't
  -- lose the upstream payload. jsonb, nullable — callers drop it in
  -- production if it turns into noise.
  raw jsonb,
  created_at timestamptz not null default now()
);

-- One row per (symbol, contract_month) — upsert-on-conflict by refresh.
create unique index if not exists market_futures_symbol_contract_unique
  on public.market_futures(symbol, contract_month);

-- Dashboard query: "latest snapshot across all contracts for LBR".
create index if not exists market_futures_symbol_fetched_idx
  on public.market_futures(symbol, fetched_at desc);

alter table public.market_futures enable row level security;

drop policy if exists market_futures_read_authenticated on public.market_futures;
create policy market_futures_read_authenticated on public.market_futures
  for select to authenticated using (true);

comment on table public.market_futures is
  'CME lumber futures cache from Barchart. Latest snapshot per '
  '(symbol, contract_month); refreshed every ~15 minutes by the '
  '/api/market/futures/refresh cron target.';

comment on column public.market_futures.contract_month is
  'Barchart contract label (MAY26, JUL26, etc.) — display-first.';

comment on column public.market_futures.raw is
  'Upstream response body kept for debugging bad parses. Nullable; '
  'drop the column in a future migration if it becomes noise.';
