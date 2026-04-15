/**
 * POST /api/extract — Extract structured prices from a vendor bid response.
 *
 * Purpose:  Given a vendor bid document (PDF / email / image), calls the
 *           extraction-agent to produce VendorBidLineItem rows and match
 *           them back to the original consolidated request lines.
 * Inputs:   { vendorBidId, file | rawText, mimeType? }.
 * Outputs:  { vendorBidLineItems[], matchedCount, unmatchedRawLines[] }.
 * Agent/API: @lmbr/agents extraction-agent.
 * Imports:  @lmbr/agents, @lmbr/types, @lmbr/lib.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

export async function POST(_req: NextRequest): Promise<NextResponse> {
  throw new Error('Not implemented');
}
