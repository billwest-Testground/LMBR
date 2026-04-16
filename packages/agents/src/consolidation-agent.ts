/**
 * Consolidation agent — aggregate line items for mill pricing.
 *
 * Purpose:  Pure TypeScript, no LLM. Takes a set of line items and a
 *           consolidation mode, returns aggregated items with source
 *           mapping. The source map is the core of HYBRID mode — vendors
 *           see consolidated totals, customers see building/phase breakdown,
 *           LMBR holds the link between the two.
 *
 * Inputs:   line items (from DB) + consolidation mode + optional active phases.
 * Outputs:  ConsolidationResult — consolidated items, source map, summary.
 * Agent/API: none — pure TypeScript.
 * Imports:  @lmbr/lib (consolidationKey), @lmbr/types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { consolidationKey } from '@lmbr/lib';
import type { ConsolidationMode } from '@lmbr/types';

// -----------------------------------------------------------------------------
// Input / output types
// -----------------------------------------------------------------------------

export interface ConsolidationLineItem {
  id: string;
  bidId: string;
  companyId: string;
  buildingTag: string | null;
  phaseNumber: number | null;
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number;
  unit: string;
  boardFeet: number | null;
  confidence: number | null;
  flags: string[];
  sortOrder: number;
  extractionMethod: string | null;
  extractionConfidence: number | null;
  costCents: number | null;
}

export interface ConsolidatedItem {
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number;
  unit: string;
  boardFeet: number;
  confidence: number;
  flags: string[];
  sourceLineItemIds: string[];
  originalLineItemId: string;
  sortOrder: number;
  consolidationKey: string;
}

export interface ConsolidationResult {
  consolidatedItems: ConsolidatedItem[];
  summary: {
    originalCount: number;
    consolidatedCount: number;
    reductionPercent: number;
    buildingCount: number;
    phaseCount: number;
    totalBoardFeet: number;
  };
  deferredPhases: number[];
}

export interface ConsolidationInput {
  lineItems: ConsolidationLineItem[];
  mode: ConsolidationMode;
  activePhases?: number[];
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

export function consolidationAgent(input: ConsolidationInput): ConsolidationResult {
  const { lineItems, mode, activePhases } = input;

  const buildingTags = new Set(
    lineItems.map((li) => li.buildingTag).filter(Boolean),
  );
  const phaseNumbers = new Set(
    lineItems.map((li) => li.phaseNumber).filter((p): p is number => p != null),
  );
  const totalBoardFeet = lineItems.reduce(
    (sum, li) => sum + (li.boardFeet ?? 0),
    0,
  );

  const baseSummary = {
    originalCount: lineItems.length,
    buildingCount: buildingTags.size,
    phaseCount: phaseNumbers.size,
    totalBoardFeet: Math.round(totalBoardFeet * 100) / 100,
  };

  if (mode === 'structured') {
    return {
      consolidatedItems: [],
      summary: {
        ...baseSummary,
        consolidatedCount: lineItems.length,
        reductionPercent: 0,
      },
      deferredPhases: [],
    };
  }

  if (mode === 'phased') {
    return runPhasedConsolidation(lineItems, activePhases ?? [], baseSummary);
  }

  // CONSOLIDATED and HYBRID both run the same aggregation logic.
  const consolidated = aggregateItems(lineItems);

  return {
    consolidatedItems: consolidated,
    summary: {
      ...baseSummary,
      consolidatedCount: consolidated.length,
      reductionPercent:
        lineItems.length === 0
          ? 0
          : Math.round(
              ((lineItems.length - consolidated.length) / lineItems.length) * 100,
            ),
    },
    deferredPhases: [],
  };
}

// -----------------------------------------------------------------------------
// Aggregation
// -----------------------------------------------------------------------------

function aggregateItems(lineItems: ConsolidationLineItem[]): ConsolidatedItem[] {
  const groups = new Map<
    string,
    {
      items: ConsolidationLineItem[];
      key: string;
    }
  >();

  for (const item of lineItems) {
    const key = consolidationKey({
      species: item.species,
      dimension: item.dimension,
      grade: item.grade,
      length: item.length,
      unit: item.unit,
    });

    const group = groups.get(key);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(key, { items: [item], key });
    }
  }

  const result: ConsolidatedItem[] = [];
  let sortOrder = 0;

  for (const [, group] of groups) {
    const items = group.items;
    const first = items[0];
    if (!first) continue;

    const totalQty = items.reduce((s, i) => s + i.quantity, 0);
    const totalBf = items.reduce((s, i) => s + (i.boardFeet ?? 0), 0);

    // Lowest confidence — a consolidated row is only as trustworthy
    // as its weakest source.
    const confidence = items.reduce(
      (min, i) => Math.min(min, i.confidence ?? i.extractionConfidence ?? 1),
      1,
    );

    // Union of all flags, deduplicated.
    const allFlags = new Set<string>();
    for (const item of items) {
      for (const flag of item.flags) allFlags.add(flag);
    }

    // Primary source pointer: highest quantity source.
    const primarySource = items.reduce((best, i) =>
      i.quantity > best.quantity ? i : best,
    );

    result.push({
      species: first.species,
      dimension: first.dimension,
      grade: first.grade,
      length: first.length,
      quantity: Math.round(totalQty * 10000) / 10000,
      unit: first.unit,
      boardFeet: Math.round(totalBf * 100) / 100,
      confidence: Math.round(confidence * 10000) / 10000,
      flags: [...allFlags],
      sourceLineItemIds: items.map((i) => i.id),
      originalLineItemId: primarySource.id,
      sortOrder: sortOrder++,
      consolidationKey: group.key,
    });
  }

  return result;
}

// -----------------------------------------------------------------------------
// Phased consolidation
// -----------------------------------------------------------------------------

function runPhasedConsolidation(
  lineItems: ConsolidationLineItem[],
  activePhases: number[],
  baseSummary: {
    originalCount: number;
    buildingCount: number;
    phaseCount: number;
    totalBoardFeet: number;
  },
): ConsolidationResult {
  if (activePhases.length === 0) {
    throw new Error('At least one phase must be active for PHASED mode.');
  }

  const activeSet = new Set(activePhases);
  const activeItems = lineItems.filter(
    (li) => li.phaseNumber != null && activeSet.has(li.phaseNumber),
  );

  const allPhases = new Set(
    lineItems.map((li) => li.phaseNumber).filter((p): p is number => p != null),
  );
  const deferredPhases = [...allPhases].filter((p) => !activeSet.has(p));

  const consolidated = aggregateItems(activeItems);

  return {
    consolidatedItems: consolidated,
    summary: {
      ...baseSummary,
      consolidatedCount: consolidated.length,
      reductionPercent:
        activeItems.length === 0
          ? 0
          : Math.round(
              ((activeItems.length - consolidated.length) / activeItems.length) *
                100,
            ),
    },
    deferredPhases,
  };
}
