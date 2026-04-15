/**
 * POST /api/ingest — Ingest a customer bid document.
 *
 * Purpose:  Accepts a PDF, Excel, email body, or scan (image) from the
 *           LMBR.ai web/mobile client, persists the source document, and
 *           hands off to the ingest-agent which returns a draft bid +
 *           structured line items.
 * Inputs:   multipart/form-data { file, source, customerName? } OR
 *           application/json { rawText, source, customerName? }.
 * Outputs:  { bidId, lineItems[], warnings[] }.
 * Agent/API: @lmbr/agents ingest-agent → Anthropic Claude.
 * Imports:  @lmbr/agents, @lmbr/types, @lmbr/lib.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

export async function POST(_req: NextRequest): Promise<NextResponse> {
  throw new Error('Not implemented');
}
