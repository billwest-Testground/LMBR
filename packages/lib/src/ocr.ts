/**
 * OCR helper — Azure Document Intelligence wrapper for the tiered ingest
 * engine (Session Prompt 04).
 *
 * Purpose:  Runs OCR on scanned-paper takeoffs, phone-camera captures, and
 *           image-only PDFs so the attachment-analyzer can fall back to a
 *           deterministic text path when pdf-parse finds fewer than 50
 *           extractable characters. Uses Azure Document Intelligence
 *           (DocumentAnalysisClient + prebuilt-layout) because it returns
 *           page-level confidence and table structure, which the lumber
 *           parser can use to detect column layouts in scanned lists.
 * Inputs:   file bytes + mime type.
 * Outputs:  analyzeDocument() → { text, pages, confidence, costCents, tables }.
 *           runOcr() kept as a legacy alias around analyzeDocument for any
 *           older callers that still import it — do not add new callers of
 *           runOcr; use analyzeDocument directly.
 * Agent/API: Azure Document Intelligence S0 tier, prebuilt-layout model.
 * Imports:  @azure/ai-form-recognizer.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import {
  DocumentAnalysisClient,
  AzureKeyCredential,
} from '@azure/ai-form-recognizer';

export interface OcrBlock {
  page: number;
  bbox: [number, number, number, number];
  text: string;
  confidence: number;
}

export interface OcrResult {
  text: string;
  pages: number;
  confidence: number;
  costCents: number;
  tables?: unknown[];
  // Legacy block list retained for any old caller — new code should read
  // tables and text directly.
  blocks?: OcrBlock[];
}

export class OcrError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'OcrError';
  }
}

// Azure S0 prebuilt-layout is $1.50 per 1,000 pages = 0.15 cents per page.
// Declared as a const rather than env so the cost tracker never depends on
// the operator setting a price; if Azure's pricing changes, bump this and
// the whole pipeline re-estimates.
const COST_CENTS_PER_PAGE = 0.15;

let cachedClient: DocumentAnalysisClient | null = null;

function getClient(): DocumentAnalysisClient {
  if (cachedClient) return cachedClient;
  const endpoint = process.env.AZURE_DOC_INTELLIGENCE_ENDPOINT;
  const key = process.env.AZURE_DOC_INTELLIGENCE_KEY;
  if (!endpoint || !key) {
    throw new OcrError(
      'Azure Document Intelligence not configured: set AZURE_DOC_INTELLIGENCE_ENDPOINT and AZURE_DOC_INTELLIGENCE_KEY',
    );
  }
  cachedClient = new DocumentAnalysisClient(endpoint, new AzureKeyCredential(key));
  return cachedClient;
}

export async function analyzeDocument(
  buffer: Buffer,
  _mimeType: string,
): Promise<OcrResult> {
  let poller;
  try {
    const client = getClient();
    poller = await client.beginAnalyzeDocument('prebuilt-layout', buffer);
  } catch (err) {
    throw new OcrError(
      `Azure Document Intelligence request failed: ${(err as Error).message}`,
      err,
    );
  }

  let result;
  try {
    result = await poller.pollUntilDone();
  } catch (err) {
    throw new OcrError(
      `Azure Document Intelligence polling failed: ${(err as Error).message}`,
      err,
    );
  }

  // Azure's layout model returns pages with lines and words. Concatenating
  // line content preserves reading order per page, and page breaks are
  // inserted as \n\n so the lumber parser's building/phase header detection
  // has enough whitespace to anchor on.
  const pageTexts: string[] = [];
  const wordConfidences: number[] = [];

  for (const page of result.pages ?? []) {
    const lines = page.lines?.map((l) => l.content).filter(Boolean) ?? [];
    pageTexts.push(lines.join('\n'));
    for (const word of page.words ?? []) {
      if (typeof word.confidence === 'number') {
        wordConfidences.push(word.confidence);
      }
    }
  }

  const pages = result.pages?.length ?? 0;
  const text = pageTexts.join('\n\n');
  const confidence =
    wordConfidences.length > 0
      ? wordConfidences.reduce((a, b) => a + b, 0) / wordConfidences.length
      : 0.5; // Azure returned no per-word confidence — treat as neutral.

  return {
    text,
    pages,
    confidence,
    costCents: pages * COST_CENTS_PER_PAGE,
    tables: result.tables ?? [],
  };
}

/**
 * Legacy alias preserved for older callers. New code should use
 * analyzeDocument directly — Uint8Array → Buffer conversion is cheap but
 * pointless if the caller already has a Buffer.
 */
export async function runOcr(
  bytes: Uint8Array,
  mimeType: string,
): Promise<OcrResult> {
  return analyzeDocument(Buffer.from(bytes), mimeType);
}
