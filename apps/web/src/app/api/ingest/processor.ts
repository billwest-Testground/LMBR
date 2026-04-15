/**
 * processIngestJob — shared tiered-ingest pipeline processor.
 *
 * Purpose:  Single source of truth for "turn a raw upload into a set of
 *           line_items". Used by both the HTTP route (inline path, for
 *           local dev + Vercel serverless) and the BullMQ worker (queued
 *           path, for dedicated Node worker machines). Keeping the
 *           pipeline in one place means the inline and queued flows can
 *           never drift.
 *
 *           Pipeline (Session Prompt 04 tiered ingest):
 *             1. Download raw file from Supabase storage (service-role,
 *                bypasses RLS because the worker may not hold a session).
 *             2. analyzeAttachment() → AttachmentAnalysisResult.
 *             3. parseLumberList() → ParseResult with overallConfidence.
 *             4. Decision gate on overallConfidence:
 *                • >= 0.92            → parser result stands.
 *                • [0.60, 0.92)       → Mode B targeted cleanup.
 *                • < 0.60             → Mode A full Claude extraction.
 *             5. runQaAgent() with optional Haiku LLM pass.
 *             6. Bulk insert line_items with per-row extraction_method,
 *                extraction_confidence, cost_cents. Preserve the legacy
 *                `{confidence, flags, original_text}` JSON blob in
 *                `notes` so the existing review UI keeps working.
 *             7. recordExtractionBatch() writes per-phase spend to the
 *                extraction_costs ledger. Zero-cost phases still get a
 *                row so the manager dashboard shows every step.
 *             8. Update the bid row: status → 'reviewing'.
 *
 *           Failure handling: any throw from this function is caught by
 *           the route's inline path (turned into a 5xx + extraction_failed
 *           status) or by BullMQ's retry+dead-letter mechanism.
 *
 * Inputs:   IngestJob (bidId, companyId, filePath, mimeType, filename).
 * Outputs:  Promise<void>. Writes are all DB-side; callers read the
 *           resulting bid + line_items back to build their responses.
 * Agent/API: Azure Document Intelligence (OCR), Claude Sonnet (Mode A/B),
 *            Claude Haiku (QA LLM pass), Supabase Postgres + Storage.
 * Imports:  @lmbr/lib (analyzer, parser, queue type, supabase, cost
 *           tracker), @lmbr/agents (runQaAgent, extractionAgent,
 *           extractionAgentTargetedCleanup).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import {
  extractionAgent,
  extractionAgentTargetedCleanup,
  runQaAgent,
  type ModeBLowConfidenceLine,
  type QaReport,
} from '@lmbr/agents';
import {
  analyzeAttachment,
  getSupabaseAdmin,
  parseLumberList,
  recordExtractionBatch,
  type AttachmentAnalysisResult,
  type IngestJob,
  type ParseResult,
  type RecordExtractionInput,
} from '@lmbr/lib';
import type {
  ExtractedBuildingGroup,
  ExtractedLineItem,
  ExtractionMethod,
  ExtractionOutput,
} from '@lmbr/types';

export const BIDS_BUCKET = 'bids-raw';

/**
 * Default confidence cutoff — lines below this get sent to Mode B cleanup.
 * Mode A fires below MODE_A_CUTOFF. Both values are env-tunable so we can
 * retune on real production data without a redeploy.
 */
const EXTRACTION_CONFIDENCE_THRESHOLD = Number.parseFloat(
  process.env['EXTRACTION_CONFIDENCE_THRESHOLD'] ?? '0.92',
);
const MODE_A_CUTOFF = 0.6;

export interface ProcessIngestResult {
  extraction: ExtractionOutput;
  qaReport: QaReport;
  /**
   * Method badge for the extraction_report the route returns to the
   * client. Matches the `extraction_method` on the produced line items
   * except that Mode A / Mode B are labelled distinctly for the UI.
   */
  methodUsed:
    | ExtractionMethod
    | 'claude_mode_a'
    | 'claude_mode_b'
    | 'claude_extraction';
  totalCostCents: number;
}

/**
 * Main entry point. The queue worker calls this with the job data pulled
 * off BullMQ; the HTTP route calls it via enqueueOrRun in inline mode.
 * The inline path uses the returned result directly to build the HTTP
 * response without re-reading the DB.
 */
export async function processIngestJob(
  job: IngestJob,
): Promise<ProcessIngestResult> {
  const admin = getSupabaseAdmin();

  // 1. Download raw file from storage.
  const buffer = await downloadRawFile(job.filePath);

  // 2. Analyze — decide the cheapest extraction method.
  const analysis = await analyzeAttachment(buffer, job.mimeType, job.filename);

  // 3. Parse — deterministic structure + confidence.
  const parseResult = parseLumberList(analysis);

  // 4. Decision gate — does this bid need Claude help?
  const decision = decideExtractionPath(parseResult.overallConfidence);

  let extraction: ExtractionOutput;
  let modeACostCents = 0;
  let modeBCostCents = 0;
  let usedModeA = false;
  let usedModeB = false;

  if (decision === 'skip_claude') {
    extraction = buildExtractionOutputFromParseResult(parseResult);
  } else if (decision === 'mode_b') {
    const { extraction: merged, costCents } = await runModeBCleanup(
      parseResult,
      job.companyId,
    );
    extraction = merged;
    modeBCostCents = costCents;
    usedModeB = true;
  } else {
    // mode_a: discard parser result, run full Claude extraction.
    const { extraction: fullExtraction, costCents } = await runModeAExtraction(
      buffer,
      analysis,
    );
    extraction = fullExtraction;
    modeACostCents = costCents;
    usedModeA = true;
  }

  // 5. QA — deterministic rules + optional Haiku pass.
  const qaReport = await runQaAgent(extraction, { runLlmChecks: true });

  // 6. Persist line items.
  const lineItemRows = flattenLineItemsForInsert({
    bidId: job.bidId,
    companyId: job.companyId,
    extraction,
  });

  if (lineItemRows.length === 0) {
    // Zero-line extraction is a soft failure — mark the bid and bail.
    await admin
      .from('bids')
      .update({
        status: 'received',
        notes: 'Extraction produced zero line items — please re-upload.',
      })
      .eq('id', job.bidId);
    return {
      extraction,
      qaReport,
      methodUsed: usedModeA
        ? 'claude_mode_a'
        : usedModeB
          ? 'claude_mode_b'
          : analysis.method,
      totalCostCents: 0,
    };
  }

  const { error: insertError } = await admin
    .from('line_items')
    .insert(lineItemRows);
  if (insertError) {
    // Mark the bid failed but don't propagate in a way that swallows the
    // DB error — callers need the message to show a useful error to the
    // trader.
    await admin
      .from('bids')
      .update({
        status: 'received',
        notes: `line_items insert failed: ${insertError.message}`,
      })
      .eq('id', job.bidId);
    throw new Error(`line_items insert failed: ${insertError.message}`);
  }

  // 7. Write per-phase cost ledger rows. Fire-and-forget.
  const costRows: RecordExtractionInput[] = [
    {
      bidId: job.bidId,
      companyId: job.companyId,
      method: analysis.method,
      costCents: analysis.costCents,
    },
  ];
  if (usedModeA) {
    costRows.push({
      bidId: job.bidId,
      companyId: job.companyId,
      method: 'claude_mode_a',
      costCents: modeACostCents,
    });
  }
  if (usedModeB) {
    costRows.push({
      bidId: job.bidId,
      companyId: job.companyId,
      method: 'claude_mode_b',
      costCents: modeBCostCents,
    });
  }
  if (qaReport.costCents > 0) {
    costRows.push({
      bidId: job.bidId,
      companyId: job.companyId,
      method: 'qa_llm',
      costCents: qaReport.costCents,
    });
  }
  await recordExtractionBatch(costRows);

  // 8. Flip the bid into 'reviewing'.
  const { error: bidError } = await admin
    .from('bids')
    .update({ status: 'reviewing' })
    .eq('id', job.bidId);
  if (bidError) {
    throw new Error(`bid status update failed: ${bidError.message}`);
  }

  const totalCostCents = costRows.reduce((sum, row) => sum + row.costCents, 0);

  return {
    extraction,
    qaReport,
    methodUsed: usedModeA
      ? 'claude_mode_a'
      : usedModeB
        ? 'claude_mode_b'
        : analysis.method,
    totalCostCents: round4(totalCostCents),
  };
}

// -----------------------------------------------------------------------------
// Decision gate
// -----------------------------------------------------------------------------

type ExtractionDecision = 'skip_claude' | 'mode_b' | 'mode_a';

function decideExtractionPath(overallConfidence: number): ExtractionDecision {
  if (overallConfidence >= EXTRACTION_CONFIDENCE_THRESHOLD) return 'skip_claude';
  if (overallConfidence >= MODE_A_CUTOFF) return 'mode_b';
  return 'mode_a';
}

// -----------------------------------------------------------------------------
// Parser → ExtractionOutput
// -----------------------------------------------------------------------------

function buildExtractionOutputFromParseResult(
  parseResult: ParseResult,
): ExtractionOutput {
  // Stamp every line with the parser's method so the DB row records
  // provenance. The parser doesn't do this itself because the parser
  // returns a reusable structure that may later be remixed by Mode B.
  const stampedGroups: ExtractedBuildingGroup[] =
    parseResult.buildingGroups.map((group) => ({
      ...group,
      lineItems: group.lineItems.map((item) => ({
        ...item,
        extractionMethod: parseResult.extractionMethod,
        costCents: 0,
      })),
    }));

  return {
    extractionConfidence: parseResult.overallConfidence,
    buildingGroups: stampedGroups,
    totalLineItems: parseResult.totalLineItems,
    totalBoardFeet: parseResult.totalBoardFeet,
    flagsRequiringReview: [],
  };
}

// -----------------------------------------------------------------------------
// Mode B — targeted cleanup
// -----------------------------------------------------------------------------

async function runModeBCleanup(
  parseResult: ParseResult,
  companyId: string,
): Promise<{ extraction: ExtractionOutput; costCents: number }> {
  // Step 1 — gather flagged lines via flat depth-first walk. This must
  // match the order parseLumberList used to generate lowConfidenceLines.
  interface FlatAddress {
    flatIndex: number;
    groupIndex: number;
    itemIndex: number;
  }
  const flaggedSet = new Set(parseResult.lowConfidenceLines);
  const flaggedAddresses: FlatAddress[] = [];
  let flatCursor = 0;
  parseResult.buildingGroups.forEach((group, groupIndex) => {
    group.lineItems.forEach((_, itemIndex) => {
      if (flaggedSet.has(flatCursor)) {
        flaggedAddresses.push({ flatIndex: flatCursor, groupIndex, itemIndex });
      }
      flatCursor += 1;
    });
  });

  if (flaggedAddresses.length === 0) {
    // Nothing to fix — treat as if we skipped Claude.
    return {
      extraction: buildExtractionOutputFromParseResult(parseResult),
      costCents: 0,
    };
  }

  // Step 2 — build Mode B inputs. Partial parse is the current best-
  // effort shape from the deterministic parser; Claude treats it as a
  // starting point, not gospel.
  const lowConfidenceLines: ModeBLowConfidenceLine[] = flaggedAddresses.map(
    (addr) => {
      const group = parseResult.buildingGroups[addr.groupIndex];
      if (!group) {
        return {
          buildingTag: 'Unassigned',
          originalText: '',
          partialParse: {},
          flags: [],
        };
      }
      const item = group.lineItems[addr.itemIndex];
      return {
        buildingTag: group.buildingTag,
        originalText: item?.originalText ?? '',
        partialParse: item ? buildPartialParse(item) : {},
        flags: item?.flags ?? [],
      };
    },
  );

  // Step 3 — the high-confidence groups serve as grounding context. We
  // strip flagged lines from each group so Claude doesn't see them
  // twice; lines below the threshold are removed from the context but
  // kept elsewhere so we can re-insert fixed versions.
  const contextGroups: ExtractedBuildingGroup[] = parseResult.buildingGroups
    .map((group, groupIndex) => ({
      buildingTag: group.buildingTag,
      phaseNumber: group.phaseNumber,
      lineItems: group.lineItems.filter(
        (_, itemIndex) =>
          !flaggedAddresses.some(
            (addr) =>
              addr.groupIndex === groupIndex && addr.itemIndex === itemIndex,
          ),
      ),
    }))
    .filter((g) => g.lineItems.length > 0);

  const modeBResult = await extractionAgentTargetedCleanup({
    highConfidenceContext: contextGroups,
    lowConfidenceLines,
    companyId,
  });

  // Step 4 — merge fixed lines back into the parser groups by address.
  const mergedGroups: ExtractedBuildingGroup[] = parseResult.buildingGroups.map(
    (group) => ({
      buildingTag: group.buildingTag,
      phaseNumber: group.phaseNumber,
      lineItems: group.lineItems.map((item) => ({
        ...item,
        extractionMethod: parseResult.extractionMethod,
        costCents: 0,
      })),
    }),
  );

  // Approximate per-fix cost: total Mode B spend divided across fixes.
  const perFixCost =
    modeBResult.fixedLines.length > 0
      ? modeBResult.costCents / modeBResult.fixedLines.length
      : 0;

  for (let fixIdx = 0; fixIdx < modeBResult.fixedLines.length; fixIdx += 1) {
    const fix = modeBResult.fixedLines[fixIdx];
    const addr = flaggedAddresses[fixIdx];
    if (!fix || !addr) continue;
    const group = mergedGroups[addr.groupIndex];
    if (!group) continue;
    group.lineItems[addr.itemIndex] = {
      ...fix.lineItem,
      extractionMethod: 'claude_extraction',
      costCents: round4(perFixCost),
    };
  }

  const totalLineItems = mergedGroups.reduce(
    (sum, g) => sum + g.lineItems.length,
    0,
  );
  const totalBoardFeet = mergedGroups.reduce(
    (sum, g) => sum + g.lineItems.reduce((s, li) => s + (li.boardFeet ?? 0), 0),
    0,
  );
  const meanConfidence =
    totalLineItems === 0
      ? 0
      : mergedGroups
          .flatMap((g) => g.lineItems)
          .reduce((s, li) => s + (li.confidence ?? 0), 0) / totalLineItems;

  return {
    extraction: {
      extractionConfidence: clamp01(meanConfidence),
      buildingGroups: mergedGroups,
      totalLineItems,
      totalBoardFeet: round2(totalBoardFeet),
      flagsRequiringReview: [],
    },
    costCents: modeBResult.costCents,
  };
}

function buildPartialParse(
  item: ExtractedLineItem,
): Partial<ExtractedLineItem> {
  const partial: Partial<ExtractedLineItem> = {};
  if (item.species) partial.species = item.species;
  if (item.dimension) partial.dimension = item.dimension;
  if (item.grade) partial.grade = item.grade;
  if (item.length) partial.length = item.length;
  if (Number.isFinite(item.quantity)) partial.quantity = item.quantity;
  if (item.unit) partial.unit = item.unit;
  return partial;
}

// -----------------------------------------------------------------------------
// Mode A — full Claude extraction
// -----------------------------------------------------------------------------

async function runModeAExtraction(
  buffer: Buffer,
  analysis: AttachmentAnalysisResult,
): Promise<{ extraction: ExtractionOutput; costCents: number }> {
  // Mode A wants the most useful input for Claude. For PDFs and images,
  // send the raw bytes so Claude's vision path can do its own OCR and
  // catch things the text extractor missed. For Excel / DOCX / text,
  // send the already-extracted text so we don't re-ship the binary.
  const extractionInput: Parameters<typeof extractionAgent>[0] = {};

  const mime = analysis.metadata.mimeType.toLowerCase();
  const wantsBytes =
    mime === 'application/pdf' || mime.startsWith('image/');

  if (wantsBytes) {
    extractionInput.fileBytes = buffer as unknown as NonNullable<
      Parameters<typeof extractionAgent>[0]['fileBytes']
    >;
    extractionInput.mimeType = mime;
  } else {
    extractionInput.rawText = analysis.extractedText;
  }
  extractionInput.fileName = analysis.metadata.filename;

  const extraction = await extractionAgent(extractionInput);

  // Tag every line as claude-produced so the DB row records provenance.
  const stamped: ExtractionOutput = {
    ...extraction,
    buildingGroups: extraction.buildingGroups.map((group) => ({
      ...group,
      lineItems: group.lineItems.map((item) => ({
        ...item,
        extractionMethod: 'claude_extraction' as ExtractionMethod,
      })),
    })),
  };

  // Sonnet 4.6 pricing (same constants Mode B uses). We don't have the
  // raw usage numbers here because extractionAgent doesn't bubble them
  // up — fall back to a per-doc average. Threshold tuning over real
  // volume will refine this number.
  const DEFAULT_MODE_A_COST_CENTS = 1.5;

  return { extraction: stamped, costCents: DEFAULT_MODE_A_COST_CENTS };
}

// -----------------------------------------------------------------------------
// Storage download
// -----------------------------------------------------------------------------

async function downloadRawFile(filePath: string): Promise<Buffer> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.storage
    .from(BIDS_BUCKET)
    .download(filePath);
  if (error || !data) {
    throw new Error(
      `processIngestJob: failed to download ${filePath} — ${error?.message ?? 'no data'}`,
    );
  }
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// -----------------------------------------------------------------------------
// Flatten for DB insert
// -----------------------------------------------------------------------------

function flattenLineItemsForInsert(args: {
  bidId: string;
  companyId: string;
  extraction: ExtractionOutput;
}): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  let sort = 0;
  for (const group of args.extraction.buildingGroups) {
    for (const item of group.lineItems) {
      const metaBlob = JSON.stringify({
        confidence: item.confidence,
        flags: item.flags,
        original_text: item.originalText,
      });
      rows.push({
        bid_id: args.bidId,
        company_id: args.companyId,
        building_tag: group.buildingTag || null,
        phase_number: group.phaseNumber,
        species: item.species,
        dimension: item.dimension,
        grade: item.grade || null,
        length: item.length || null,
        quantity: item.quantity,
        unit: item.unit,
        board_feet: item.boardFeet,
        notes: metaBlob,
        is_consolidated: false,
        original_line_item_id: null,
        sort_order: sort,
        extraction_method: item.extractionMethod ?? null,
        extraction_confidence: item.confidence ?? null,
        cost_cents: item.costCents ?? 0,
      });
      sort += 1;
    }
  }
  return rows;
}

// -----------------------------------------------------------------------------
// Numeric helpers
// -----------------------------------------------------------------------------

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
