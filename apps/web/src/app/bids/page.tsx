/**
 * /bids — company-wide bid pipeline index.
 *
 * Purpose:  Canonical list view of every bid in the tenant. Reuses the
 *           trader panel's data pull + stat cards + status filters,
 *           which already respect RLS (pure traders see their own,
 *           trader_buyers/buyers/managers see all). Primary entry
 *           point from the sidebar "Bids" nav item.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { TraderPanel } from '../../components/dashboard/trader-panel';

export const dynamic = 'force-dynamic';

export default function BidsIndexPage() {
  return <TraderPanel />;
}
