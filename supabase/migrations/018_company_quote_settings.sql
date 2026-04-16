-- =============================================================================
-- LMBR.ai migration 018 — company_quote_settings
-- Built by Worklighter.
--
-- Adds company-scoped quote configuration: manager-approval threshold,
-- minimum blended margin, UI preset margins, and a per-company quote
-- sequence counter. All four are referenced by the margin stack UI
-- (Prompt 07 Part 2) and the margin API (Prompt 07 Part 1).
--
-- Defaults picked for reasonable out-of-box behavior: $50k approval
-- gate, 5% minimum blended margin, common preset stack, quote sequence
-- starts at 1000 so test data doesn't collide with migration fixtures.
--
-- RLS note — the existing `companies_update_manager` policy (migration
-- 002) already restricts ALL writes on public.companies to managers and
-- owners of the same tenant. These four new columns are plain additions
-- to that table and inherit that restriction — no additional column-
-- level layering required. If a future migration loosens
-- companies_update_manager, re-audit this assumption.
-- =============================================================================

alter table public.companies
  add column if not exists approval_threshold_dollars numeric(14,2) not null default 50000.00,
  add column if not exists min_margin_percent numeric(7,4) not null default 0.0500,
  add column if not exists margin_presets jsonb not null default '[0.08, 0.10, 0.12, 0.15, 0.18]'::jsonb,
  add column if not exists quote_number_seq integer not null default 1000;

comment on column public.companies.approval_threshold_dollars is
  'Grand-total (subtotal + taxes) above which a quote must clear the '
  'manager-approval gate before release. Set via Settings UI; default $50k.';

comment on column public.companies.min_margin_percent is
  'Blended-margin floor below which /api/margin flags `belowMinimumMargin`. '
  'Expressed as a fraction (0.05 = 5%). Managers can still override.';

comment on column public.companies.margin_presets is
  'UI preset ladder for the margin-stack screen. Array of fractions. '
  'Example default: [0.08, 0.10, 0.12, 0.15, 0.18]. Order preserved.';

comment on column public.companies.quote_number_seq is
  'Per-company monotonic quote sequence counter. Advanced atomically by '
  'public.next_quote_number() to mint human-readable quote ids like '
  '`ACME-01023`. Starts at 1000 so seed fixtures do not collide.';

-- -----------------------------------------------------------------------------
-- next_quote_number — atomic per-company quote sequence allocator.
--
-- security definer so it works under either the session client (called
-- from the quote API route after role gating) or the service-role
-- client. Tenancy is enforced by the caller passing the company_id
-- they've already verified against the session. No row visibility
-- change here — we only mutate the one companies row.
-- -----------------------------------------------------------------------------
create or replace function public.next_quote_number(p_company_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  next_seq integer;
begin
  update public.companies
     set quote_number_seq = quote_number_seq + 1
   where id = p_company_id
  returning quote_number_seq into next_seq;
  if next_seq is null then
    raise exception 'company_not_found: %', p_company_id;
  end if;
  return next_seq;
end;
$$;

grant execute on function public.next_quote_number(uuid) to authenticated;
