/**
 * POST /api/margin — Apply margin stack; gate manager approval.
 *
 * Purpose:  Trader POSTs a margin percent for a bid. The pricing-agent
 *           runs the margin stack and returns whether manager approval is
 *           required. A Manager-Owner role is required to approve.
 * Inputs:   { bidId, marginPct }.
 * Outputs:  { needsApproval, totals, warnings[] }.
 * Agent/API: @lmbr/agents pricing-agent.
 * Imports:  @lmbr/agents, @lmbr/types, @lmbr/lib.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

export async function POST(_req: NextRequest): Promise<NextResponse> {
  throw new Error('Not implemented');
}
