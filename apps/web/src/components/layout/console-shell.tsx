/**
 * ConsoleShell — server-side wrapper for every authenticated console page.
 *
 * Purpose:  Fetches the current user's profile + primary role from
 *           Supabase (via the SSR client so RLS applies), then renders
 *           the sidebar + topbar frame with the real user data. Every
 *           protected section — /dashboard, /bids, /vendors, /market,
 *           /archive, /settings — imports this as its layout so users
 *           never see a stale or anonymous shell.
 *
 *           If the user has no public.users row yet, the middleware
 *           already redirected them to /onboarding/company. We defend
 *           against that anyway and send them onward if somehow they
 *           reached here without a profile.
 *
 * Inputs:   children: React.ReactNode.
 * Outputs:  layout JSX.
 * Imports:  next/headers, next/navigation, Supabase SSR client,
 *           ConsoleSidebar, ConsoleTopbar.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { redirect } from 'next/navigation';

import { getSupabaseRSCClient } from '../../lib/supabase/server';
import { ConsoleSidebar } from './console-sidebar';
import { ConsoleTopbar } from './console-topbar';

export async function ConsoleShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = getSupabaseRSCClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    redirect('/login');
  }

  const { data: profile } = await supabase
    .from('users')
    .select('id, full_name, company_id, companies:companies!inner(name)')
    .eq('id', session.user.id)
    .maybeSingle();

  if (!profile) {
    redirect('/onboarding/company');
  }

  const { data: roleRows } = await supabase
    .from('roles')
    .select('role_type')
    .eq('user_id', session.user.id);
  const roles = (roleRows ?? []).map((r) => r.role_type as string);
  const primaryRole = pickPrimaryRole(roles);

  type CompanyJoin = { name: string } | { name: string }[] | null;
  const companyJoin = profile.companies as CompanyJoin;
  const companyName = Array.isArray(companyJoin)
    ? (companyJoin[0]?.name ?? '')
    : (companyJoin?.name ?? '');

  return (
    <div className="relative min-h-screen bg-bg-base text-text-secondary">
      <ConsoleSidebar />
      <div className="md:pl-[240px]">
        <ConsoleTopbar
          fullName={profile.full_name}
          companyName={companyName}
          primaryRole={primaryRole}
        />
        <main className="mx-auto w-full max-w-[1400px] px-8 py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function pickPrimaryRole(roles: string[]): string {
  // Hierarchy: owner > manager > trader_buyer > buyer > trader > '—'
  const order = ['owner', 'manager', 'trader_buyer', 'buyer', 'trader'];
  for (const role of order) {
    if (roles.includes(role)) return role;
  }
  return '—';
}
