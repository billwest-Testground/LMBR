/**
 * OCR helper — scanned paper takeoffs to text.
 *
 * Purpose:  Runs OCR on scanned bid documents (phone-camera captures,
 *           faxed-printed-scanned takeoffs) so the extraction-agent can
 *           structure them into line items. LMBR.ai routes through a vision
 *           model for handwriting + table reconstruction and falls back to
 *           a classical OCR engine for clean typed scans.
 * Inputs:   image/pdf bytes + mime type.
 * Outputs:  runOcr() → { text, confidence, blocks }.
 * Agent/API: Anthropic Claude vision (primary) — future fallback TBD.
 * Imports:  @anthropic-ai/sdk (via ./anthropic).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export interface OcrBlock {
  page: number;
  bbox: [number, number, number, number];
  text: string;
  confidence: number;
}

export interface OcrResult {
  text: string;
  confidence: number;
  blocks: OcrBlock[];
}

export async function runOcr(
  _bytes: Uint8Array,
  _mimeType: string,
): Promise<OcrResult> {
  throw new Error('Not implemented');
}
