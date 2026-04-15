-- =============================================================================
-- LMBR.ai migration 001 — companies + shared trigger function
-- Built by Worklighter.
--
-- Creates the tenant root table, the canonical `set_updated_at()` trigger
-- function used by every other LMBR.ai table, and the JWT helper functions
-- that back row-level security across the schema.
-- =============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.jwt_company_id()
returns uuid
language sql stable
as $$ select nullif(auth.jwt() ->> 'company_id', '')::uuid $$;

do $$ begin
  create type user_role as enum ('trader', 'buyer', 'trader_buyer', 'manager_owner');
exception when duplicate_object then null; end $$;

create or replace function public.jwt_has_role(target user_role)
returns boolean
language sql stable
as $$
  select coalesce(
    (select target::text = any(
      string_to_array(coalesce(auth.jwt() ->> 'roles', ''), ',')
    )),
    false
  )
$$;

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  legal_name text,
  timezone text not null default 'America/Los_Angeles',
  default_margin_pct numeric(6,4) not null default 0.08,
  manager_approval_threshold numeric(12,2) not null default 0,
  random_lengths_subscription boolean not null default false,
  address jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_companies_updated_at
before update on public.companies
for each row execute function public.set_updated_at();

alter table public.companies enable row level security;

create policy companies_select on public.companies
  for select using (id = public.jwt_company_id());
create policy companies_update on public.companies
  for update using (id = public.jwt_company_id() and public.jwt_has_role('manager_owner'));
