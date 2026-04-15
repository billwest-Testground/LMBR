-- =============================================================================
-- LMBR.ai migration 002 — users, roles, commodity_assignments + RLS helpers
-- Built by Worklighter.
--
-- users.id is pinned to auth.users.id (one-to-one), so auth.uid() inside
-- RLS policies resolves directly to the LMBR user row. Tenancy is then
-- derived via current_company_id(), which reads the user's single
-- company_id off the users row. has_role() / is_manager_or_owner()
-- provide role-based gating without relying on custom JWT claims, so the
-- platform works with vanilla Supabase Auth out of the box.
--
-- `security definer` on the helpers bypasses RLS for their internal reads,
-- preventing infinite recursion when a policy on users/roles calls back
-- into the same table.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
do $$ begin
  create type user_role_type as enum (
    'trader', 'buyer', 'trader_buyer', 'manager', 'owner'
  );
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  email text not null,
  full_name text not null,
  avatar_url text,
  created_at timestamptz not null default now(),
  unique (company_id, email)
);

create index if not exists users_company_id_idx on public.users(company_id);

-- -----------------------------------------------------------------------------
-- roles — one role per user per company
-- -----------------------------------------------------------------------------
create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  role_type user_role_type not null,
  created_at timestamptz not null default now(),
  unique (user_id, company_id)
);

create index if not exists roles_user_idx on public.roles(user_id);
create index if not exists roles_company_idx on public.roles(company_id);
create index if not exists roles_company_type_idx on public.roles(company_id, role_type);

-- -----------------------------------------------------------------------------
-- commodity_assignments — per-buyer commodity + region coverage
-- -----------------------------------------------------------------------------
create table if not exists public.commodity_assignments (
  id uuid primary key default gen_random_uuid(),
  role_id uuid not null references public.roles(id) on delete cascade,
  commodity_type text not null,
  regions text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (role_id, commodity_type)
);

create index if not exists commodity_assignments_role_idx on public.commodity_assignments(role_id);

-- -----------------------------------------------------------------------------
-- RLS helper functions
-- -----------------------------------------------------------------------------
create or replace function public.current_company_id()
returns uuid
language sql stable
security definer
set search_path = public
as $$
  select company_id from public.users where id = auth.uid()
$$;

create or replace function public.has_role(target user_role_type)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.roles
     where user_id = auth.uid()
       and role_type = target
  )
$$;

create or replace function public.is_manager_or_owner()
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.roles
     where user_id = auth.uid()
       and role_type in ('manager', 'owner')
  )
$$;

grant execute on function public.current_company_id() to authenticated;
grant execute on function public.has_role(user_role_type) to authenticated;
grant execute on function public.is_manager_or_owner() to authenticated;

-- -----------------------------------------------------------------------------
-- companies — RLS policies (deferred from 001 until helpers exist)
-- -----------------------------------------------------------------------------
drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies
  for select using (id = public.current_company_id());

drop policy if exists companies_update_manager on public.companies;
create policy companies_update_manager on public.companies
  for update
  using (id = public.current_company_id() and public.is_manager_or_owner())
  with check (id = public.current_company_id() and public.is_manager_or_owner());

-- -----------------------------------------------------------------------------
-- users — RLS
-- -----------------------------------------------------------------------------
alter table public.users enable row level security;

drop policy if exists users_select_tenant on public.users;
create policy users_select_tenant on public.users
  for select using (company_id = public.current_company_id());

drop policy if exists users_insert_manager on public.users;
create policy users_insert_manager on public.users
  for insert
  with check (
    company_id = public.current_company_id()
    and public.is_manager_or_owner()
  );

drop policy if exists users_update_self on public.users;
create policy users_update_self on public.users
  for update
  using (id = auth.uid())
  with check (id = auth.uid() and company_id = public.current_company_id());

drop policy if exists users_update_manager on public.users;
create policy users_update_manager on public.users
  for update
  using (company_id = public.current_company_id() and public.is_manager_or_owner())
  with check (company_id = public.current_company_id() and public.is_manager_or_owner());

drop policy if exists users_delete_manager on public.users;
create policy users_delete_manager on public.users
  for delete
  using (company_id = public.current_company_id() and public.is_manager_or_owner());

-- -----------------------------------------------------------------------------
-- roles — RLS
-- -----------------------------------------------------------------------------
alter table public.roles enable row level security;

drop policy if exists roles_select_tenant on public.roles;
create policy roles_select_tenant on public.roles
  for select using (company_id = public.current_company_id());

drop policy if exists roles_mutate_manager on public.roles;
create policy roles_mutate_manager on public.roles
  for all
  using (company_id = public.current_company_id() and public.is_manager_or_owner())
  with check (company_id = public.current_company_id() and public.is_manager_or_owner());

-- -----------------------------------------------------------------------------
-- commodity_assignments — RLS (inherit via parent role)
-- -----------------------------------------------------------------------------
alter table public.commodity_assignments enable row level security;

drop policy if exists commodity_assignments_select_tenant on public.commodity_assignments;
create policy commodity_assignments_select_tenant on public.commodity_assignments
  for select using (
    role_id in (
      select id from public.roles where company_id = public.current_company_id()
    )
  );

drop policy if exists commodity_assignments_mutate_manager on public.commodity_assignments;
create policy commodity_assignments_mutate_manager on public.commodity_assignments
  for all
  using (
    public.is_manager_or_owner()
    and role_id in (
      select id from public.roles where company_id = public.current_company_id()
    )
  )
  with check (
    public.is_manager_or_owner()
    and role_id in (
      select id from public.roles where company_id = public.current_company_id()
    )
  );
