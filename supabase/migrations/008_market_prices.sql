-- =============================================================================
-- LMBR.ai migration 008 — market_prices
-- Built by Worklighter.
--
-- Market intel feed. Accepts both company-scoped internal cash rows and
-- global Random Lengths reference rows (company_id IS NULL). Drives the
-- market-intel dashboard and the budget-quote fast-path.
-- =============================================================================

create table if not exists public.market_prices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  commodity_id text not null,
  region text,
  source text not null,
  unit_price numeric(12,4) not null,
  price_per text not null default 'mbf',
  currency char(3) not null default 'USD',
  recorded_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists market_prices_commodity_recorded_idx
  on public.market_prices(commodity_id, recorded_at desc);

create trigger trg_market_prices_updated_at
before update on public.market_prices
for each row execute function public.set_updated_at();

alter table public.market_prices enable row level security;

create policy market_prices_select on public.market_prices
  for select using (
    company_id is null or company_id = public.jwt_company_id()
  );
create policy market_prices_mutate on public.market_prices
  for all using (company_id = public.jwt_company_id());
