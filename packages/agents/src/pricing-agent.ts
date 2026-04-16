/**
 * Pricing agent — deterministic margin-stack evaluator + approval gate.
 *
 * Purpose:  Pure, testable engine for the Prompt 07 margin stack. Given a
 *           snapshot of a bid's lines, the buyer's vendor selections, a
 *           list of margin instructions, and the company's approval
 *           settings, this agent produces:
 *             - per-line sell prices with last-write-wins margin resolution
 *             - company-side totals (cost / sell / blended margin)
 *             - lumber + sales tax numbers (state-aware)
 *             - flags: needsApproval, belowMinimumMargin, unresolvedLines
 *
 *           No Anthropic call. No database I/O. No network. The route
 *           handler at apps/web/src/app/api/margin fetches the raw
 *           snapshot under RLS and hands it to this function; the UI then
 *           renders the result and, on submit, the same result is
 *           persisted to public.quotes + public.quote_line_items.
 *
 * Determinism contract — READ THIS BEFORE EDITING:
 *   1. Same PricingInput MUST always produce the same PricingResult.
 *   2. Lines are sorted by (sortOrder ASC, buildingTag ASC, lineItemId ASC).
 *   3. Margin instructions are evaluated in the ORDER given. Last
 *      matching instruction wins (later overrides earlier). We record
 *      `appliedInstructionIndex` so the UI can show the trader which
 *      instruction drove the number.
 *   4. All money is rounded to 2 decimals. Percentages to 4 decimals.
 *      Round once at the edge — intermediate math runs unrounded so
 *      we don't compound drift across many lines.
 *
 * Margin semantics:
 *   - `percent` (e.g. 0.15) — sellUnitPrice = costUnitPrice × (1 + 0.15).
 *     Effective per-line `marginPercent` = 0.15.
 *   - `dollar` (e.g. 0.50 $/PCS) — sellUnitPrice = costUnitPrice + 0.50.
 *     Effective per-line `marginPercent` = 0.50 / costUnitPrice. When
 *     costUnitPrice is 0 we fall back to 0 (to avoid Infinity) and warn.
 *
 *   Scope hierarchy (lowest → highest specificity):
 *     'all'        → applies to every priced line.
 *     'commodity'  → applies when commodityGroupFor(line.species) matches
 *                    the instruction's targetId (e.g. 'Dimensional').
 *     'line'       → applies when line.lineItemId matches targetId.
 *
 *   Because we evaluate in input order and keep last match, the UI can
 *   layer bulk → commodity → per-line by appending instructions in that
 *   order. This matches the Trader-Buyer margin stack UI model.
 *
 *   Lines with no matching instruction carry marginPercent: 0,
 *   sellUnitPrice: costUnitPrice, appliedInstructionIndex: -1, and emit
 *   a warning so the UI can surface "no margin on this line".
 *
 * Tax semantics:
 *   - If jobState is null/blank → both taxes are 0, taxJurisdiction.state
 *     is null. The quote UI should warn that a state is required.
 *   - State sales tax = getStateSalesTax(jobState) applied to totalSell.
 *   - CA lumber assessment applies ONLY when jobState === 'CA'. Basis is
 *     totalSell (simplification — see TODO below).
 *
 * Inputs:   PricingInput, Zod-validated at the function boundary.
 * Outputs:  PricingResult.
 * Agent/API: none — pure TypeScript.
 * Imports:  zod, @lmbr/config (tax), ./routing-agent (commodity grouping).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';

import {
  CA_LUMBER_ASSESSMENT,
  getStateSalesTax,
} from '@lmbr/config';

import { commodityGroupFor } from './routing-agent';

// -----------------------------------------------------------------------------
// Input / output types
// -----------------------------------------------------------------------------

export type ConsolidationMode = 'structured' | 'consolidated' | 'phased' | 'hybrid';

export interface PricingSelection {
  lineItemId: string;
  vendorBidLineItemId: string;
  /** Internal only — NEVER flows to QuotePdfInput. */
  vendorId: string;
  costUnitPrice: number;
  costTotalPrice: number;
}

export interface PricingLineInput {
  lineItemId: string;
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number;
  unit: 'PCS' | 'MBF' | 'MSF';
  buildingTag: string | null;
  phaseNumber: number | null;
  sortOrder: number;
}

export type MarginScope = 'line' | 'commodity' | 'all';
export type MarginType = 'percent' | 'dollar';

export interface MarginInstruction {
  scope: MarginScope;
  /** For 'line': lineItemId. For 'commodity': commodity group label. For 'all': null. */
  targetId: string | null;
  marginType: MarginType;
  /** percent: 0.15 = 15% markup on cost. dollar: flat $ per PCS/MBF/MSF. */
  marginValue: number;
}

export interface PricingInput {
  bidId: string;
  /** 2-letter US state code; null if unknown (taxes become 0 for null). */
  jobState: string | null;
  consolidationMode: ConsolidationMode;
  lines: PricingLineInput[];
  selections: PricingSelection[];
  marginInstructions: MarginInstruction[];
  settings: {
    approvalThresholdDollars: number;
    minMarginPercent: number;
  };
}

export interface PricedLine {
  lineItemId: string;
  vendorBidLineItemId: string;
  /** Internal; deliberately NOT copied into QuotePdfInput. */
  vendorId: string;
  costUnitPrice: number;
  costTotalPrice: number;
  marginPercent: number;
  sellUnitPrice: number;
  extendedSell: number;
  building: { tag: string | null; phaseNumber: number | null };
  summary: {
    species: string;
    dimension: string;
    grade: string | null;
    length: string | null;
    quantity: number;
    unit: 'PCS' | 'MBF' | 'MSF';
  };
  sortOrder: number;
  /** -1 if no instruction matched; else index into input.marginInstructions. */
  appliedInstructionIndex: number;
}

export interface PricingTotals {
  totalCost: number;
  totalSell: number;
  marginDollars: number;
  blendedMarginPercent: number;
  lumberTax: number;
  salesTax: number;
  grandTotal: number;
}

export interface PricingFlags {
  needsApproval: boolean;
  belowMinimumMargin: boolean;
  unresolvedLineItemIds: string[];
  warnings: string[];
}

export interface PricingResult {
  bidId: string;
  consolidationMode: ConsolidationMode;
  lines: PricedLine[];
  totals: PricingTotals;
  flags: PricingFlags;
  taxJurisdiction: { state: string | null; lumberRate: number; salesRate: number };
}

// -----------------------------------------------------------------------------
// Zod input schema (CLAUDE.md: all agent inputs are Zod-validated)
// -----------------------------------------------------------------------------

const MarginScopeSchema = z.enum(['line', 'commodity', 'all']);
const MarginTypeSchema = z.enum(['percent', 'dollar']);
const ConsolidationModeSchema = z.enum([
  'structured',
  'consolidated',
  'phased',
  'hybrid',
]);

export const PricingInputSchema = z.object({
  bidId: z.string().min(1),
  jobState: z.string().nullable(),
  consolidationMode: ConsolidationModeSchema,
  lines: z.array(
    z.object({
      lineItemId: z.string().min(1),
      species: z.string(),
      dimension: z.string(),
      grade: z.string().nullable(),
      length: z.string().nullable(),
      quantity: z.number(),
      unit: z.enum(['PCS', 'MBF', 'MSF']),
      buildingTag: z.string().nullable(),
      phaseNumber: z.number().int().nullable(),
      sortOrder: z.number(),
    }),
  ),
  selections: z.array(
    z.object({
      lineItemId: z.string().min(1),
      vendorBidLineItemId: z.string().min(1),
      vendorId: z.string().min(1),
      costUnitPrice: z.number(),
      costTotalPrice: z.number(),
    }),
  ),
  marginInstructions: z.array(
    z.object({
      scope: MarginScopeSchema,
      targetId: z.string().nullable(),
      marginType: MarginTypeSchema,
      marginValue: z.number(),
    }),
  ),
  settings: z.object({
    approvalThresholdDollars: z.number().nonnegative(),
    minMarginPercent: z.number().min(0).max(1),
  }),
});

// -----------------------------------------------------------------------------
// Rounding helpers
// -----------------------------------------------------------------------------

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10_000) / 10_000;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

export function pricingAgent(input: PricingInput): PricingResult {
  // Fail-loud on malformed input (CLAUDE.md: agent inputs Zod-validated).
  PricingInputSchema.parse(input);

  const {
    bidId,
    jobState,
    consolidationMode,
    lines,
    selections,
    marginInstructions,
    settings,
  } = input;

  // --- Resolve tax jurisdiction --------------------------------------------
  const stateCode = (jobState ?? '').trim().toUpperCase();
  const hasState = stateCode.length > 0;
  const salesRate = hasState ? getStateSalesTax(stateCode) : 0;
  const lumberRate = hasState && stateCode === 'CA' ? CA_LUMBER_ASSESSMENT : 0;
  const taxJurisdiction = {
    state: hasState ? stateCode : null,
    lumberRate,
    salesRate,
  };

  // --- Index selections by lineItemId --------------------------------------
  const selectionByLine = new Map<string, PricingSelection>();
  for (const s of selections) selectionByLine.set(s.lineItemId, s);

  // --- Sort lines deterministically ----------------------------------------
  const sortedLines = [...lines].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    const aTag = a.buildingTag ?? '';
    const bTag = b.buildingTag ?? '';
    if (aTag !== bTag) return aTag < bTag ? -1 : 1;
    if (a.lineItemId !== b.lineItemId) return a.lineItemId < b.lineItemId ? -1 : 1;
    return 0;
  });

  // --- Price each line ------------------------------------------------------
  const pricedLines: PricedLine[] = [];
  const unresolvedLineItemIds: string[] = [];
  const warnings: string[] = [];

  let totalCost = 0;
  let totalSell = 0;

  for (const line of sortedLines) {
    const sel = selectionByLine.get(line.lineItemId);
    const group = commodityGroupFor(line.species);

    if (!sel) {
      // No vendor selected for this line — zero it out, flag it, but still
      // return a row so the UI has something to point at.
      unresolvedLineItemIds.push(line.lineItemId);
      pricedLines.push({
        lineItemId: line.lineItemId,
        vendorBidLineItemId: '',
        vendorId: '',
        costUnitPrice: 0,
        costTotalPrice: 0,
        marginPercent: 0,
        sellUnitPrice: 0,
        extendedSell: 0,
        building: { tag: line.buildingTag, phaseNumber: line.phaseNumber },
        summary: {
          species: line.species,
          dimension: line.dimension,
          grade: line.grade,
          length: line.length,
          quantity: line.quantity,
          unit: line.unit,
        },
        sortOrder: line.sortOrder,
        appliedInstructionIndex: -1,
      });
      continue;
    }

    // --- Evaluate margin stack last-write-wins ---
    let appliedIdx = -1;
    let appliedType: MarginType | null = null;
    let appliedValue = 0;

    for (let i = 0; i < marginInstructions.length; i += 1) {
      const inst = marginInstructions[i]!;
      let matches = false;
      if (inst.scope === 'all') {
        matches = true;
      } else if (inst.scope === 'commodity') {
        matches = inst.targetId !== null && inst.targetId === group;
      } else if (inst.scope === 'line') {
        matches = inst.targetId !== null && inst.targetId === line.lineItemId;
      }
      if (matches) {
        appliedIdx = i;
        appliedType = inst.marginType;
        appliedValue = inst.marginValue;
      }
    }

    // --- Compute sell price ---
    let marginPercent = 0;
    let sellUnitPrice = sel.costUnitPrice;
    if (appliedIdx !== -1 && appliedType !== null) {
      if (appliedType === 'percent') {
        marginPercent = appliedValue;
        sellUnitPrice = sel.costUnitPrice * (1 + appliedValue);
      } else {
        // dollar
        sellUnitPrice = sel.costUnitPrice + appliedValue;
        if (sel.costUnitPrice === 0) {
          marginPercent = 0;
          warnings.push(
            `line ${line.lineItemId}: dollar margin applied to zero-cost line — effective percent coerced to 0`,
          );
        } else {
          marginPercent = appliedValue / sel.costUnitPrice;
        }
      }
    } else {
      warnings.push(
        `line ${line.lineItemId}: no margin instruction matched — sell = cost`,
      );
    }

    const extendedSell = sellUnitPrice * line.quantity;

    totalCost += sel.costTotalPrice;
    totalSell += extendedSell;

    pricedLines.push({
      lineItemId: line.lineItemId,
      vendorBidLineItemId: sel.vendorBidLineItemId,
      vendorId: sel.vendorId,
      costUnitPrice: round2(sel.costUnitPrice),
      costTotalPrice: round2(sel.costTotalPrice),
      marginPercent: round4(marginPercent),
      sellUnitPrice: round2(sellUnitPrice),
      extendedSell: round2(extendedSell),
      building: { tag: line.buildingTag, phaseNumber: line.phaseNumber },
      summary: {
        species: line.species,
        dimension: line.dimension,
        grade: line.grade,
        length: line.length,
        quantity: line.quantity,
        unit: line.unit,
      },
      sortOrder: line.sortOrder,
      appliedInstructionIndex: appliedIdx,
    });
  }

  // --- Totals ---------------------------------------------------------------
  const totalCostR = round2(totalCost);
  const totalSellR = round2(totalSell);
  const marginDollars = round2(totalSellR - totalCostR);
  const blendedMarginPercent =
    totalSellR > 0 ? round4(marginDollars / totalSellR) : 0;

  // TODO(prompt-09): narrow the CA lumber assessment basis to qualifying
  // lumber lines only (exclude panels / engineered that aren't "lumber
  // products" under the CDTFA definition). For now we apply to totalSell.
  const lumberTax = round2(totalSellR * lumberRate);
  const salesTax = round2(totalSellR * salesRate);
  const grandTotal = round2(totalSellR + lumberTax + salesTax);

  // --- Flags ----------------------------------------------------------------
  const needsApproval = grandTotal > settings.approvalThresholdDollars;
  const belowMinimumMargin = blendedMarginPercent < settings.minMarginPercent;

  return {
    bidId,
    consolidationMode,
    lines: pricedLines,
    totals: {
      totalCost: totalCostR,
      totalSell: totalSellR,
      marginDollars,
      blendedMarginPercent,
      lumberTax,
      salesTax,
      grandTotal,
    },
    flags: {
      needsApproval,
      belowMinimumMargin,
      unresolvedLineItemIds,
      warnings,
    },
    taxJurisdiction,
  };
}
