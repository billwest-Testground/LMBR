-- =============================================================================
-- LMBR.ai migration 021 — bids.message_id (Outlook webhook idempotency)
-- Built by Worklighter.
--
-- The Graph webhook handler (apps/web/src/app/api/webhook/outlook) creates
-- a bid row for every RFQ attachment (or body-only email). Graph can and
-- does redeliver the same change notification — a transient 5xx on our
-- side, a proxy timeout, or simply its own at-least-once guarantee — so
-- we need an idempotency key that collapses retries into a single bid.
--
-- Key shape: `{graphMessageId}` for body-only emails, or
-- `{graphMessageId}:{attachmentId}` when the bid originates from a
-- specific attachment. The colon-delimited form lets a single inbound
-- email with N attachments produce N distinct bids (N lumber lists =
-- N independent quote workflows, per the Worklighter SDS convention)
-- while keeping every bid uniquely reattachable to its Graph source.
--
-- The unique index is partial — message_id stays NULL for bids created
-- via the human-driven /api/ingest upload path, and we must not block
-- those with a NOT NULL on a legacy column.
-- =============================================================================

alter table public.bids
  add column if not exists message_id text;

create unique index if not exists bids_company_message_id_unique
  on public.bids(company_id, message_id)
  where message_id is not null;

comment on column public.bids.message_id is
  'Graph message idempotency key written by the Outlook webhook. '
  'Format: `{messageId}` for body-only or `{messageId}:{attachmentId}` '
  'when the bid came from a specific attachment. NULL for bids created '
  'through the manual /api/ingest upload path.';
