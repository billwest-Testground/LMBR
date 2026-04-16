-- =============================================================================
-- LMBR.ai migration 017 — vendor_bid tokens
-- Built by Worklighter.
--
-- Adds tokenized submission columns to public.vendor_bids. Each dispatched
-- vendor bid carries a stateless HMAC-signed token that authenticates the
-- vendor on the public submission URL (no login) and is embedded in the
-- printable PDF tally (as text + QR) for scan-back attribution.
--
--   - token            the serialized `<b64url(payload)>.<b64url(sig)>`
--                      string issued at dispatch. Nullable so historical
--                      vendor_bids rows (pre-Prompt-05) remain valid and
--                      so a future rotate/revoke flow can NULL the column.
--   - token_expires_at mirrors the expiry inside the signed payload, but
--                      lives on the row so the status board can render
--                      "expired" without decoding the token.
--
-- Signature + expiry enforcement lives in @lmbr/lib/vendor-token; this
-- migration only provides storage and a uniqueness guarantee so the
-- submission API can look up the vendor_bid by token in one round trip.
-- =============================================================================

alter table public.vendor_bids
  add column if not exists token text,
  add column if not exists token_expires_at timestamptz;

create unique index if not exists vendor_bids_token_unique
  on public.vendor_bids(token)
  where token is not null;

comment on column public.vendor_bids.token is
  'Stateless HMAC-SHA256 signed submission token in '
  '`<b64url(payload)>.<b64url(sig)>` format. Issued at dispatch, '
  'embedded in the fillable form URL and printable PDF. Validated by '
  '@lmbr/lib/vendor-token on every submission; re-checked against '
  'this row to defeat the "token for Bid A used on Bid B" case. '
  'Nullable for pre-Prompt-05 rows and future rotate/revoke flows.';

comment on column public.vendor_bids.token_expires_at is
  'Mirror of the expiresAt field inside the signed token payload. '
  'Lets the status board render expiry without decoding the token.';
