/**
 * LMBR.ai auth middleware.
 *
 * Purpose:  Gatekeeper for every non-public route in the LMBR.ai web app.
 *           Runs on the Edge for every matched request, resolves the
 *           Supabase session from the request cookie, redirects based on
 *           auth state, and — for authenticated requests into a protected
 *           section — looks up the user's company_id + roles from Postgres
 *           and forwards them as x-lmbr-company-id / x-lmbr-roles request
 *           headers so downstream Server Components can read them without
 *           an extra round-trip. The live RLS-backed client is still the
 *           source of truth for data reads; these headers are only a
 *           performance-oriented context hint.
 * Inputs:   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *           Supabase auth cookie.
 * Outputs:  NextResponse with auth redirects / forwarded headers.
 * Agent/API: Supabase Auth + users/roles tables.
 * Imports:  @supabase/auth-helpers-nextjs, next/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { createMiddlewareClient } from '@supabase/auth-helpers-nextjs';
import { NextResponse, type NextRequest } from 'next/server';

const PROTECTED_PREFIXES = [
  '/dashboard',
  '/bids',
  '/vendors',
  '/market',
  '/archive',
  '/settings',
] as const;

const AUTH_PREFIXES = ['/login'] as const;

function isPrefixMatch(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export async function middleware(req: NextRequest) {
  const requestHeaders = new Headers(req.headers);
  // Strip any incoming attempts to spoof our tenancy headers — these are
  // only ever set by this middleware and must not be forwarded from the
  // public internet.
  requestHeaders.delete('x-lmbr-company-id');
  requestHeaders.delete('x-lmbr-roles');

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  const supabase = createMiddlewareClient({ req, res });

  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { pathname } = req.nextUrl;
  const isProtected = isPrefixMatch(pathname, PROTECTED_PREFIXES);
  const isAuthPage = isPrefixMatch(pathname, AUTH_PREFIXES);

  if (isProtected && !session) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (isAuthPage && session) {
    const url = req.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  if (session && isProtected) {
    const [{ data: profile }, { data: roleRows }] = await Promise.all([
      supabase
        .from('users')
        .select('company_id')
        .eq('id', session.user.id)
        .maybeSingle(),
      supabase.from('roles').select('role_type').eq('user_id', session.user.id),
    ]);

    // Onboarding gate: a signed-in user with no users row hasn't finished
    // the onboarding wizard yet. Funnel them back to it.
    if (!profile?.company_id && !pathname.startsWith('/onboarding')) {
      const url = req.nextUrl.clone();
      url.pathname = '/onboarding/company';
      url.search = '';
      return NextResponse.redirect(url);
    }

    if (profile?.company_id) {
      requestHeaders.set('x-lmbr-company-id', profile.company_id);
    }
    if (roleRows && roleRows.length > 0) {
      requestHeaders.set(
        'x-lmbr-roles',
        roleRows.map((r) => r.role_type).join(','),
      );
    }

    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  return res;
}

export const config = {
  matcher: [
    /*
     * Match every request except:
     *   • Next.js internals (/_next/*)
     *   • The API routes (their own auth is handled in-route)
     *   • Static assets (favicon, images, fonts, etc.)
     */
    '/((?!_next/static|_next/image|api/|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|otf|css|js|map)$).*)',
  ],
};
