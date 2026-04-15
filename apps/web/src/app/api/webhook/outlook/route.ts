/**
 * POST /api/webhook/outlook — Microsoft Graph change-notification webhook.
 *
 * Purpose:  Receives subscription notifications from Microsoft Graph when a
 *           new message arrives in the monitored Outlook mailbox (customer
 *           RFQ inbox). Fetches the message + attachments via @lmbr/lib
 *           outlook helpers and enqueues them for the ingest-agent.
 * Inputs:   Graph notification payload.
 * Outputs:  200 OK (ack) or 202 (validation token).
 * Agent/API: Microsoft Graph → @lmbr/agents ingest-agent.
 * Imports:  @lmbr/lib (outlook), @lmbr/agents.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

export async function POST(_req: NextRequest): Promise<NextResponse> {
  throw new Error('Not implemented');
}
