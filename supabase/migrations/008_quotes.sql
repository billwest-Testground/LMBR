-- =============================================================================
-- LMBR.ai migration 008 — quotes
-- Built by Worklighter.
--
-- Customer-facing quote artifact — the downstream side of the LMBR
-- pipeline after vendor selection and margin application. Vendor names
-- and cost_price never leave this layer for the PDF: only subtotal,
-- margin, taxes, and total appear on the generated document
-- (see quote_line_items.sell_price and quotes.pdf_url).
--
-- Approval gating: the approval fields (approved_by, approved_at) and
-- the 'approved' / 'sent' statuses can only be set by managers/owners.
-- RLS WITH CHECK rejects non-manager writes that attempt to populate
-- those columns, so the manager approval gate is enforced at the DB
-- level — not just in the API.
-- =============================================================================

do $$ begin
  create type quote_status as enum (
    'draft',
    'pending_approval',
    'approved',
    'sent',
    'accepted',
    'declined'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  bid_id uuid not null references public.bids(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  created_by uuid not null references public.users(id) on delete restrict,
  approved_by uuid references public.users(id) on delete set null,
  status quote_status not null default 'draft',
  subtotal numeric(14,2) not null default 0,
  margin_percent numeric(7,4) not null default 0,
  margin_dollars numeric(14,2) not null default 0,
  lumber_tax numeric(14,2) not null default 0,
  sales_tax numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  pdf_url text,
  sent_at timestamptz,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists quotes_bid_idx on public.quotes(bid_id);
create index if not exists quotes_company_status_idx on public.quotes(company_id, status);
create index if not exists quotes_created_by_idx on public.quotes(created_by);

drop trigger if exists trg_quotes_updated_at on public.quotes;
create trigger trg_quotes_updated_at
before update on public.quotes
for each row execute function public.set_updated_at();

alter table public.quotes enable row level security;

-- SELECT — quotes inherit bid visibility. Pure traders still see their
-- own bid quotes via the bids RLS subquery.
drop policy if exists quotes_select on public.quotes;
create policy quotes_select on public.quotes
  for select using (
    company_id = public.current_company_id()
    and bid_id in (select id from public.bids)
  );

-- INSERT — tenant user must own the draft.
drop policy if exists quotes_insert on public.quotes;
create policy quotes_insert on public.quotes
  for insert
  with check (
    company_id = public.current_company_id()
    and created_by = auth.uid()
    and bid_id in (select id from public.bids)
    -- Non-managers cannot create a quote pre-approved.
    and (approved_by is null or public.is_manager_or_owner())
    and (approved_at is null or public.is_manager_or_owner())
    and (status in ('draft', 'pending_approval') or public.is_manager_or_owner())
  );

-- UPDATE — tenant users can edit drafts / pending quotes; only
-- managers/owners can write the approval columns or escalate the
-- status into approved/sent.
drop policy if exists quotes_update on public.quotes;
create policy quotes_update on public.quotes
  for update
  using (
    company_id = public.current_company_id()
    and bid_id in (select id from public.bids)
  )
  with check (
    company_id = public.current_company_id()
    and (approved_by is null or public.is_manager_or_owner())
    and (approved_at is null or public.is_manager_or_owner())
    and (status not in ('approved', 'sent') or public.is_manager_or_owner())
  );

drop policy if exists quotes_delete_manager on public.quotes;
create policy quotes_delete_manager on public.quotes
  for delete
  using (
    company_id = public.current_company_id()
    and public.is_manager_or_owner()
  );
