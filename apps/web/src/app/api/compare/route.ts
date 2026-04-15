/**
 * POST /api/compare — Best-price selection across vendor bids.
 *
 * Purpose:  Runs the comparison-agent over all received vendor bids for a
 *           given bid id and returns per-line best-price selections and a
 *           matrix for the UI.
 * Inputs:   { bidId }.
 * Outputs:  { selections[], matrix[][] }.
 * Agent/API: @lmbr/agents comparison-agent.
 * Imports:  @lmbr/agents, @lmbr/types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

export async function POST(_req: NextRequest): Promise<NextResponse> {
  throw new Error('Not implemented');
}
