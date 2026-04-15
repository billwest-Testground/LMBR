/**
 * Supabase browser client (client components).
 *
 * Purpose:  Session-aware Supabase client for React client components. Uses
 *           @supabase/auth-helpers-nextjs so the anon client is pre-bound to
 *           the authenticated cookie session, enabling RLS to resolve
 *           auth.uid() correctly on every query.
 * Inputs:   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY.
 * Outputs:  getSupabaseBrowserClient().
 * Agent/API: Supabase Auth + Postgres.
 * Imports:  @supabase/auth-helpers-nextjs.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

let client: ReturnType<typeof createClientComponentClient> | null = null;

export function getSupabaseBrowserClient() {
  if (client) return client;
  client = createClientComponentClient();
  return client;
}
