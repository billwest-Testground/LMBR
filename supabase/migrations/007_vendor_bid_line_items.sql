-- =============================================================================
-- LMBR.ai migration 007 — vendor_bid_line_items
-- Built by Worklighter.
--
-- Extracted price lines from each vendor_bid, matched back to the
-- requesting line_item. unit_price × quantity is persisted as total_price
-- at insert/update time so the comparison matrix can render without
-- per-row arithmetic.
--
-- is_best_price is the cheapest unit_price across all vendor responses
-- for a given line_item_id. A trigger keeps it in sync as quotes come
-- in, revise, or get retracted; pg_trigger_depth() guards against the
-- recursive self-update firing the trigger forever.
--
-- RLS: vendor prices are trade-sensitive and are restricted to users
-- whose role actually needs them — buyers, trader_buyers, managers,
-- and owners. Pure traders never see vendor pricing; their view of
-- selected pricing comes through quote_line_items after the buyer has
-- finalized vendor selection.
-- =============================================================================

create table if not exists public.vendor_bid_line_items (
  id uuid primary key default gen_random_uuid(),
  vendor_bid_id uuid not null references public.vendor_bids(id) on delete cascade,
  line_item_id uuid not null references public.line_items(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  unit_price numeric(14,4),
  total_price numeric(14,2),
  notes text,
  is_best_price boolean not null default false,
  created_at timestamptz not null default now(),
  unique (vendor_bid_id, line_item_id)
);

create index if not exists vbli_line_item_idx on public.vendor_bid_line_items(line_item_id);
create index if not exists vbli_vendor_bid_idx on public.vendor_bid_line_items(vendor_bid_id);
create index if not exists vbli_line_best_idx
  on public.vendor_bid_line_items(line_item_id)
  where is_best_price = true;

-- -----------------------------------------------------------------------------
-- is_best_price maintenance
-- -----------------------------------------------------------------------------
create or replace function public.recompute_vendor_best_price()
returns trigger
language plpgsql
as $$
declare
  target_line_item_id uuid;
  best_id uuid;
begin
  target_line_item_id := coalesce(new.line_item_id, old.line_item_id);

  update public.vendor_bid_line_items
     set is_best_price = false
   where line_item_id = target_line_item_id
     and is_best_price = true;

  select id
    into best_id
    from public.vendor_bid_line_items
   where line_item_id = target_line_item_id
     and unit_price is not null
   order by unit_price asc, created_at asc
   limit 1;

  if best_id is not null then
    update public.vendor_bid_line_items
       set is_best_price = true
     where id = best_id;
  end if;

  return null;
end;
$$;

drop trigger if exists trg_vbli_best_price on public.vendor_bid_line_items;
create trigger trg_vbli_best_price
after insert or delete or update of unit_price, line_item_id
on public.vendor_bid_line_items
for each row
when (pg_trigger_depth() < 2)
execute function public.recompute_vendor_best_price();

alter table public.vendor_bid_line_items enable row level security;

-- SELECT — vendor pricing restricted to buyer-aligned roles + managers/owners.
drop policy if exists vbli_select on public.vendor_bid_line_items;
create policy vbli_select on public.vendor_bid_line_items
  for select using (
    company_id = public.current_company_id()
    and (
      public.is_manager_or_owner()
      or public.has_role('buyer')
      or public.has_role('trader_buyer')
    )
  );

-- INSERT / UPDATE / DELETE — buyers, trader_buyers, managers, owners.
drop policy if exists vbli_mutate on public.vendor_bid_line_items;
create policy vbli_mutate on public.vendor_bid_line_items
  for all
  using (
    company_id = public.current_company_id()
    and (
      public.is_manager_or_owner()
      or public.has_role('buyer')
      or public.has_role('trader_buyer')
    )
  )
  with check (
    company_id = public.current_company_id()
    and (
      public.is_manager_or_owner()
      or public.has_role('buyer')
      or public.has_role('trader_buyer')
    )
  );
