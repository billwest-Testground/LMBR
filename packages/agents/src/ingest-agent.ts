/**
 * Ingest agent — PDF / Excel / email / scan → structured lumber list.
 *
 * Purpose:  First stop in the LMBR.ai workflow. Accepts an inbound document
 *           (customer PDF RFQ, Excel takeoff, forwarded Outlook email, or
 *           phone-captured scan), classifies its shape, normalizes, and
 *           produces a canonical list of line items annotated with house /
 *           phase metadata so downstream consolidation can collapse like
 *           items while the customer-facing quote preserves the original
 *           breakdown.
 * Inputs:   { companyId, source, bytes, mimeType, context? }.
 * Outputs:  { bidId, lineItems[], warnings[] }.
 * Agent/API: Anthropic Claude (vision + structured output).
 * Imports:  @anthropic-ai/sdk (via @lmbr/lib), @lmbr/types, @lmbr/config,
 *           zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';
import type { BidSource, LineItem } from '@lmbr/types';

export const IngestInputSchema = z.object({
  companyId: z.string().uuid(),
  source: z.enum(['pdf', 'excel', 'email', 'scan', 'manual']),
  bytes: z.instanceof(Uint8Array).optional(),
  mimeType: z.string().optional(),
  rawText: z.string().optional(),
  customerName: z.string().optional(),
});
export type IngestInput = z.infer<typeof IngestInputSchema>;

export interface IngestResult {
  bidId: string;
  source: BidSource;
  lineItems: LineItem[];
  warnings: string[];
}

export async function ingestAgent(_input: IngestInput): Promise<IngestResult> {
  throw new Error('Not implemented');
}
