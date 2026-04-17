-- =============================================================================
-- LMBR.ai migration 019 — outlook_connections
-- Built by Worklighter.
--
-- One Microsoft Graph OAuth connection per (user_id, company_id). Stores
-- the tokens needed to send mail from the user's own Outlook account and
-- to pull RFQ attachments out of the monitored inbox. Emails from LMBR
-- always come from the connected user's mailbox — see CLAUDE.md rule #5
-- — so this row is the per-user auth handle for everything email.
--
-- The access_token + refresh_token columns are AES-256-GCM ciphertext
-- written by packages/lib/src/crypto.ts. The encryption key lives in
-- OUTLOOK_TOKEN_ENCRYPTION_KEY (env) so compromise of a DB dump alone
-- does not yield working Microsoft tokens. The columns are `text` (not
-- `bytea`) because the serialized blob is base64url-joined ASCII and
-- we want text-search-friendly diagnostics in admin tooling.
--
-- RLS:
--   - The user who owns the row can select / update / delete it.
--   - Managers and owners of the company can select rows so the admin
--     dashboard can show "who is connected" at a glance. Note the
--     tokens are ciphertext to every SQL caller; the application layer
--     is the only thing that ever decrypts them, and only in the
--     service-role code path that needs to call Graph.
-- =============================================================================

do $$ begin
  create type outlook_connection_status as enum (
    'active',
    'expired',
    'revoked'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.outlook_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  -- AES-256-GCM ciphertext: `<iv>.<ciphertext>.<tag>` base64url joined.
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  email text not null,
  display_name text,
  connected_at timestamptz not null default now(),
  last_used_at timestamptz,
  status outlook_connection_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A user reconnecting Outlook overwrites their existing row rather than
-- accumulating stale rows with orphaned refresh tokens. The /api/auth
-- callback upserts on (user_id, company_id).
create unique index if not exists outlook_connections_user_company_unique
  on public.outlook_connections(user_id, company_id);

create index if not exists outlook_connections_company_idx
  on public.outlook_connections(company_id);

create index if not exists outlook_connections_email_idx
  on public.outlook_connections(email);

drop trigger if exists trg_outlook_connections_updated_at
  on public.outlook_connections;
create trigger trg_outlook_connections_updated_at
before update on public.outlook_connections
for each row execute function public.set_updated_at();

alter table public.outlook_connections enable row level security;

-- SELECT — own row OR (manager/owner + same tenant).
drop policy if exists outlook_connections_select on public.outlook_connections;
create policy outlook_connections_select on public.outlook_connections
  for select using (
    company_id = public.current_company_id()
    and (
      user_id = auth.uid()
      or public.is_manager_or_owner()
    )
  );

-- INSERT — a user can only create their own row.
drop policy if exists outlook_connections_insert on public.outlook_connections;
create policy outlook_connections_insert on public.outlook_connections
  for insert
  with check (
    user_id = auth.uid()
    and company_id = public.current_company_id()
  );

-- UPDATE — a user can only update their own row.
drop policy if exists outlook_connections_update on public.outlook_connections;
create policy outlook_connections_update on public.outlook_connections
  for update
  using (
    user_id = auth.uid()
    and company_id = public.current_company_id()
  )
  with check (
    user_id = auth.uid()
    and company_id = public.current_company_id()
  );

-- DELETE — a user can disconnect their own account; a manager/owner can
-- forcibly disconnect any user in their tenant (revoke compromised token).
drop policy if exists outlook_connections_delete on public.outlook_connections;
create policy outlook_connections_delete on public.outlook_connections
  for delete using (
    company_id = public.current_company_id()
    and (
      user_id = auth.uid()
      or public.is_manager_or_owner()
    )
  );

comment on table public.outlook_connections is
  'Per-user Microsoft Graph OAuth connection. Tokens are AES-256-GCM '
  'ciphertext (packages/lib/src/crypto.ts). Read by service-role via '
  'getGraphClient() in packages/lib/src/outlook.ts.';

comment on column public.outlook_connections.access_token is
  'Encrypted access_token. Format: `<iv>.<ciphertext>.<tag>` base64url. '
  'Never return decrypted value from any API.';

comment on column public.outlook_connections.refresh_token is
  'Encrypted refresh_token. Rotated by Graph on refresh; re-encrypted '
  'and updated in place by refreshAccessToken() in outlook.ts.';
