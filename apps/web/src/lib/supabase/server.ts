/**
 * Supabase server clients (server components + route handlers).
 *
 * Purpose:  Two factories for the Next.js server runtime: one for React
 *           Server Components (read-only cookies) and one for Route
 *           Handlers (read/write cookies, used for sign-in / sign-out
 *           flows). Both wrap @supabase/auth-helpers-nextjs so auth.uid()
 *           resolves against the authenticated cookie session and RLS
 *           applies to every query.
 * Inputs:   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *           next/headers cookies().
 * Outputs:  getSupabaseRSCClient(), getSupabaseRouteHandlerClient().
 * Agent/API: Supabase Auth + Postgres.
 * Imports:  @supabase/auth-helpers-nextjs, next/headers.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import {
  createRouteHandlerClient,
  createServerComponentClient,
} from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';

export function getSupabaseRSCClient() {
  return createServerComponentClient({ cookies });
}

export function getSupabaseRouteHandlerClient() {
  return createRouteHandlerClient({ cookies });
}
