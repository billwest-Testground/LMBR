-- =============================================================================
-- LMBR.ai migration 010 — market_prices
-- Built by Worklighter.
--
-- Time-series cash-market pricing. No company_id: market_prices is a
-- shared read-only reference table consumed by the market-agent to power
-- the Cash Market Index and Budget Quote Mode. Writes happen exclusively
-- through the service role (the ingest jobs aggregate anonymized vendor
-- bids and pull CME futures via Barchart), so no write policy is declared
-- for the authenticated role — Postgres denies by default.
-- =============================================================================

do $$ begin
  create type market_source as enum ('vendor_aggregated', 'cme_futures', 'manual');
exception when duplicate_object then null; end $$;

create table if not exists public.market_prices (
  id uuid primary key default gen_random_uuid(),
  species text not null,
  dimension text,
  grade text,
  region text,
  source market_source not null,
  price_per_mbf numeric(14,2) not null,
  sample_size integer,
  recorded_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists market_prices_species_recorded_idx
  on public.market_prices(species, recorded_at desc);
create index if not exists market_prices_region_recorded_idx
  on public.market_prices(region, recorded_at desc);
create index if not exists market_prices_source_idx on public.market_prices(source);

alter table public.market_prices enable row level security;

-- Every authenticated user in any tenant can read market data.
-- There is no public write policy — service-role ingest bypasses RLS.
drop policy if exists market_prices_read_authenticated on public.market_prices;
create policy market_prices_read_authenticated on public.market_prices
  for select to authenticated using (true);
