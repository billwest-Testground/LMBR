-- =============================================================================
-- LMBR.ai migration 011 — archive
-- Built by Worklighter.
--
-- Long-tail knowledge base of raw uploads + their extracted JSON. The
-- ingest pipeline writes one archive row per inbound file, then flips
-- `processed` when the extraction agent has consumed it. Downstream
-- retrieval agents (pricing, comparison) query this table to learn from
-- prior jobs — which is why the tenant RLS isolation is critical: one
-- company's historical pricing is never exposed to another.
-- =============================================================================

create table if not exists public.archive (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bid_id uuid references public.bids(id) on delete set null,
  file_url text not null,
  file_type text,
  extracted_data jsonb,
  processed boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists archive_company_idx on public.archive(company_id, created_at desc);
create index if not exists archive_bid_idx on public.archive(bid_id);
create index if not exists archive_processed_idx on public.archive(company_id, processed);
create index if not exists archive_extracted_gin on public.archive using gin(extracted_data);

alter table public.archive enable row level security;

drop policy if exists archive_tenant on public.archive;
create policy archive_tenant on public.archive
  for all
  using (company_id = public.current_company_id())
  with check (company_id = public.current_company_id());
