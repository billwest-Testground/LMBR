-- =============================================================================
-- LMBR.ai migration 022 — companies.timezone
-- Built by Worklighter.
--
-- Per-company IANA timezone string for rendering dates on customer- and
-- vendor-facing artifacts. Without a pinned timezone, the quote PDF's
-- "Date" + "Valid" fields and the vendor tally's "due by" label fall
-- back on the server's default zone — UTC on Vercel, local on dev. A
-- vendor receiving a paper tally printed on Vercel and a form link
-- rendered from a teammate's laptop could see two different due dates
-- for the same bid. That was already solved for the tally in
-- apps/web/src/lib/format-datetime.ts with a hardcoded default; this
-- migration lets each tenant override it.
--
-- Default: 'America/Los_Angeles'. Most wholesale lumber distributors on
-- the target list are West Coast; the handful of East Coast tenants can
-- UPDATE the row at onboarding (Prompt 11 will surface a picker in the
-- company settings page).
--
-- Values are stored verbatim as IANA names — the render code pipes the
-- string into Intl.DateTimeFormat's `timeZone` option, which validates
-- the identifier at format time and throws on unknown zones. We do NOT
-- add a CHECK constraint because the canonical list of valid IANA
-- zones is a moving target and the render-side error path is clear.
-- =============================================================================

alter table public.companies
  add column if not exists timezone text not null default 'America/Los_Angeles';

comment on column public.companies.timezone is
  'IANA timezone identifier for all customer- and vendor-facing dates '
  '(quote PDF Date + Valid, tally due-by). Read by the quote renderer '
  'at apps/web/src/lib/pdf/quote-pdf.tsx and by format-datetime.ts. '
  'Default matches the West Coast tenant majority; onboarding UX '
  '(Prompt 11) surfaces a picker.';
