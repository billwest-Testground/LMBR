/**
 * /dashboard/trader — trader dashboard page.
 *
 * Purpose:  Dedicated trader-only dashboard. Wraps the shared
 *           TraderPanel in the console shell. Pure traders see only
 *           their own bids (RLS-enforced); trader_buyers and managers
 *           hitting this URL see the full tenant via the same RLS rules
 *           but would normally land on /dashboard/unified via the index
 *           redirect.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { TraderPanel } from '../../../components/dashboard/trader-panel';

export const dynamic = 'force-dynamic';

export default function TraderDashboardPage() {
  return <TraderPanel />;
}
