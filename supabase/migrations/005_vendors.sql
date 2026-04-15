-- =============================================================================
-- LMBR.ai migration 005 — vendors
-- Built by Worklighter.
--
-- Per-tenant vendor list — mills, wholesalers, distributors, retailers.
-- Every vendor carries the commodity types they stock and the regions
-- they service so the routing engine can filter candidates automatically.
-- min_order_mbf is enforced at dispatch time: the UI never sends small
-- orders to vendors that would reject them, which protects the trader's
-- relationships with high-volume mills.
-- =============================================================================

do $$ begin
  create type vendor_type as enum ('mill', 'wholesaler', 'distributor', 'retailer');
exception when duplicate_object then null; end $$;

create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  contact_name text,
  email text,
  phone text,
  vendor_type vendor_type not null default 'wholesaler',
  commodities text[] not null default '{}',
  regions text[] not null default '{}',
  min_order_mbf numeric(12,2) not null default 0,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vendors_company_idx on public.vendors(company_id);
create index if not exists vendors_company_active_idx on public.vendors(company_id, active);
create index if not exists vendors_commodities_gin on public.vendors using gin(commodities);
create index if not exists vendors_regions_gin on public.vendors using gin(regions);

drop trigger if exists trg_vendors_updated_at on public.vendors;
create trigger trg_vendors_updated_at
before update on public.vendors
for each row execute function public.set_updated_at();

alter table public.vendors enable row level security;

drop policy if exists vendors_tenant on public.vendors;
create policy vendors_tenant on public.vendors
  for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());
