/**
 * /dashboard/buyer — buyer queue dashboard.
 *
 * Purpose:  Dedicated buyer-only view. Renders the shared BuyerPanel
 *           which lists every bid_routings row assigned to the current
 *           user, joined with the parent bid metadata.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { BuyerPanel } from '../../../components/dashboard/buyer-panel';

export const dynamic = 'force-dynamic';

export default function BuyerDashboardPage() {
  return <BuyerPanel />;
}
