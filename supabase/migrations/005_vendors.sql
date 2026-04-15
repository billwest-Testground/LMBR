-- =============================================================================
-- LMBR.ai migration 005 — vendors
-- Built by Worklighter.
--
-- Upstream lumber mills / suppliers the Buyer solicits. Commodity and region
-- tags feed the routing-agent's vendor shortlist generator.
-- =============================================================================

create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  contact_name text,
  contact_email text,
  contact_phone text,
  regions text[] not null default '{}',
  commodities text[] not null default '{}',
  preferred boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendors_company_idx on public.vendors(company_id);

drop trigger if exists trg_vendors_updated_at on public.vendors;
create trigger trg_vendors_updated_at
before update on public.vendors
for each row execute function public.set_updated_at();

alter table public.vendors enable row level security;

drop policy if exists vendors_all on public.vendors;
create policy vendors_all on public.vendors
  for all using (company_id = public.jwt_company_id());
