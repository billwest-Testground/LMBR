/**
 * Supabase client factories — browser anon + server service-role.
 *
 * Purpose:  Exposes two Supabase clients for LMBR.ai: an anon-keyed client
 *           for browser/session-scoped reads, and a service-role admin
 *           client for server-side bypass (used by webhook handlers and
 *           background jobs that must write across RLS boundaries). All
 *           LMBR.ai data — companies, users, bids, line items, vendors,
 *           vendor_bids, quotes, market_prices, archive_entries — lives in
 *           Supabase Postgres.
 * Inputs:   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *           SUPABASE_SERVICE_ROLE_KEY.
 * Outputs:  getSupabaseClient(), getSupabaseAdmin().
 * Agent/API: Supabase Postgres + Auth.
 * Imports:  @supabase/supabase-js.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export function getSupabaseClient(): SupabaseClient {
  throw new Error('Not implemented');
}

export function getSupabaseAdmin(): SupabaseClient {
  throw new Error('Not implemented');
}

// Keep reference to the import so tree-shakers don't drop the type re-export.
export type { SupabaseClient };
export { createClient };
