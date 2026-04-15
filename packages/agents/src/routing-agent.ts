/**
 * Routing agent — commodity + geography → buyer + vendor shortlist.
 *
 * Purpose:  Once a customer bid is ingested and QA'd, the routing agent
 *           decides which Buyer (internal) should own it and which vendors
 *           (mills / suppliers) should receive bid solicitations. Routing
 *           weighs commodity mix, job state → region (via @lmbr/config),
 *           vendor historical fit, and current workload. Respects role
 *           boundaries: a Trader-Buyer (unified) is routed both directly
 *           and via the Buyer queue.
 * Inputs:   { companyId, bidId }.
 * Outputs:  { buyerUserId, vendorIds[], rationale }.
 * Agent/API: Anthropic Claude (policy reasoning) + internal heuristics.
 * Imports:  @lmbr/types, @lmbr/config, zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export interface RoutingResult {
  buyerUserId: string;
  vendorIds: string[];
  rationale: string;
}

export async function routingAgent(
  _input: { companyId: string; bidId: string },
): Promise<RoutingResult> {
  throw new Error('Not implemented');
}
