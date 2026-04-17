-- =============================================================================
-- LMBR.ai migration 023 — companies.*_email_subject
-- Built by Worklighter.
--
-- Per-company subject-line overrides for the three outbound email
-- templates. NULL means "use the hardcoded default in
-- packages/lib/src/outlook.ts"; a non-null value wins.
--
-- Scope intentionally narrow — only the subject is user-editable for
-- Prompt 08. The full body editor lands in Prompt 11. A subject is the
-- quickest wedge for making the emails feel branded without building
-- rich HTML editing infrastructure up front, and it's the line that
-- actually shows in every vendor / customer inbox listing.
--
-- Placeholder syntax is deliberately NOT supported yet — whatever the
-- user types in the settings UI is the exact subject that sends. This
-- dodges the whole "what if the placeholder name is wrong" mess until
-- Prompt 11 can ship a proper template editor with a variable picker.
-- =============================================================================

alter table public.companies
  add column if not exists dispatch_email_subject text,
  add column if not exists nudge_email_subject text,
  add column if not exists quote_email_subject text;

comment on column public.companies.dispatch_email_subject is
  'Override subject for vendor dispatch emails. NULL = use the default '
  'built by outlook.sendDispatchToVendor. Exact literal; no placeholder '
  'interpolation (Prompt 11 will add a template editor).';

comment on column public.companies.nudge_email_subject is
  'Override subject for vendor nudge emails. NULL = use default.';

comment on column public.companies.quote_email_subject is
  'Override subject for customer quote-delivery emails. NULL = use default.';
