/**
 * Ingest agent — orchestrator for the extract → QA pipeline.
 *
 * Purpose:  Single entrypoint used by /api/ingest. Inspects the incoming
 *           payload (raw bytes + mime type, or pre-extracted text),
 *           classifies the bid_source, pre-processes Excel workbooks to
 *           plain text via SheetJS, hands off to extraction-agent, runs
 *           qa-agent over the result, and returns a combined envelope
 *           the route handler can use to persist both the bid row and
 *           its line_items without having to know about any of this.
 *
 *           The DB write (bids + line_items insert) lives in the route
 *           handler, not here — keeping ingest-agent pure makes it easy
 *           to unit-test with file fixtures.
 *
 * Inputs:   { fileBytes?, mimeType?, rawText?, fileName? }.
 * Outputs:  { bidSource, extraction, qaReport }.
 * Agent/API: extraction-agent (Claude) + qa-agent (pure rules).
 * Imports:  xlsx (workbook → CSV text), @lmbr/types (BidSource),
 *           ./extraction-agent, ./qa-agent.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';
import * as XLSX from 'xlsx';
import type { BidSource, ExtractionOutput } from '@lmbr/types';

import { extractionAgent } from './extraction-agent';
import { qaAgent, type QaReport } from './qa-agent';

// -----------------------------------------------------------------------------
// I/O schemas
// -----------------------------------------------------------------------------

export const IngestInputSchema = z.object({
  fileBytes: z.instanceof(Uint8Array).optional(),
  mimeType: z.string().optional(),
  rawText: z.string().optional(),
  fileName: z.string().optional(),
});
export type IngestInput = z.infer<typeof IngestInputSchema>;

export interface IngestResult {
  bidSource: BidSource;
  extraction: ExtractionOutput;
  qaReport: QaReport;
}

// -----------------------------------------------------------------------------
// Source classification
// -----------------------------------------------------------------------------

const EXCEL_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroenabled.12',
]);

const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const EMAIL_MIMES = new Set([
  'message/rfc822',
  'application/vnd.ms-outlook',
]);

function classifyBidSource(input: IngestInput): BidSource {
  const mime = (input.mimeType ?? '').toLowerCase();
  const name = (input.fileName ?? '').toLowerCase();

  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (
    EXCEL_MIMES.has(mime) ||
    name.endsWith('.xlsx') ||
    name.endsWith('.xls') ||
    name.endsWith('.xlsm')
  ) {
    return 'excel';
  }
  if (IMAGE_MIMES.has(mime) || /\.(png|jpe?g|webp|heic|heif)$/.test(name)) {
    return 'image';
  }
  if (
    EMAIL_MIMES.has(mime) ||
    name.endsWith('.eml') ||
    name.endsWith('.msg')
  ) {
    return 'email';
  }
  if (input.rawText && !input.fileBytes) return 'manual';
  return 'manual';
}

// -----------------------------------------------------------------------------
// Excel → text preprocessing
// -----------------------------------------------------------------------------

function excelBytesToText(bytes: Uint8Array): string {
  const workbook = XLSX.read(bytes, { type: 'array' });
  const chunks: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    chunks.push(`# Sheet: ${sheetName}`);
    // sheet_to_csv preserves row structure; Claude handles it fine.
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    chunks.push(csv);
  }
  return chunks.join('\n\n');
}

// -----------------------------------------------------------------------------
// Email body preprocessing — lossy string scrape for .msg binaries
// -----------------------------------------------------------------------------

function msgBytesToText(bytes: Uint8Array): string {
  // Outlook .msg is a compound binary document. We don't ship a full
  // parser yet — pull every printable ASCII run of length ≥ 3 and let
  // Claude's robustness handle the noise. This is intentionally crude;
  // PROMPT 08 (Outlook integration) replaces it with real MAPI parsing.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const printable = text.replace(/[^\x20-\x7E\r\n\t]/g, ' ');
  const lines = printable
    .split(/\r?\n/)
    .map((line) => line.replace(/\s{2,}/g, ' ').trim())
    .filter((line) => line.length >= 3);
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

export async function ingestAgent(input: IngestInput): Promise<IngestResult> {
  const parsed = IngestInputSchema.parse(input);
  const bidSource = classifyBidSource(parsed);

  // Decide what gets passed to the extraction agent.
  // PDFs and images go through as bytes + mime (document / image blocks).
  // Excel and email binaries are converted to plain text first.
  let extractionBytes: Uint8Array | undefined = parsed.fileBytes;
  let extractionMime: string | undefined = parsed.mimeType;
  let extractionText: string | undefined = parsed.rawText;

  if (bidSource === 'excel' && parsed.fileBytes) {
    extractionText = excelBytesToText(parsed.fileBytes);
    extractionBytes = undefined;
    extractionMime = undefined;
  }

  if (bidSource === 'email' && parsed.fileBytes && !parsed.rawText) {
    extractionText = msgBytesToText(parsed.fileBytes);
    extractionBytes = undefined;
    extractionMime = undefined;
  }

  // Images older than jpeg/png need normalizing for Claude — but the
  // claude vision API accepts jpeg, png, gif, webp. HEIC will 4xx.
  if (
    bidSource === 'image' &&
    extractionMime &&
    !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
      extractionMime,
    )
  ) {
    // Best-effort fall-through: tag as jpeg. If Claude rejects it, the
    // outer route catches and surfaces a clear error.
    extractionMime = 'image/jpeg';
  }

  const extraction = await extractionAgent({
    fileBytes: extractionBytes,
    mimeType: extractionMime,
    rawText: extractionText,
    fileName: parsed.fileName,
  });

  const qaReport = qaAgent({ extraction });

  return { bidSource, extraction, qaReport };
}
