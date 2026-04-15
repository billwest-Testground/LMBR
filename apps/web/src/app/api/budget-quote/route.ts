/**
 * POST /api/budget-quote — Market-priced ballpark quote, no vendor cycle.
 *
 * Purpose:  For a Trader who needs a ballpark sell number NOW. Uses market
 *           intel (cash + Random Lengths) and the current margin stack to
 *           produce a budget quote without running a vendor solicitation.
 * Inputs:   { customerName, region?, lines: [{commodityId, quantity}], marginPct }.
 * Outputs:  BudgetQuote.
 * Agent/API: @lmbr/agents market-agent (generateBudgetQuote).
 * Imports:  @lmbr/agents, @lmbr/types (BudgetQuoteSchema).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

export async function POST(_req: NextRequest): Promise<NextResponse> {
  throw new Error('Not implemented');
}
