/**
 * QA agent — mechanical rules engine for extracted lumber lists.
 *
 * Purpose:  After extraction-agent returns, LMBR must decide whether the
 *           list is clean enough to put in front of a trader or needs
 *           human review first. qa-agent is pure TypeScript (no Claude
 *           call) so the checks are fast, deterministic, testable, and
 *           auditable: the trader can look at a flagged row and see
 *           exactly which rule fired.
 *
 *           Rules enforced (per PROMPT 02 spec):
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
 * Inputs:   { extraction: ExtractionOutput }.
 * Outputs:  QaReport.
 * Agent/API: none — runs in Node/Edge, no external calls.
 * Imports:  @lmbr/lib (normalizers + isUnusualSpeciesGradeCombo,
 *           boardFeetFromDimension), @lmbr/types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import {
  boardFeetFromDimension,
  isUnusualSpeciesGradeCombo,
  normalizeSpecies,
  normalizeGrade,
} from '@lmbr/lib';
import type { ExtractionOutput, ExtractedLineItem } from '@lmbr/types';

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
  | 'random_length_assumed';

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
  };
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
