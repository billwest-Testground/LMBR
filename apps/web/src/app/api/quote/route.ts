/**
 * POST /api/quote — Render and optionally release the customer quote PDF.
 *
 * Purpose:  Builds a clean, vendor-name-free quote PDF with house/phase
 *           breakdown, tax, and freight. Uploads to storage and returns
 *           the signed URL. Release requires Manager-Owner approval.
 * Inputs:   { bidId, action: 'preview' | 'release' }.
 * Outputs:  { quote, pdfUrl }.
 * Agent/API: @react-pdf/renderer + Supabase storage.
 * Imports:  @lmbr/types (QuoteSchema), @lmbr/lib.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

export async function POST(_req: NextRequest): Promise<NextResponse> {
  throw new Error('Not implemented');
}
