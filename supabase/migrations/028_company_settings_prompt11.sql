-- =============================================================================
-- LMBR.ai migration 028 — Prompt 11 company settings surface
-- Built by Worklighter.
--
-- Four column additions to public.companies plus a Storage bucket for
-- company-scoped logo uploads. Everything here is settings-UI-only
-- (Prompt 11) — no workflow code reads these fields today. They are
-- surfaced in the /settings pages and become inputs to downstream UX
-- (consolidation picker default, vendor dispatch region filter) in a
-- later prompt.
--
-- Columns:
--   logo_url                   — public URL served from the new
--                                company-logos Storage bucket. Stored as a
--                                fully-qualified URL rather than a bucket
--                                path so quote / dispatch PDFs can embed
--                                it without round-tripping Storage.
--   notification_prefs         — jsonb keyed by notification kind. V1
--                                picks a single jsonb column over a
--                                separate prefs table because prefs are
--                                read together and per-user overrides
--                                are explicitly out of scope (Prompt 11
--                                scope doc). A future per-user override
--                                column can live on public.users.
--   default_consolidation_mode — reuses the existing consolidation_mode
--                                enum from migration 003. Default matches
--                                the bids table default ('structured')
--                                so the column can be widened to NOT NULL
--                                immediately without backfill surprises.
--   job_regions_served         — text[] of RegionId values from
--                                packages/config/src/regions.ts. Stored
--                                as text[] rather than a new enum so the
--                                canonical list (five regions) can be
--                                extended in code without a migration.
--                                Empty array means "serves everywhere".
--
-- RLS: public.companies already has companies_update_manager (migration
-- 002) scoping UPDATE to manager/owner of the tenant. These new columns
-- inherit that policy — no column-level layering needed. API routes
-- still enforce the role check in-TypeScript for a crisp 403 path, same
-- pattern as migration 018 and 023.
-- =============================================================================

alter table public.companies
  add column if not exists logo_url text,
  add column if not exists notification_prefs jsonb not null default
    '{"new_bid_received":true,"vendor_bid_submitted":true,"quote_approved_rejected":true,"vendor_nudge_due":true}'::jsonb,
  add column if not exists default_consolidation_mode consolidation_mode not null default 'structured',
  add column if not exists job_regions_served text[] not null default '{}';

comment on column public.companies.logo_url is
  'Public URL of the company logo served from the company-logos Storage '
  'bucket. Embedded in customer-facing quote PDFs and the /settings UI.';

comment on column public.companies.notification_prefs is
  'Per-company notification toggles. Keys: new_bid_received, '
  'vendor_bid_submitted, quote_approved_rejected, vendor_nudge_due. '
  'Added in Prompt 11; per-user overrides live on users when needed.';

comment on column public.companies.default_consolidation_mode is
  'Default consolidation mode surfaced at bid-review time. Per-bid '
  'override still lives on public.bids.consolidation_mode.';

comment on column public.companies.job_regions_served is
  'RegionId values from @lmbr/config regions.ts. Empty array means '
  'the distributor serves every region. Used by the vendor dispatch '
  'shortlist and the budget-quote region-any fallback.';

-- -----------------------------------------------------------------------------
-- company-logos Storage bucket
--
-- Public bucket — logos are embedded in outbound quote PDFs which are
-- delivered to customers who are unauthenticated with respect to
-- Supabase. Treating the bucket as public keeps the PDF pipeline
-- simple (no presigned URLs in the render path) and matches what a
-- normal company web footer would do.
--
-- Path convention: `{companyId}/logo.{ext}`. The write policies below
-- enforce that convention by parsing the first path segment out of
-- storage.foldername(name)[1] and requiring it to equal the caller's
-- current_company_id(). Only managers/owners can write. Anyone can
-- read, matching the public nature of customer-facing quote PDFs.
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('company-logos', 'company-logos', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "company_logos_public_read" on storage.objects;
create policy "company_logos_public_read" on storage.objects
  for select
  using (bucket_id = 'company-logos');

drop policy if exists "company_logos_tenant_write" on storage.objects;
create policy "company_logos_tenant_write" on storage.objects
  for insert
  with check (
    bucket_id = 'company-logos'
    and public.is_manager_or_owner()
    and (storage.foldername(name))[1] = public.current_company_id()::text
  );

drop policy if exists "company_logos_tenant_update" on storage.objects;
create policy "company_logos_tenant_update" on storage.objects
  for update
  using (
    bucket_id = 'company-logos'
    and public.is_manager_or_owner()
    and (storage.foldername(name))[1] = public.current_company_id()::text
  )
  with check (
    bucket_id = 'company-logos'
    and public.is_manager_or_owner()
    and (storage.foldername(name))[1] = public.current_company_id()::text
  );

drop policy if exists "company_logos_tenant_delete" on storage.objects;
create policy "company_logos_tenant_delete" on storage.objects
  for delete
  using (
    bucket_id = 'company-logos'
    and public.is_manager_or_owner()
    and (storage.foldername(name))[1] = public.current_company_id()::text
  );
