-- =============================================================================
-- LMBR.ai migration 012 — bid_routings
-- Built by Worklighter.
--
-- A single bid may be split-routed across multiple buyers: Frank in Texas
-- takes the dimensional framing, Sarah in California takes the EWP and
-- panels. One bid_routings row captures one (buyer, commodity_group) slice
-- of the bid, with line_item_ids recording exactly which rows the buyer
-- owns. Unrouted line items are not persisted — they are derived at read
-- time as (all line_items for the bid) − (union of routed line_item_ids).
--
-- Trader-buyer unified self-route produces one row with buyer_user_id
-- equal to the submitting user and commodity_group 'All'.
--
-- RLS matches bids: managers/owners, trader_buyers, and buyers see every
-- routing in their tenant so the UI can show the full map; pure traders
-- see rows only for bids they can see (via the bids subquery). The
-- assigned buyer additionally passes the mutate policy for their own row.
-- =============================================================================

do $$ begin
  create type routing_status as enum (
    'pending', 'accepted', 'in_progress', 'submitted', 'completed'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.bid_routings (
  id uuid primary key default gen_random_uuid(),
  bid_id uuid not null references public.bids(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  buyer_user_id uuid not null references public.users(id) on delete cascade,
  commodity_group text not null,
  line_item_ids uuid[] not null default '{}',
  status routing_status not null default 'pending',
  notification_sent_at timestamptz,
  accepted_at timestamptz,
  completed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bid_id, buyer_user_id, commodity_group)
);

create index if not exists bid_routings_bid_idx on public.bid_routings(bid_id);
create index if not exists bid_routings_buyer_status_idx
  on public.bid_routings(company_id, buyer_user_id, status);
create index if not exists bid_routings_line_items_gin
  on public.bid_routings using gin(line_item_ids);

drop trigger if exists trg_bid_routings_updated_at on public.bid_routings;
create trigger trg_bid_routings_updated_at
before update on public.bid_routings
for each row execute function public.set_updated_at();

alter table public.bid_routings enable row level security;

-- SELECT — tenant users see every routing for bids they can see. The
-- bids subquery inherits the bids RLS policy, which already restricts
-- pure traders to their own bids.
drop policy if exists bid_routings_select on public.bid_routings;
create policy bid_routings_select on public.bid_routings
  for select using (
    company_id = public.current_company_id()
    and bid_id in (select id from public.bids)
  );

-- INSERT / UPDATE — managers, owners, trader_buyers, buyers, and the
-- buyer to whom the routing is assigned.
drop policy if exists bid_routings_mutate on public.bid_routings;
create policy bid_routings_mutate on public.bid_routings
  for all
  using (
    company_id = public.current_company_id()
    and (
      public.is_manager_or_owner()
      or public.has_role('trader_buyer')
      or public.has_role('buyer')
      or buyer_user_id = auth.uid()
    )
  )
  with check (
    company_id = public.current_company_id()
  );
