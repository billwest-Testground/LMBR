/**
 * Supabase server clients (server components + route handlers).
 *
 * Purpose:  Two factories for the Next.js server runtime: one for React
 *           Server Components (read-only cookies) and one for Route
 *           Handlers (read/write cookies, used for sign-in / sign-out
 *           flows). Both wrap @supabase/ssr — the successor to the
 *           deprecated @supabase/auth-helpers-nextjs — so auth.uid()
 *           resolves against the authenticated cookie session and RLS
 *           applies to every query.
 *
 *           Cookie handlers: RSC reads only, Route Handlers read + set.
 *           The set/remove branches for RSC deliberately no-op because
 *           Next's `cookies()` API returns a read-only proxy in that
 *           context — trying to mutate throws. The Route Handler
 *           variant forwards writes through the mutable cookies jar.
 *
 * Inputs:   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *           next/headers cookies().
 * Outputs:  getSupabaseRSCClient(), getSupabaseRouteHandlerClient().
 * Agent/API: Supabase Auth + Postgres.
 * Imports:  @supabase/ssr, next/headers.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';

function envUrl(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL!;
}
function envKey(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
}

export function getSupabaseRSCClient(): SupabaseClient {
  const cookieStore = cookies();
  return createServerClient(envUrl(), envKey(), {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      // RSC cookies are read-only under Next's request scope; the
      // underlying `cookies()` store throws on set. Supabase attempts
      // a refresh-token write on every call; we swallow the error so
      // the read path is unaffected.
      set(_name: string, _value: string, _options: CookieOptions) {
        // no-op
      },
      remove(_name: string, _options: CookieOptions) {
        // no-op
      },
    },
  });
}

export function getSupabaseRouteHandlerClient(): SupabaseClient {
  const cookieStore = cookies();
  return createServerClient(envUrl(), envKey(), {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value, ...options });
        } catch {
          // `cookies().set` throws when called outside a mutation
          // context (rare — happens when a Route Handler's response
          // headers are already committed). Safe to swallow; the next
          // request will refresh the cookie on its own.
        }
      },
      remove(name: string, options: CookieOptions) {
        try {
          cookieStore.set({ name, value: '', ...options });
        } catch {
          // Same rationale as `set` — see above.
        }
      },
    },
  });
}
