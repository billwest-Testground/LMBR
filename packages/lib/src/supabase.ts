/**
 * Supabase client factories — platform-agnostic anon + service-role.
 *
 * Purpose:  Exposes two Supabase clients that work from any runtime in the
 *           LMBR.ai monorepo (web API routes, background jobs, mobile).
 *           The browser/session-scoped SSR clients used by Next.js live in
 *           apps/web/src/lib/supabase/* — those wrap @supabase/auth-helpers
 *           so the anon client picks up the authenticated cookie session.
 *           Use getSupabaseAdmin() only from trusted server contexts —
 *           service-role bypasses RLS and must never ship to a client.
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

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.length === 0) {
    throw new Error(
      `LMBR.ai: missing required environment variable ${key}. ` +
        `Populate it in .env.local (web) or the mobile runtime config.`,
    );
  }
  return value;
}

let anonSingleton: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (anonSingleton) return anonSingleton;
  anonSingleton = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  return anonSingleton;
}

let adminSingleton: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (adminSingleton) return adminSingleton;
  adminSingleton = createClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  return adminSingleton;
}

export type { SupabaseClient };
export { createClient };
