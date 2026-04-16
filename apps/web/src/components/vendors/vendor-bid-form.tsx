/**
 * VendorBidForm — outgoing RFQ builder.
 *
 * Purpose:  Composes the vendor-facing RFQ (consolidated lines, due date,
 *           freight terms) that gets emailed via Outlook integration.
 * Inputs:   { bidId, consolidatedLines }.
 * Outputs:  JSX.
 * Agent/API: Outlook send via /api/vendors (future extension).
 * Imports:  @lmbr/types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

// Deferred: fleshed out as part of Prompt 08 (Outlook email composer). The
// Prompt 05 dispatch flow uses the token-based submit + print pages, so
// this component has no consumers in the current build.
export function VendorBidForm() {
  return <div>Not implemented: VendorBidForm</div>;
}
