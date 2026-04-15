/**
 * POST /api/route-bid — Route a bid to a Buyer and propose vendor shortlist.
 *
 * Purpose:  Runs the routing-agent over a QA'd bid and writes back the
 *           assigned buyer + vendor shortlist. Respects role boundaries
 *           (trader-buyer unified users are queued both directly and via
 *           the buyer lane).
 * Inputs:   { bidId }.
 * Outputs:  { buyerUserId, vendorIds[], rationale }.
 * Agent/API: @lmbr/agents routing-agent.
 * Imports:  @lmbr/agents, @lmbr/types, @lmbr/config.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

export async function POST(_req: NextRequest): Promise<NextResponse> {
  throw new Error('Not implemented');
}
