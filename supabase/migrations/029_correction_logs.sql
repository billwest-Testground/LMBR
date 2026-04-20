-- =============================================================================
-- LMBR.ai migration 029 — correction_logs
-- Built by Worklighter.
--
-- Every time a trader saves an edit to an AI-extracted line item, write
-- a row here. Each row captures the pre-edit state, the post-edit state,
-- and a structured delta. This is the labeled training dataset for the
-- future small-language-model fine-tune path described in CLAUDE.md
-- "SLM / AI Independence Strategy" — ~50k rows of
-- (extracted → corrected) pairs is the target before the fine-tune
-- pipeline is worth standing up.
--
-- Writers are NOT allowed to fail the user's edit because the correction
-- log write errored. The API route treats the insert as fire-and-forget:
-- if it throws the edit still commits and a warn-level log fires. The
-- schema is forgiving (no NOT NULLs on jsonb beyond the non-nullable
-- core identity + delta) so a malformed delta still succeeds.
--
-- RLS: tenant isolation. Managers + owners can read every tenant row
-- for audit. Traders + buyers can read their own corrections (they may
-- want to see what they changed on a bid they're revisiting). Writes
-- are allowed for the acting user against their own tenant; the API
-- route is the only writer in practice.
--
-- Retention: indefinite — corrections are training data, not
-- operational telemetry. A future housekeeping job may roll up +
-- delete rows older than N months once the fine-tune dataset is built.
-- =============================================================================

create table if not exists public.correction_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bid_id uuid not null references public.bids(id) on delete cascade,
  line_item_id uuid references public.line_items(id) on delete set null,
  -- Loose coupling to the extraction event — nullable because a
  -- correction can be applied to a line that was entered manually
  -- and never went through the AI pipeline. Fine-tune pipeline will
  -- filter on this being non-null.
  extraction_id uuid,
  original_extraction jsonb not null,
  corrected_extraction jsonb not null,
  correction_delta jsonb not null,
  corrected_by uuid references public.users(id) on delete set null,
  corrected_at timestamptz not null default now()
);

create index if not exists correction_logs_company_time_idx
  on public.correction_logs(company_id, corrected_at desc);
create index if not exists correction_logs_bid_idx
  on public.correction_logs(bid_id, corrected_at desc);
create index if not exists correction_logs_line_item_idx
  on public.correction_logs(line_item_id);

alter table public.correction_logs enable row level security;

drop policy if exists correction_logs_select_tenant on public.correction_logs;
create policy correction_logs_select_tenant on public.correction_logs
  for select
  using (company_id = public.current_company_id());

drop policy if exists correction_logs_insert_self on public.correction_logs;
create policy correction_logs_insert_self on public.correction_logs
  for insert
  with check (
    company_id = public.current_company_id()
    and corrected_by = auth.uid()
  );

-- No UPDATE / DELETE policies — corrections are append-only. Mistaken
-- rows can be superseded by later rows rather than edited in place,
-- which matches the fine-tune dataset semantics (later entries win).

comment on column public.correction_logs.correction_delta is
  'Structured diff between original_extraction and corrected_extraction. '
  'Shape: { fieldsChanged: string[], details: {<field>: {before, after}} }. '
  'Written by the line-item edit API — fine-tune pipeline reads this '
  'directly without re-diffing.';

comment on column public.correction_logs.extraction_id is
  'Loose reference to the extraction event that produced the original '
  'line. NULLable because manually-entered lines can still be corrected. '
  'Fine-tune pipeline filters on IS NOT NULL.';
