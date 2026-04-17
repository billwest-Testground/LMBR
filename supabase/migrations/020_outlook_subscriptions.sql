-- =============================================================================
-- LMBR.ai migration 020 — outlook_subscriptions
-- Built by Worklighter.
--
-- Tracks Microsoft Graph change-notification subscriptions on monitored
-- mailboxes. Graph subscriptions max out at ~3 days and must be renewed
-- or they silently stop delivering notifications — a dead subscription
-- is worse than a missing one because the trader thinks LMBR is
-- listening when it isn't. renewAllExpiringSoon() in outlook.ts scans
-- this table on a cron schedule; Prompt 11 wires the cron itself.
--
-- The clientState column is a per-subscription secret that Graph echoes
-- back on every change notification. /api/webhook/outlook (Prompt 08
-- step 2) compares the presented value to this column via
-- verifyOutlookClientState (timingSafeEqual) to reject spoofed webhooks.
--
-- RLS is the same shape as outlook_connections: users see their own,
-- managers/owners see all tenant rows. The service-role code path is
-- what writes to this table; RLS is defense-in-depth for diagnostic
-- reads from the admin dashboard.
-- =============================================================================

do $$ begin
  create type outlook_subscription_status as enum (
    'active',
    'degraded',
    'expired'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.outlook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  subscription_id text not null,
  resource text not null,
  expiration_datetime timestamptz not null,
  client_state text not null,
  last_renewed_at timestamptz,
  status outlook_subscription_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Graph subscription ids are globally unique; asserting uniqueness lets
-- the webhook handler load by id in a single round trip with no tenancy
-- ambiguity. The handler still cross-checks the loaded row's
-- company_id against the change notification payload.
create unique index if not exists outlook_subscriptions_subscription_id_unique
  on public.outlook_subscriptions(subscription_id);

-- Renewal scan hits active rows ordered by earliest expiry.
create index if not exists outlook_subscriptions_renewal_idx
  on public.outlook_subscriptions(expiration_datetime)
  where status = 'active';

create index if not exists outlook_subscriptions_user_company_idx
  on public.outlook_subscriptions(user_id, company_id);

drop trigger if exists trg_outlook_subscriptions_updated_at
  on public.outlook_subscriptions;
create trigger trg_outlook_subscriptions_updated_at
before update on public.outlook_subscriptions
for each row execute function public.set_updated_at();

alter table public.outlook_subscriptions enable row level security;

drop policy if exists outlook_subscriptions_select on public.outlook_subscriptions;
create policy outlook_subscriptions_select on public.outlook_subscriptions
  for select using (
    company_id = public.current_company_id()
    and (
      user_id = auth.uid()
      or public.is_manager_or_owner()
    )
  );

drop policy if exists outlook_subscriptions_insert on public.outlook_subscriptions;
create policy outlook_subscriptions_insert on public.outlook_subscriptions
  for insert
  with check (
    user_id = auth.uid()
    and company_id = public.current_company_id()
  );

drop policy if exists outlook_subscriptions_update on public.outlook_subscriptions;
create policy outlook_subscriptions_update on public.outlook_subscriptions
  for update
  using (
    company_id = public.current_company_id()
    and (
      user_id = auth.uid()
      or public.is_manager_or_owner()
    )
  )
  with check (
    company_id = public.current_company_id()
  );

drop policy if exists outlook_subscriptions_delete on public.outlook_subscriptions;
create policy outlook_subscriptions_delete on public.outlook_subscriptions
  for delete using (
    company_id = public.current_company_id()
    and (
      user_id = auth.uid()
      or public.is_manager_or_owner()
    )
  );

comment on table public.outlook_subscriptions is
  'Microsoft Graph change-notification subscription registry. '
  'Renewed by renewAllExpiringSoon() in packages/lib/src/outlook.ts.';

comment on column public.outlook_subscriptions.client_state is
  'Per-subscription secret echoed by Graph on every notification. '
  'Validate on inbound via verifyOutlookClientState (timingSafeEqual).';
