/**
 * Comparison agent — best vendor price per line item across vendor bids.
 *
 * Purpose:  Given multiple vendor bids for a single consolidated request,
 *           score each vendor line on normalized unit price (converting
 *           piece / bf / mbf / lf), freight inclusion, and terms, and
 *           return the best-fit selection per line. Drives the comparison
 *           matrix UI and feeds pricing-agent with authoritative cost.
 * Inputs:   { companyId, bidId }.
 * Outputs:  { selections: Array<{ lineItemId, vendorBidLineItemId, unitCost }>,
 *             matrix[][] }.
 * Agent/API: Anthropic Claude (tie-breaking reasoning).
 * Imports:  @lmbr/types, zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export interface ComparisonSelection {
  lineItemId: string;
  vendorBidLineItemId: string;
  vendorId: string;
  unitCost: number;
  rationale: string;
}

export interface ComparisonResult {
  selections: ComparisonSelection[];
  matrix: Array<Array<number | null>>;
}

export async function comparisonAgent(
  _input: { companyId: string; bidId: string },
): Promise<ComparisonResult> {
  throw new Error('Not implemented');
}
