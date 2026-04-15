/**
 * Extraction agent — vendor bid response → structured price lines.
 *
 * Purpose:  Consumes a vendor's bid response (PDF, email body, scanned form)
 *           and extracts per-line prices, units (piece / bf / mbf / lf),
 *           freight inclusion, and any notes/terms. Matches extracted lines
 *           back to the original consolidated request line items so the
 *           comparison-agent can score vendors head-to-head.
 * Inputs:   { companyId, vendorBidId, bytes?, rawText?, mimeType? }.
 * Outputs:  { vendorBidLineItems[], matchedCount, unmatchedRawLines[] }.
 * Agent/API: Anthropic Claude (vision + structured output).
 * Imports:  @lmbr/types, @lmbr/config, zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import type { VendorBidLineItem } from '@lmbr/types';

export interface ExtractionInput {
  companyId: string;
  vendorBidId: string;
  bytes?: Uint8Array;
  rawText?: string;
  mimeType?: string;
}

export interface ExtractionResult {
  vendorBidLineItems: VendorBidLineItem[];
  matchedCount: number;
  unmatchedRawLines: string[];
}

export async function extractionAgent(
  _input: ExtractionInput,
): Promise<ExtractionResult> {
  throw new Error('Not implemented');
}
