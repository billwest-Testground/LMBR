-- =============================================================================
-- LMBR.ai migration 024 — market_price_snapshots
-- Built by Worklighter.
--
-- Append-only daily roll-ups of the LMBR Cash Market Index. Every row is
-- one (species, dimension, grade, region, unit) slice on one sample_date,
-- with the distribution stats computed across every company's vendor bids
-- for that slice on that day.
--
-- The Index is the long-term moat — not the software. More broker
-- tenants → more underlying vendor_bid_line_items → tighter price
-- distributions → more accurate signal than Random Lengths, which is a
-- survey of posted prices, not transactions. This table is the persisted
-- form of that signal; the aggregation job (Step 4) fills it.
--
-- Anonymization floor:
--   company_count CHECK (company_count >= 3). The aggregator never
--   inserts a slice with fewer than three distinct companies' bids
--   because two rows could be reverse-engineered back to specific
--   vendors. Tenants that want a thinly-traded species to appear in
--   the dashboard get "Insufficient data" instead of a price.
--
-- Idempotency:
--   UNIQUE(species, dimension, grade, region, unit, sample_date) lets
--   the aggregator use INSERT ... ON CONFLICT DO NOTHING so re-running
--   a day is a no-op. Append-only spirit preserved — we never UPDATE;
--   corrections to a prior day would be a policy decision, not a
--   routine operation.
--
-- Stored nullable: dimension / grade / region. A "Cedar, any dimension,
-- any grade, any region" rollup is a legitimate use case for the
-- ticker bar and lives on NULL / NULL / NULL. The unique key treats
-- NULLs distinctly as usual for Postgres — which means multiple
-- rows with dimension=NULL can exist for different (grade, region)
-- pairs, which is the behavior we want.
--
-- RLS:
--   Read: any authenticated user in any tenant — the Index is shared
--   reference data, not per-company reveal.
--   Write: no policy → service-role-only (the aggregation job).
-- =============================================================================

create table if not exists public.market_price_snapshots (
  id uuid primary key default gen_random_uuid(),
  species text not null,
  dimension text,
  grade text,
  region text,
  unit text not null check (unit in ('mbf', 'msf', 'piece')),
  sample_date date not null,
  -- Anonymization floor — see comment at top. The aggregator enforces
  -- the same rule in TS before the insert; this is defense-in-depth.
  company_count integer not null check (company_count >= 3),
  -- Total contributing bids (vendor_bid_line_items rows). Can be much
  -- larger than company_count — one company might contribute 40 bids
  -- on a single-species slice in a hot market day.
  sample_size integer not null check (sample_size >= company_count),
  price_median numeric(14,2) not null check (price_median >= 0),
  price_mean numeric(14,2) not null check (price_mean >= 0),
  price_low numeric(14,2) not null check (price_low >= 0),
  price_high numeric(14,2) not null check (price_high >= price_low),
  price_spread numeric(14,2) not null check (price_spread >= 0),
  created_at timestamptz not null default now()
);

create unique index if not exists market_price_snapshots_slice_day_unique
  on public.market_price_snapshots(
    species,
    coalesce(dimension, ''),
    coalesce(grade, ''),
    coalesce(region, ''),
    unit,
    sample_date
  );

-- History queries (sparkline on dashboard card): every day of a slice.
create index if not exists market_price_snapshots_slice_date_idx
  on public.market_price_snapshots(species, dimension, grade, region, sample_date desc);

-- "All slices for today" dashboard landing query.
create index if not exists market_price_snapshots_date_idx
  on public.market_price_snapshots(sample_date desc);

alter table public.market_price_snapshots enable row level security;

drop policy if exists market_price_snapshots_read_authenticated
  on public.market_price_snapshots;
create policy market_price_snapshots_read_authenticated
  on public.market_price_snapshots
  for select to authenticated using (true);

comment on table public.market_price_snapshots is
  'LMBR Cash Market Index — daily anonymized aggregate of vendor bid '
  'prices. Append-only, service-role writes only. The aggregation job '
  'at /api/market/aggregate builds this; dashboard reads it.';

comment on column public.market_price_snapshots.company_count is
  'Distinct companies contributing vendor bids to this slice-day. '
  'Enforced CHECK >= 3 — anonymization floor. The aggregator skips '
  'slices below this threshold entirely.';

comment on column public.market_price_snapshots.price_spread is
  'Convenience column: price_high - price_low. Computed once at '
  'insert so the sparkline + card UI does not recompute on every read.';
