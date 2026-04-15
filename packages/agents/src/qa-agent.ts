/**
 * QA agent — deterministic rules engine + optional Haiku LLM pass.
 *
 * Purpose:  After extraction returns, decide whether the list is clean
 *           enough to put in front of a trader or needs review first.
 *           The deterministic engine is pure TypeScript, fast, testable,
 *           and auditable — every flag maps to an exact rule number. The
 *           Session Prompt 04 tiered ingest engine layers an optional
 *           Haiku pass on top for subjective checks the rules engine
 *           can't do: species/grade plausibility, building-header
 *           sanity, unusual specs that smell like transcription errors.
 *
 *           Rules enforced (deterministic):
 *           1. Duplicate detection — same species/dim/grade/length in
 *              the same building_tag → `possible_duplicate` warning.
 *           2. Missing required fields — species, dimension, quantity
 *              must be present → `missing_field` error.
 *           3. Board-foot recomputation — the extraction agent's
 *              self-reported board_feet must match our local math
 *              within a ±5% tolerance → `bf_mismatch` warning.
 *           4. Confidence < 0.80 → `low_confidence` warning.
 *           5. Quantity outliers — PCS > 10_000 or MBF > 500 on a single
 *              line → `suspect_quantity` warning (probable unit mistake).
 *           6. Implausible species/grade combos (via lumber.ts lookup)
 *              → `uncommon_combo` warning.
 *           7. Aggregate rule — if any error exists, the whole report
 *              fails; otherwise pass is determined by overall
 *              confidence ≥ 0.75.
 *
 *           LLM pass (runQaAgent only):
 *           - Targets lines already flagged by the deterministic pass
 *             OR with extraction confidence in [0.75, 0.92].
 *           - Model: claude-haiku-4-5-20251001 (cheap — ~10× Sonnet).
 *           - Batched up to 30 lines per call, tool_use forced for
 *             strict JSON output.
 *           - Skipped silently when runLlmChecks === false or when
 *             ANTHROPIC_API_KEY is missing — so the orchestrator can
 *             run QA in unit tests without any network side effect.
 *
 *           API shape:
 *           - `qaAgent({ extraction })` — synchronous, deterministic
 *             only. Unchanged contract for existing callers like
 *             ingestAgent.
 *           - `runQaAgent(extraction, options?)` — async, runs the
 *             deterministic engine then optionally the Haiku pass. New
 *             code in the tiered ingest orchestrator uses this form.
 *
 * Inputs:   { extraction: ExtractionOutput } + optional LLM-pass opts.
 * Outputs:  QaReport (with llmChecksRun + costCents populated when the
 *           async path ran the LLM pass).
 * Agent/API: Anthropic Claude Haiku for the optional LLM pass only.
 * Imports:  @lmbr/lib (normalizers + isUnusualSpeciesGradeCombo,
 *           boardFeetFromDimension, getAnthropic), @lmbr/types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import {
  boardFeetFromDimension,
  getAnthropic,
  isUnusualSpeciesGradeCombo,
  normalizeGrade,
  normalizeSpecies,
} from '@lmbr/lib';
import type {
  ExtractedBuildingGroup,
  ExtractedLineItem,
  ExtractionOutput,
} from '@lmbr/types';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type QaSeverity = 'info' | 'warning' | 'error';

export type QaIssueCode =
  | 'missing_field'
  | 'bf_mismatch'
  | 'low_confidence'
  | 'suspect_quantity'
  | 'uncommon_combo'
  | 'possible_duplicate'
  | 'random_length_assumed'
  | 'llm_species_grade_implausible'
  | 'llm_building_header_odd'
  | 'llm_unusual_spec';

export interface QaLineItemIssue {
  /** Index into extraction.buildingGroups. */
  groupIndex: number;
  /** Index into extraction.buildingGroups[groupIndex].lineItems. */
  itemIndex: number;
  /** Which field failed validation, if applicable. */
  field?: keyof ExtractedLineItem;
  severity: QaSeverity;
  code: QaIssueCode;
  message: string;
}

export interface QaReport {
  pass: boolean;
  overallConfidence: number;
  issues: QaLineItemIssue[];
  summary: {
    totalLineItems: number;
    flaggedCount: number;
    lowConfidenceCount: number;
    duplicateCount: number;
    errorCount: number;
    warningCount: number;
  };
  /** Count of lines that cleared every deterministic check. */
  deterministicChecksPassed: number;
  /** Count of lines the Haiku LLM pass actually inspected. 0 on sync path. */
  llmChecksRun: number;
  /**
   * Cost in cents of the Haiku LLM pass for this report. 0 if the LLM
   * pass was skipped or the deterministic-only path ran.
   */
  costCents: number;
}

export interface RunQaAgentOptions {
  /**
   * Run the optional Haiku pass on top of the deterministic engine.
   * Defaults to `true`. Set `false` for unit tests or offline runs —
   * the pass is also skipped silently if ANTHROPIC_API_KEY is missing.
   */
  runLlmChecks?: boolean;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

export function qaAgent(input: { extraction: ExtractionOutput }): QaReport {
  const { extraction } = input;
  const issues: QaLineItemIssue[] = [];

  extraction.buildingGroups.forEach((group, groupIndex) => {
    // Duplicate detection: bucket lines by canonical key within a building.
    const dupMap = new Map<string, number[]>();
    group.lineItems.forEach((item, itemIndex) => {
      const key = dupKey(item);
      if (!key) return;
      const bucket = dupMap.get(key) ?? [];
      bucket.push(itemIndex);
      dupMap.set(key, bucket);
    });

    group.lineItems.forEach((item, itemIndex) => {
      // Rule 2 — Required fields.
      if (!item.species || item.species.trim().length === 0) {
        issues.push({
          groupIndex,
          itemIndex,
          field: 'species',
          severity: 'error',
          code: 'missing_field',
          message: 'Species is required — extraction left it blank.',
        });
      }
      if (!item.dimension || item.dimension.trim().length === 0) {
        issues.push({
          groupIndex,
          itemIndex,
          field: 'dimension',
          severity: 'error',
          code: 'missing_field',
          message: 'Dimension is required.',
        });
      }
      if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
        issues.push({
          groupIndex,
          itemIndex,
          field: 'quantity',
          severity: 'error',
          code: 'missing_field',
          message: 'Quantity must be a positive number.',
        });
      }

      // Rule 3 — Board-foot recomputation.
      const recomputed = boardFeetFromDimension(
        item.dimension,
        item.length,
        item.quantity,
      );
      if (recomputed > 0 && Number.isFinite(item.boardFeet) && item.boardFeet > 0) {
        const diff = Math.abs(recomputed - item.boardFeet);
        const tolerance = Math.max(recomputed * 0.05, 1);
        if (diff > tolerance) {
          issues.push({
            groupIndex,
            itemIndex,
            field: 'boardFeet',
            severity: 'warning',
            code: 'bf_mismatch',
            message: `Board feet (${item.boardFeet}) doesn't match the dimension × length × qty recompute (${round2(recomputed)}).`,
          });
        }
      }

      // Rule 4 — Low confidence.
      if (item.confidence < 0.8) {
        issues.push({
          groupIndex,
          itemIndex,
          field: 'confidence',
          severity: item.confidence < 0.6 ? 'error' : 'warning',
          code: 'low_confidence',
          message: `Extraction confidence ${Math.round(item.confidence * 100)}% — review before sending to vendors.`,
        });
      }

      // Rule 5 — Quantity outliers (likely unit error).
      if (item.unit === 'PCS' && item.quantity > 10_000) {
        issues.push({
          groupIndex,
          itemIndex,
          field: 'quantity',
          severity: 'warning',
          code: 'suspect_quantity',
          message: `${item.quantity.toLocaleString()} PCS is unusually high — check if this should be MBF or a tally total.`,
        });
      }
      if (item.unit === 'MBF' && item.quantity > 500) {
        issues.push({
          groupIndex,
          itemIndex,
          field: 'quantity',
          severity: 'warning',
          code: 'suspect_quantity',
          message: `${item.quantity} MBF on a single line is unusually large — confirm.`,
        });
      }

      // Rule 6 — Uncommon species/grade combos.
      if (item.grade && isUnusualSpeciesGradeCombo(item.species, item.grade)) {
        issues.push({
          groupIndex,
          itemIndex,
          field: 'grade',
          severity: 'warning',
          code: 'uncommon_combo',
          message: `${normalizeSpecies(item.species)} with grade "${normalizeGrade(item.grade)}" is unusual — verify the spec.`,
        });
      }

      // Rule 1 — Duplicate within the same building_group.
      const key = dupKey(item);
      if (key) {
        const bucket = dupMap.get(key) ?? [];
        if (bucket.length > 1 && bucket[0] === itemIndex) {
          // Flag the first occurrence once so the UI has a single row to point at.
          issues.push({
            groupIndex,
            itemIndex,
            severity: 'warning',
            code: 'possible_duplicate',
            message: `Duplicate line — ${bucket.length} rows in "${group.buildingTag}" share species/dim/grade/length.`,
          });
        }
      }

      // Rule 7 — Random length assumption note (info only).
      if (
        item.length &&
        item.length.toLowerCase().includes('random')
      ) {
        issues.push({
          groupIndex,
          itemIndex,
          field: 'length',
          severity: 'info',
          code: 'random_length_assumed',
          message: 'Random length assumed 14\' for board-foot math — verify against mill tally.',
        });
      }
    });
  });

  // Aggregate summary.
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  const lowConfidenceCount = issues.filter(
    (i) => i.code === 'low_confidence',
  ).length;
  const duplicateCount = issues.filter(
    (i) => i.code === 'possible_duplicate',
  ).length;

  const totalLineItems = extraction.buildingGroups.reduce(
    (sum, g) => sum + g.lineItems.length,
    0,
  );

  const penaltyFromErrors = errorCount * 0.05;
  const penaltyFromWarnings = warningCount * 0.02;
  const overallConfidence = clamp01(
    extraction.extractionConfidence - penaltyFromErrors - penaltyFromWarnings,
  );

  const pass = errorCount === 0 && overallConfidence >= 0.75;

  // Count lines that cleared every deterministic check (no issue attached
  // at all — info-severity issues like random_length_assumed still count
  // as a check fired against the line).
  const dirtyLineKeys = new Set<string>();
  for (const issue of issues) {
    dirtyLineKeys.add(`${issue.groupIndex}:${issue.itemIndex}`);
  }
  const deterministicChecksPassed = Math.max(
    0,
    totalLineItems - dirtyLineKeys.size,
  );

  return {
    pass,
    overallConfidence: round2(overallConfidence),
    issues,
    summary: {
      totalLineItems,
      flaggedCount: totalLineItems > 0 ? errorCount + warningCount : 0,
      lowConfidenceCount,
      duplicateCount,
      errorCount,
      warningCount,
    },
    deterministicChecksPassed,
    llmChecksRun: 0,
    costCents: 0,
  };
}

// -----------------------------------------------------------------------------
// runQaAgent — async wrapper that optionally runs the Haiku LLM pass
// -----------------------------------------------------------------------------

/**
 * Borderline band for the LLM pass. A line with extraction confidence in
 * [0.75, 0.92) is "good enough that the parser didn't bail but suspicious
 * enough that Haiku can catch something the rules engine missed."
 */
const LLM_CONF_MIN = 0.75;
const LLM_CONF_MAX = 0.92;

/** Max lines per Haiku call — keeps prompts snappy and cost predictable. */
const LLM_BATCH_SIZE = 30;

const QA_LLM_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Haiku 4.5 pricing (cents per 1M tokens) used to tally `costCents` on
 * the report. These are approximate — the orchestrator stores the value
 * in the extraction_costs ledger for after-the-fact reconciliation, so
 * a small drift here doesn't corrupt any accounting.
 */
const HAIKU_INPUT_CENTS_PER_MTOK = 100; // $1.00 / Mtok
const HAIKU_OUTPUT_CENTS_PER_MTOK = 500; // $5.00 / Mtok

export async function runQaAgent(
  extraction: ExtractionOutput,
  options?: RunQaAgentOptions,
): Promise<QaReport> {
  const report = qaAgent({ extraction });

  const shouldRunLlm =
    (options?.runLlmChecks ?? true) &&
    Boolean(process.env['ANTHROPIC_API_KEY']);

  if (!shouldRunLlm) return report;

  // Pick suspicious lines: anything the deterministic pass flagged, plus
  // anything whose extraction confidence sits in the borderline band.
  const suspicious = pickSuspiciousLines(extraction, report);
  if (suspicious.length === 0) return report;

  const llmIssues: QaLineItemIssue[] = [];
  let llmChecksRun = 0;
  let llmCostCents = 0;

  try {
    // Batch — Haiku is fast but many small calls are wasteful. 30 lines
    // per batch keeps each prompt well under the model's context window
    // and under 1s wall-clock on average.
    for (let i = 0; i < suspicious.length; i += LLM_BATCH_SIZE) {
      const batch = suspicious.slice(i, i + LLM_BATCH_SIZE);
      const batchResult = await reviewBatchWithHaiku(batch);
      llmChecksRun += batch.length;
      llmCostCents += batchResult.costCents;
      llmIssues.push(...batchResult.issues);
    }
  } catch (err) {
    // LLM pass failures must not fail the ingest — the deterministic
    // report is already a safe fallback. Log and return what we have.
    console.warn('[qa-agent] LLM pass failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Merge LLM issues into the report and recompute summary counts.
  const mergedIssues = [...report.issues, ...llmIssues];
  const errorCount = mergedIssues.filter((i) => i.severity === 'error').length;
  const warningCount = mergedIssues.filter(
    (i) => i.severity === 'warning',
  ).length;
  const lowConfidenceCount = mergedIssues.filter(
    (i) => i.code === 'low_confidence',
  ).length;
  const duplicateCount = mergedIssues.filter(
    (i) => i.code === 'possible_duplicate',
  ).length;

  // LLM findings don't change pass/fail directly — they add warnings
  // that surface in the review UI. An existing deterministic error keeps
  // the report failing; otherwise we preserve the pass status.
  const pass = errorCount === 0 && report.overallConfidence >= 0.75;

  return {
    ...report,
    pass,
    issues: mergedIssues,
    summary: {
      ...report.summary,
      flaggedCount: errorCount + warningCount,
      lowConfidenceCount,
      duplicateCount,
      errorCount,
      warningCount,
    },
    llmChecksRun,
    costCents: round2(llmCostCents),
  };
}

// -----------------------------------------------------------------------------
// Haiku batch helper
// -----------------------------------------------------------------------------

interface SuspiciousLine {
  groupIndex: number;
  itemIndex: number;
  buildingTag: string;
  phaseNumber: number | null;
  item: ExtractedLineItem;
}

function pickSuspiciousLines(
  extraction: ExtractionOutput,
  report: QaReport,
): SuspiciousLine[] {
  const suspicious: SuspiciousLine[] = [];
  const flaggedKeys = new Set(
    report.issues.map((i) => `${i.groupIndex}:${i.itemIndex}`),
  );

  extraction.buildingGroups.forEach(
    (group: ExtractedBuildingGroup, groupIndex: number) => {
      group.lineItems.forEach((item, itemIndex) => {
        const key = `${groupIndex}:${itemIndex}`;
        const borderline =
          item.confidence >= LLM_CONF_MIN && item.confidence < LLM_CONF_MAX;
        if (flaggedKeys.has(key) || borderline) {
          suspicious.push({
            groupIndex,
            itemIndex,
            buildingTag: group.buildingTag,
            phaseNumber: group.phaseNumber,
            item,
          });
        }
      });
    },
  );

  return suspicious;
}

interface HaikuBatchResult {
  issues: QaLineItemIssue[];
  costCents: number;
}

interface LocalTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

const QA_REVIEW_TOOL: LocalTool = {
  name: 'review_lumber_lines',
  description:
    'Emit per-line subjective review findings. Call once per batch with a verdict for every line_index supplied.',
  input_schema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line_index: {
              type: 'integer',
              description:
                'Zero-based index into the supplied batch, matching the prompt order.',
            },
            verdict: {
              type: 'string',
              enum: [
                'ok',
                'species_grade_implausible',
                'building_header_odd',
                'unusual_spec',
              ],
            },
            note: {
              type: 'string',
              description:
                'One-sentence explanation shown to the trader. Empty string for ok verdicts.',
            },
          },
          required: ['line_index', 'verdict', 'note'],
        },
      },
    },
    required: ['results'],
  },
};

const QA_SYSTEM_PROMPT = `You are a QA reviewer for a lumber list extraction pipeline. The deterministic checks already ran — your job is to catch the subjective issues the rules engine can't:

1. species_grade_implausible — the combination of species and grade is technically possible but rare enough to warrant a trader eyeball (e.g. SPF Select Structural, LVL #2, Plywood Stud).
2. building_header_odd — the building tag doesn't match the surrounding context or looks like a data value misread as a group header.
3. unusual_spec — the spec (dimension × length × quantity) looks like a transcription error (e.g. 2x10 Stud grade, which is unusual in practice, or 14' when the rest of the job is 8/10/12/16).
4. ok — none of the above; the line is fine.

You will receive a batch of lines with their building context and the neighboring lines for reference. Review each line independently and return EXACTLY one verdict per supplied line_index. Call the review_lumber_lines tool exactly once with the full batch result.`;

async function reviewBatchWithHaiku(
  batch: SuspiciousLine[],
): Promise<HaikuBatchResult> {
  if (batch.length === 0) return { issues: [], costCents: 0 };

  const anthropic = getAnthropic();
  const userText = buildQaBatchPrompt(batch);

  const response = await anthropic.messages.create({
    model: QA_LLM_MODEL,
    max_tokens: 512,
    system: QA_SYSTEM_PROMPT,
    tools: [QA_REVIEW_TOOL] as never,
    tool_choice: { type: 'tool', name: QA_REVIEW_TOOL.name } as never,
    messages: [{ role: 'user', content: userText }],
  });

  const usage = response.usage;
  const costCents = usage
    ? (usage.input_tokens / 1_000_000) * HAIKU_INPUT_CENTS_PER_MTOK +
      (usage.output_tokens / 1_000_000) * HAIKU_OUTPUT_CENTS_PER_MTOK
    : 0;

  type ResponseBlock =
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'text'; text: string }
    | { type: string; [key: string]: unknown };

  const blocks = (response.content ?? []) as ResponseBlock[];
  const toolUse = blocks.find(
    (b): b is Extract<ResponseBlock, { type: 'tool_use' }> =>
      b.type === 'tool_use' && b.name === QA_REVIEW_TOOL.name,
  );

  if (!toolUse) return { issues: [], costCents };

  interface RawResult {
    line_index: number;
    verdict: string;
    note?: string;
  }
  const input = toolUse.input as { results?: RawResult[] };
  const results = Array.isArray(input.results) ? input.results : [];

  const issues: QaLineItemIssue[] = [];
  for (const result of results) {
    if (typeof result.line_index !== 'number') continue;
    const entry = batch[result.line_index];
    if (!entry) continue;
    if (result.verdict === 'ok') continue;

    const baseIssue: Omit<QaLineItemIssue, 'code' | 'message'> = {
      groupIndex: entry.groupIndex,
      itemIndex: entry.itemIndex,
      severity: 'warning',
    };
    const note = (result.note ?? '').trim();

    if (result.verdict === 'species_grade_implausible') {
      issues.push({
        ...baseIssue,
        code: 'llm_species_grade_implausible',
        message:
          note || `${entry.item.species} + ${entry.item.grade} looks unusual.`,
      });
    } else if (result.verdict === 'building_header_odd') {
      issues.push({
        ...baseIssue,
        code: 'llm_building_header_odd',
        message: note || `Building tag "${entry.buildingTag}" looks off.`,
      });
    } else if (result.verdict === 'unusual_spec') {
      issues.push({
        ...baseIssue,
        code: 'llm_unusual_spec',
        message:
          note ||
          `Spec looks like it may be a transcription error — verify with the customer.`,
      });
    }
  }

  return { issues, costCents };
}

function buildQaBatchPrompt(batch: SuspiciousLine[]): string {
  const lines: string[] = [
    `Review the following ${batch.length} lumber line item(s). Respond with exactly one verdict per line_index.`,
    '',
  ];
  batch.forEach((entry, index) => {
    lines.push(`--- line_index: ${index} ---`);
    lines.push(
      `Building: ${entry.buildingTag}${entry.phaseNumber != null ? ` (Phase ${entry.phaseNumber})` : ''}`,
    );
    lines.push(`Species: ${entry.item.species || '(missing)'}`);
    lines.push(`Dimension: ${entry.item.dimension || '(missing)'}`);
    lines.push(`Grade: ${entry.item.grade || '(missing)'}`);
    lines.push(`Length: ${entry.item.length || '(missing)'}`);
    lines.push(`Quantity: ${entry.item.quantity} ${entry.item.unit}`);
    lines.push(`Confidence: ${Math.round(entry.item.confidence * 100)}%`);
    if (entry.item.originalText) {
      lines.push(`Original text: ${entry.item.originalText}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function dupKey(item: ExtractedLineItem): string {
  if (!item.species || !item.dimension) return '';
  return [
    item.species.toLowerCase(),
    item.dimension.toLowerCase(),
    (item.grade ?? '').toLowerCase(),
    (item.length ?? '').toLowerCase(),
  ].join('|');
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
