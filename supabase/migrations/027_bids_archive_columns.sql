-- =============================================================================
-- LMBR.ai migration 027 — bids archive columns
-- Built by Worklighter.
--
-- Dedicated archive columns on public.bids. Per the CLAUDE.md design:
-- archiving is a separate lifecycle axis from the workflow status
-- (received/extracting/.../sent), not another terminal value on the
-- same enum. A quote can be `sent` and also archived; reactivation
-- restores access without changing status.
--
-- Single source of truth:
--   archived_at IS NULL   → bid is active (in pipeline or completed).
--   archived_at IS NOT NL → bid is archived; hidden from normal views,
--                           searchable via the knowledge-base tab.
--
-- The legacy `'archived'` value on public.bid_status (migration 003)
-- is NOT dropped — it's dormant but keeping it avoids an ALTER TYPE
-- migration that would require down-conversion work across every
-- code path. All writers use these new columns going forward.
--
-- archived_by intentionally NULL-ables on user delete. Retaining the
-- row's audit trail matters more than the FK — a company deleting a
-- user's auth row should not cascade into losing the archive history.
-- `on delete set null` preserves the timestamp, loses the identity.
-- =============================================================================

alter table public.bids
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.users(id) on delete set null;

-- Partial index — the "active bids" filter is the hot query across the
-- dashboard, trader panel, bid list, routing views, budget quote bid
-- selector. WHERE archived_at IS NULL means PostgreSQL skips every
-- archived row during these scans.
create index if not exists bids_active_by_company_created_idx
  on public.bids(company_id, created_at desc)
  where archived_at is null;

-- Partial index for the archive tab — opposite filter, ordered newest
-- archived first so the list view defaults to "recently archived".
create index if not exists bids_archived_by_company_idx
  on public.bids(company_id, archived_at desc)
  where archived_at is not null;

-- Index for the "bid multiple times" aggregation — group archived bids
-- by (customer_name, job_address) and count. Partial on archived_at
-- because the aggregation is scoped to the archive tab; active bids
-- aren't grouped this way.
create index if not exists bids_archived_group_idx
  on public.bids(company_id, customer_name, job_address)
  where archived_at is not null;

comment on column public.bids.archived_at is
  'Archive timestamp — NULL = active bid. Single source of truth for '
  'the archive / active filter. The legacy `archived` bid_status value '
  'is dormant; writers use this column going forward.';

comment on column public.bids.archived_by is
  'User who archived the bid. NULLable on user delete — we retain the '
  'audit timestamp even if the acting user is later removed.';
