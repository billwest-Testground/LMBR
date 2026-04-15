-- =============================================================================
-- LMBR.ai — clean-slate wipe
-- Built by Worklighter.
--
-- Run this ONCE in the Supabase SQL Editor (or via `supabase db reset`) to
-- drop every LMBR table, enum, and helper function from the previous
-- schema iteration. Safe against a hosted Supabase project: it does NOT
-- touch the auth, storage, realtime, extensions, or any Supabase system
-- schemas — only objects in the public schema that belong to LMBR.ai.
--
-- WARNING: destroys all LMBR tenant data. Only run this on a database
-- you intend to re-seed from scratch.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables — drop in child-first order so FK cascades stay tidy.
-- -----------------------------------------------------------------------------
drop table if exists public.quote_line_items cascade;
drop table if exists public.quotes             cascade;
drop table if exists public.vendor_bid_line_items cascade;
drop table if exists public.vendor_bids        cascade;
drop table if exists public.archive            cascade;
drop table if exists public.archive_entries    cascade;  -- legacy naming
drop table if exists public.market_prices      cascade;
drop table if exists public.line_items         cascade;
drop table if exists public.bids               cascade;
drop table if exists public.vendors            cascade;
drop table if exists public.commodity_assignments cascade;
drop table if exists public.roles              cascade;
drop table if exists public.user_roles         cascade;  -- legacy naming
drop table if exists public.users              cascade;
drop table if exists public.companies          cascade;

-- -----------------------------------------------------------------------------
-- 2. Helper functions (both current and legacy names).
-- -----------------------------------------------------------------------------
drop function if exists public.recompute_vendor_best_price()         cascade;
drop function if exists public.recompute_best_price_for_line_item()  cascade;
drop function if exists public.current_company_id()                  cascade;
drop function if exists public.is_manager_or_owner()                 cascade;
drop function if exists public.has_role(public.user_role_type)       cascade;
drop function if exists public.has_role(public.user_role)            cascade;
drop function if exists public.jwt_company_id()                      cascade;
drop function if exists public.jwt_has_role(public.user_role)        cascade;
drop function if exists public.set_updated_at()                      cascade;

-- -----------------------------------------------------------------------------
-- 3. Enums — dropped after the functions + tables that reference them.
-- -----------------------------------------------------------------------------
drop type if exists public.company_plan             cascade;
drop type if exists public.user_role_type           cascade;
drop type if exists public.user_role                cascade;  -- legacy naming
drop type if exists public.bid_status               cascade;
drop type if exists public.bid_source               cascade;  -- legacy
drop type if exists public.consolidation_mode       cascade;
drop type if exists public.vendor_type              cascade;
drop type if exists public.vendor_bid_status        cascade;
drop type if exists public.vendor_submission_method cascade;
drop type if exists public.quote_status             cascade;
drop type if exists public.market_source            cascade;

-- -----------------------------------------------------------------------------
-- After this script finishes, re-apply the LMBR migrations in order:
--   001_companies.sql
--   002_users_roles.sql
--   003_bids.sql
--   004_line_items.sql
--   005_vendors.sql
--   006_vendor_bids.sql
--   007_vendor_bid_line_items.sql
--   008_quotes.sql
--   009_quote_line_items.sql
--   010_market_prices.sql
--   011_archive.sql
-- =============================================================================
