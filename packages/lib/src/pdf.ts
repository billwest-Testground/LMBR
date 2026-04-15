/**
 * PDF utilities — text extraction + quote rendering bridge.
 *
 * Purpose:  Two-way PDF support for LMBR.ai. `extractPdfText` pulls
 *           structured text from an incoming customer RFQ PDF so the
 *           ingest-agent can classify and hand off to extraction; the
 *           rendering side is handled in apps/web via @react-pdf/renderer
 *           but this module exposes the shared metadata helpers so quote
 *           numbering, watermarking, and page count detection stay
 *           consistent across web and mobile.
 * Inputs:   raw PDF bytes.
 * Outputs:  extractPdfText(), countPdfPages(), generateQuoteNumber().
 * Agent/API: feeds ingest-agent + quote API route.
 * Imports:  none at the TS layer (runtime PDF libs wired in Wave-2).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export interface PdfTextPage {
  pageNumber: number;
  text: string;
}

export async function extractPdfText(_bytes: Uint8Array): Promise<PdfTextPage[]> {
  throw new Error('Not implemented');
}

export async function countPdfPages(_bytes: Uint8Array): Promise<number> {
  throw new Error('Not implemented');
}

export function generateQuoteNumber(_companySlug: string, _sequence: number): string {
  throw new Error('Not implemented');
}
