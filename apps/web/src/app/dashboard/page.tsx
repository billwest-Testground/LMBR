/**
 * Dashboard index — role-based redirect.
 *
 * Purpose:  Routes the signed-in user to the dashboard variant that
 *           matches their primary role. Owner / manager → /dashboard/manager
 *           (PROMPT 11 — stub for now), trader_buyer → /dashboard/unified,
 *           pure buyer → /dashboard/buyer, pure trader → /dashboard/trader.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { redirect } from 'next/navigation';

import { getSupabaseRSCClient } from '../../lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function DashboardIndex() {
  const supabase = getSupabaseRSCClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  const { data: profile } = await supabase
    .from('users')
    .select('id')
    .eq('id', session.user.id)
    .maybeSingle();
  if (!profile) redirect('/onboarding/company');

  const { data: roleRows } = await supabase
    .from('roles')
    .select('role_type')
    .eq('user_id', session.user.id);
  const roles = new Set((roleRows ?? []).map((r) => r.role_type as string));

  if (roles.has('owner') || roles.has('manager')) {
    redirect('/dashboard/manager');
  }
  if (roles.has('trader_buyer')) {
    redirect('/dashboard/unified');
  }
  if (roles.has('buyer')) {
    redirect('/dashboard/buyer');
  }
  if (roles.has('trader')) {
    redirect('/dashboard/trader');
  }

  // No matching role — treat as trader view for safety.
  redirect('/dashboard/trader');
}
