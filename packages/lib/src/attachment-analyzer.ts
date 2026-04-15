/// <reference path="./pdf-parse.d.ts" />
/**
 * Attachment analyzer — tiered ingest router (Session Prompt 04).
 *
 * Purpose:  First step of the tiered ingest pipeline. Given a file buffer
 *           and its MIME type, decides the cheapest extraction method
 *           capable of pulling text out of it — Excel rows from exceljs,
 *           CSV rows from csv-parse, DOCX text from mammoth, PDF text from
 *           pdf-parse, OCR from Azure Document Intelligence, or just a
 *           direct UTF-8 decode for plain text and email bodies.
 *
 *           Returns a uniform AttachmentAnalysisResult that the downstream
 *           lumber-parser consumes regardless of source. This is the
 *           module that ensures 85% of real-world bids never touch an LLM:
 *           Excel and clean PDFs resolve to zero-cost parser paths and
 *           only image-only files fall through to OCR.
 *
 *           PDF fallback policy: we run pdf-parse first, and if the
 *           extractable character count is 50 or less we assume the file
 *           is image-only (scanned) and re-analyze through Azure OCR.
 *           The fellBackToOcr metadata flag records the hop so cost
 *           accounting is transparent.
 *
 * Inputs:   file Buffer + MIME type + filename.
 * Outputs:  analyzeAttachment() → AttachmentAnalysisResult.
 * Agent/API: pdf-parse, mammoth, exceljs, csv-parse, ./ocr (Azure).
 * Imports:  exceljs, pdf-parse, mammoth, csv-parse, ./ocr, @lmbr/types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';

import type { ExtractionMethod } from '@lmbr/types';
import { analyzeDocument, OcrError } from './ocr';

export interface AttachmentAnalysisResult {
  method: ExtractionMethod;
  extractedText: string;
  // Excel / CSV only — typed rows as record objects, one per data row. The
  // lumber parser's Excel path consumes these directly so it doesn't need
  // to re-parse the file.
  rawRows?: Record<string, unknown>[];
  pageCount?: number;
  // Quality of the extraction, not the lumber parse. 1.0 for anything
  // deterministic, the Azure word-confidence mean for OCR.
  confidence: number;
  costCents: number;
  metadata: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    detectedEncoding?: string;
    ocrPages?: number;
    fellBackToOcr?: boolean;
    notes?: string;
  };
}

// Below this threshold of extractable characters, a PDF is considered
// image-only and is re-routed through OCR. 50 is generous enough to catch
// a blank title page but small enough that any real lumber list (which
// typically carries hundreds of characters even on a single line) never
// false-positives.
const PDF_MIN_TEXT_CHARS = 50;

/**
 * Primary entry point. Routes to a type-specific parser based on MIME
 * type and file extension, then normalizes the result shape. Order of
 * checks matters — MIME sniffing is unreliable for old Excel files so we
 * prefer the filename extension when MIME is ambiguous.
 */
export async function analyzeAttachment(
  file: Buffer,
  mimeType: string,
  filename: string,
): Promise<AttachmentAnalysisResult> {
  const ext = extractExtension(filename);
  const normalizedMime = (mimeType || '').toLowerCase();
  const sizeBytes = file.length;

  // --- Excel (xlsx / xls) ---
  if (
    ext === 'xlsx' ||
    ext === 'xls' ||
    normalizedMime.includes('spreadsheetml') ||
    normalizedMime.includes('ms-excel')
  ) {
    return analyzeExcel(file, filename, normalizedMime, sizeBytes);
  }

  // --- CSV ---
  if (ext === 'csv' || normalizedMime === 'text/csv') {
    return analyzeCsv(file, filename, normalizedMime, sizeBytes);
  }

  // --- DOCX ---
  if (
    ext === 'docx' ||
    normalizedMime.includes('wordprocessingml')
  ) {
    return analyzeDocx(file, filename, normalizedMime, sizeBytes);
  }

  // --- PDF (with OCR fallback) ---
  if (ext === 'pdf' || normalizedMime === 'application/pdf') {
    return analyzePdf(file, filename, normalizedMime, sizeBytes);
  }

  // --- Image types (always OCR) ---
  if (
    ['jpg', 'jpeg', 'png', 'tiff', 'tif', 'bmp'].includes(ext) ||
    normalizedMime.startsWith('image/')
  ) {
    return analyzeImage(file, filename, normalizedMime, sizeBytes);
  }

  // --- Plain text ---
  if (ext === 'txt' || normalizedMime === 'text/plain') {
    return analyzePlainText(file, filename, normalizedMime, sizeBytes, 'direct_text');
  }

  // --- Email body passed as text/plain — caller flags the intent with
  //     mimeType: 'text/plain; charset=email' or similar. We accept any
  //     text/* here and mark the method accordingly.
  if (normalizedMime.startsWith('text/')) {
    return analyzePlainText(file, filename, normalizedMime, sizeBytes, 'email_text');
  }

  // --- Unknown — last-resort Azure OCR so the trader still gets something. ---
  return analyzeImage(file, filename, normalizedMime, sizeBytes);
}

// -----------------------------------------------------------------------------
// Excel
// -----------------------------------------------------------------------------

async function analyzeExcel(
  file: Buffer,
  filename: string,
  mimeType: string,
  sizeBytes: number,
): Promise<AttachmentAnalysisResult> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS's load() signature predates @types/node 22's Buffer generic;
  // pass the underlying ArrayBuffer slice so the call type-checks cleanly.
  const arrayBuffer = file.buffer.slice(
    file.byteOffset,
    file.byteOffset + file.byteLength,
  ) as ArrayBuffer;
  await workbook.xlsx.load(arrayBuffer);

  const rawRows: Record<string, unknown>[] = [];
  const lines: string[] = [];

  for (const worksheet of workbook.worksheets) {
    lines.push(`=== Sheet: ${worksheet.name} ===`);
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: unknown[] = [];
      // ExcelJS row.values is 1-indexed; the leading undefined is normal.
      const values = Array.isArray(row.values)
        ? row.values.slice(1)
        : Object.values(row.values ?? {});
      for (const v of values) {
        cells.push(flattenCell(v));
      }
      // Build a record keyed by column letter so the lumber parser's
      // header detection can address columns positionally.
      const record: Record<string, unknown> = { __row: rowNumber };
      cells.forEach((value, idx) => {
        record[columnLetter(idx)] = value;
      });
      rawRows.push(record);
      lines.push(cells.map((c) => (c == null ? '' : String(c))).join('\t'));
    });
    lines.push('');
  }

  return {
    method: 'excel_parse',
    extractedText: lines.join('\n'),
    rawRows,
    confidence: 1.0,
    costCents: 0,
    metadata: { filename, mimeType, sizeBytes },
  };
}

function flattenCell(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === 'object') {
    // Rich text
    const anyValue = value as { richText?: { text: string }[]; text?: string; result?: unknown };
    if (Array.isArray(anyValue.richText)) {
      return anyValue.richText.map((r) => r.text).join('');
    }
    if (typeof anyValue.text === 'string') return anyValue.text;
    if (anyValue.result !== undefined) return anyValue.result;
    if (value instanceof Date) return value.toISOString();
  }
  return value;
}

function columnLetter(index: number): string {
  // 0 → "A", 25 → "Z", 26 → "AA", etc.
  let n = index;
  let result = '';
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

// -----------------------------------------------------------------------------
// CSV
// -----------------------------------------------------------------------------

async function analyzeCsv(
  file: Buffer,
  filename: string,
  mimeType: string,
  sizeBytes: number,
): Promise<AttachmentAnalysisResult> {
  const text = file.toString('utf-8');
  const records = parseCsv(text, {
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  }) as unknown[][];

  const rawRows: Record<string, unknown>[] = records.map((row, idx) => {
    const record: Record<string, unknown> = { __row: idx + 1 };
    row.forEach((cell, colIdx) => {
      record[columnLetter(colIdx)] = cell;
    });
    return record;
  });

  return {
    method: 'csv_parse',
    extractedText: text,
    rawRows,
    confidence: 1.0,
    costCents: 0,
    metadata: { filename, mimeType, sizeBytes, detectedEncoding: 'utf-8' },
  };
}

// -----------------------------------------------------------------------------
// DOCX
// -----------------------------------------------------------------------------

async function analyzeDocx(
  file: Buffer,
  filename: string,
  mimeType: string,
  sizeBytes: number,
): Promise<AttachmentAnalysisResult> {
  const result = await mammoth.extractRawText({ buffer: file });
  return {
    method: 'docx_parse',
    extractedText: result.value ?? '',
    confidence: 1.0,
    costCents: 0,
    metadata: {
      filename,
      mimeType,
      sizeBytes,
      notes: result.messages?.map((m) => m.message).join('; '),
    },
  };
}

// -----------------------------------------------------------------------------
// PDF (with OCR fallback)
// -----------------------------------------------------------------------------

async function analyzePdf(
  file: Buffer,
  filename: string,
  mimeType: string,
  sizeBytes: number,
): Promise<AttachmentAnalysisResult> {
  let text = '';
  let pageCount = 0;
  try {
    const parsed = await pdfParse(file);
    text = parsed.text ?? '';
    pageCount = parsed.numpages ?? 0;
  } catch {
    // pdf-parse failures are treated as "this PDF has no recoverable
    // text" — fall through to OCR below.
    text = '';
  }

  if (text.trim().length > PDF_MIN_TEXT_CHARS) {
    return {
      method: 'pdf_direct',
      extractedText: text,
      pageCount,
      confidence: 1.0,
      costCents: 0,
      metadata: { filename, mimeType, sizeBytes },
    };
  }

  // Scanned / image-only PDF — fall back to Azure OCR.
  try {
    const ocr = await analyzeDocument(file, mimeType || 'application/pdf');
    return {
      method: 'ocr',
      extractedText: ocr.text,
      pageCount: ocr.pages,
      confidence: ocr.confidence,
      costCents: ocr.costCents,
      metadata: {
        filename,
        mimeType,
        sizeBytes,
        ocrPages: ocr.pages,
        fellBackToOcr: true,
      },
    };
  } catch (err) {
    if (err instanceof OcrError) {
      throw err;
    }
    throw new OcrError(
      `PDF fallback OCR failed: ${(err as Error).message}`,
      err,
    );
  }
}

// -----------------------------------------------------------------------------
// Image (always OCR)
// -----------------------------------------------------------------------------

async function analyzeImage(
  file: Buffer,
  filename: string,
  mimeType: string,
  sizeBytes: number,
): Promise<AttachmentAnalysisResult> {
  const ocr = await analyzeDocument(file, mimeType);
  return {
    method: 'ocr',
    extractedText: ocr.text,
    pageCount: ocr.pages,
    confidence: ocr.confidence,
    costCents: ocr.costCents,
    metadata: {
      filename,
      mimeType,
      sizeBytes,
      ocrPages: ocr.pages,
      fellBackToOcr: false,
    },
  };
}

// -----------------------------------------------------------------------------
// Plain text / email body
// -----------------------------------------------------------------------------

function analyzePlainText(
  file: Buffer,
  filename: string,
  mimeType: string,
  sizeBytes: number,
  method: 'direct_text' | 'email_text',
): AttachmentAnalysisResult {
  return {
    method,
    extractedText: file.toString('utf-8'),
    confidence: 1.0,
    costCents: 0,
    metadata: { filename, mimeType, sizeBytes, detectedEncoding: 'utf-8' },
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function extractExtension(filename: string): string {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return '';
  return lower.slice(dot + 1);
}
