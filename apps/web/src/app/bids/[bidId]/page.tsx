/**
 * Bid detail page — canonical single-bid workspace.
 *
 * Purpose:  Shows the full lifecycle of one LMBR.ai bid: header, QA'd line
 *           items, vendor bid status chips, active stage (ingest → routed →
 *           vendor_pending → quoted), and deep links into consolidate,
 *           compare, margin, quote sub-surfaces.
 * Inputs:   params.bidId (uuid).
 * Outputs:  Bid detail JSX.
 * Agent/API: Supabase read; streams agent progress.
 * Imports:  @lmbr/types, @lmbr/lib.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export default function BidDetailPage({
  params: _params,
}: {
  params: { bidId: string };
}) {
  return <div>Not implemented: BidDetailPage</div>;
}
