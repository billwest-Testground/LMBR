-- =============================================================================
-- LMBR.ai migration 013 — notifications
-- Built by Worklighter.
--
-- In-app notifications surface for every LMBR.ai user. Rows are written
-- by backend routes (service role) whenever something actionable happens
-- — a bid gets routed to a buyer, a margin exceeds the manager-approval
-- threshold, a vendor submits pricing. Users mark their own rows read.
--
-- This is intentionally generic: type is a free-text string so downstream
-- features can add new notification kinds without schema migrations, and
-- link is an optional relative path the UI deep-links to on click.
-- Email delivery lives in PROMPT 08 (Outlook) — this table powers the
-- in-app bell icon immediately.
-- =============================================================================

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_created_idx
  on public.notifications(user_id, created_at desc);
create index if not exists notifications_user_unread_idx
  on public.notifications(user_id, created_at desc)
  where read_at is null;

alter table public.notifications enable row level security;

-- SELECT — users only see their own notifications, never anyone else's.
drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select using (user_id = auth.uid());

-- UPDATE — users can only mark their own notifications as read. The
-- WITH CHECK keeps the user_id from being rewritten to someone else.
drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
  for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- INSERT / DELETE — service role only. No public policy declared, so
-- Postgres denies non-service-role writes by default.
