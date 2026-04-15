-- =============================================================================
-- LMBR.ai migration 001 — companies (tenant root) + shared trigger function
-- Built by Worklighter.
--
-- The companies row is the multi-tenant anchor — every downstream LMBR.ai
-- table carries a company_id foreign key and is gated by RLS off of it.
--
-- Helpers that drive the rest of RLS (current_company_id, has_role,
-- is_manager_or_owner) live in 002 so they can reference public.users /
-- public.roles, which do not exist until that migration runs. Companies
-- RLS policies are therefore installed in 002 as well; this migration
-- only enables RLS on the table and creates the canonical updated_at
-- trigger function used by every LMBR.ai table.
-- =============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

-- -----------------------------------------------------------------------------
-- Shared updated_at trigger function (reused by every LMBR.ai table).
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
do $$ begin
  create type company_plan as enum ('starter', 'professional', 'enterprise');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- companies
-- -----------------------------------------------------------------------------
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  email_domain text,
  outlook_tenant_id text,
  outlook_client_id text,
  plan company_plan not null default 'starter',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists companies_email_domain_idx on public.companies(email_domain);
create index if not exists companies_active_idx on public.companies(active);

drop trigger if exists trg_companies_updated_at on public.companies;
create trigger trg_companies_updated_at
before update on public.companies
for each row execute function public.set_updated_at();

-- RLS is enabled here; tenant-aware policies are installed in 002 once
-- current_company_id() / is_manager_or_owner() exist.
alter table public.companies enable row level security;
