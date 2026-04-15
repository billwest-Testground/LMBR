/**
 * POST /api/qa — Validate extracted line items against the commodity catalog.
 *
 * Purpose:  Invokes the qa-agent to normalize species/grade/dimensions and
 *           surface issues before a bid moves into routing.
 * Inputs:   { bidId }.
 * Outputs:  { ok, normalizedLineItems[], issues[] }.
 * Agent/API: @lmbr/agents qa-agent.
 * Imports:  @lmbr/agents, @lmbr/types, @lmbr/lib.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

export async function POST(_req: NextRequest): Promise<NextResponse> {
  throw new Error('Not implemented');
}
