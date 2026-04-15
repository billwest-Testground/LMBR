-- =============================================================================
-- LMBR.ai migration 002 — users + user_roles
-- Built by Worklighter.
--
-- Adds the platform `users` table (bridging auth.users to a tenant) and the
-- many-to-many `user_roles` join. Roles gate the Ingest / Route / Vendor-Bid
-- / Consolidate / Compare / Margin / Quote workflows per-action via RLS.
-- =============================================================================

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  auth_user_id uuid unique,
  email text not null,
  full_name text not null,
  phone text,
  avatar_url text,
  is_active boolean not null default true,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, email)
);

create index if not exists users_company_id_idx on public.users(company_id);

create trigger trg_users_updated_at
before update on public.users
for each row execute function public.set_updated_at();

alter table public.users enable row level security;

create policy users_select on public.users
  for select using (company_id = public.jwt_company_id());
create policy users_mutate_manager on public.users
  for all using (
    company_id = public.jwt_company_id() and public.jwt_has_role('manager_owner')
  );

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role user_role not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, role)
);

create index if not exists user_roles_company_user_idx on public.user_roles(company_id, user_id);

create trigger trg_user_roles_updated_at
before update on public.user_roles
for each row execute function public.set_updated_at();

alter table public.user_roles enable row level security;

create policy user_roles_select on public.user_roles
  for select using (company_id = public.jwt_company_id());
create policy user_roles_mutate_manager on public.user_roles
  for all using (
    company_id = public.jwt_company_id() and public.jwt_has_role('manager_owner')
  );
