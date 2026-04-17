/**
 * Market intelligence dashboard.
 *
 * Purpose:  Thin server shell that gates the page on an authenticated
 *           session and delegates everything to <MarketClient />.
 *           Prompt 09 Step 6 — first public surface for the LMBR Cash
 *           Market Index.
 *
 *           No futures ticker in V1 — scope cut (see commit 04a9fe1).
 *           The page is Cash-Index-only today; a ticker bar reappears
 *           if/when a customer asks for one.
 *
 * Inputs:   session cookie.
 * Outputs:  JSX.
 * Agent/API: client fetches /api/market, /api/market/history,
 *            /api/market/budget-quote from the client island.
 * Imports:  next/navigation, ../../../lib/supabase/server,
 *           ./market-client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { redirect } from 'next/navigation';

import { getSupabaseRSCClient } from '../../../lib/supabase/server';

import { MarketClient } from './market-client';

export const dynamic = 'force-dynamic';

export default async function MarketDashboardPage() {
  const supabase = getSupabaseRSCClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  return <MarketClient />;
}
