/**
 * Supabase browser client (client components).
 *
 * Purpose:  Session-aware Supabase client for React client components.
 *           Uses @supabase/ssr — the successor to the deprecated
 *           @supabase/auth-helpers-nextjs package. `createBrowserClient`
 *           binds the anon client to the cookie session so RLS resolves
 *           auth.uid() correctly on every query.
 *
 *           Prerender-safe: `createBrowserClient` defers its
 *           `document.cookie` reads until the first query or auth call,
 *           so importing this module during `next build`'s prerender
 *           pass doesn't explode the way the older auth-helpers did
 *           inside `_recoverAndRefresh`.
 *
 * Inputs:   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY.
 * Outputs:  getSupabaseBrowserClient().
 * Agent/API: Supabase Auth + Postgres.
 * Imports:  @supabase/ssr.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getSupabaseBrowserClient(): SupabaseClient {
  if (client) return client;
  client = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  return client;
}
