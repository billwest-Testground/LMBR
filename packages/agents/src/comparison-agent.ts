/**
 * Comparison agent — deterministic best-vendor-per-line matrix builder.
 *
 * Purpose:  Pure, testable ranking engine for the Prompt 06 comparison
 *           matrix. Given a flat snapshot of one bid's vendors, line items,
 *           and vendor-line pricing rows, this agent produces:
 *             - a 2D matrix ordered by line sort key × vendor column order
 *             - best/worst/spread numbers per line
 *             - per-vendor response-coverage summaries
 *             - two suggested selection strategies:
 *                 * `cheapest`        — pick the lowest unit price per line
 *                 * `fewestVendors`   — greedy set-cover with deterministic
 *                                       tiebreak so the same input never
 *                                       returns a different vendor set.
 *
 *           No Anthropic call. No database I/O. No network. The route
 *           handler at apps/web/src/app/api/compare/[bidId]/route.ts fetches
 *           the raw snapshot under RLS and hands it to this function; the
 *           UI then renders the result directly.
 *
 * Vendor status semantics — READ THIS BEFORE EDITING:
 *   - LIVE statuses (prices participate in best/worst/spread ranking):
 *       * 'submitted' — vendor has fully responded with pricing.
 *       * 'partial'   — vendor has responded with some lines priced.
 *   - NOT-LIVE statuses (prices excluded from ranking, cells null-priced):
 *       * 'declined'  — vendor declined to quote. Cell renders `declined: true`.
 *       * 'expired'   — vendor's window passed. Cell renders `declined: false`,
 *                        `unitPrice: null`, `totalPrice: null`.
 *       * 'pending'   — vendor hasn't responded yet. Same as 'expired' for
 *                        matrix rendering (no price, `declined: false`).
 *   A vendor's stale row data (e.g. an old unit_price on an expired
 *   vendor_bid_line_item) is intentionally ignored — only vendors in a
 *   live status contribute to ranking or appear priced in the matrix.
 *
 * Determinism contract — READ THIS BEFORE EDITING:
 *   1. Same ComparisonInput MUST always produce the same ComparisonResult.
 *   2. Lines are ordered by (sortOrder ASC, buildingTag ASC, lineItemId ASC).
 *   3. Vendor columns preserve ComparisonInput.vendors order as given.
 *   4. When two or more vendors tie on lowest unitPrice for a line, the
 *      winner is chosen in this exact order:
 *        a. Vendor with the most line items priced on this bid
 *           (pure `linesPriced` count — higher wins).
 *        b. Alphabetical by vendor name, case-insensitive
 *           (`.toLowerCase()` comparison on the raw name).
 *      Vendor names are unique per company at the DB layer, so (b) always
 *      breaks ties — no third tiebreaker needed. If that invariant ever
 *      changes, add the next tiebreaker here, not in the UI.
 *   5. "Fastest average response time" tiebreak from the spec is NOT
 *      implemented here — the data isn't available at this layer and
 *      stubbing it would compromise determinism. Add it in a follow-up if
 *      response-time data becomes part of ComparisonInput.
 *
 * Inputs:   ComparisonInput — flat, denormalized snapshot (see types below).
 *           Validated at the function boundary via ComparisonInputSchema
 *           (Zod). Malformed input throws, per CLAUDE.md agent conventions.
 * Outputs:  ComparisonResult — matrix rows, vendor summaries, suggestions.
 * Agent/API: none — pure TypeScript.
 * Imports:  zod, @lmbr/types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';

import { VendorBidStatusSchema, type VendorBidStatus } from '@lmbr/types';

// -----------------------------------------------------------------------------
// Input / output types
// -----------------------------------------------------------------------------

export interface ComparisonVendor {
  vendorId: string;
  vendorName: string;
  vendorBidId: string;
  status: VendorBidStatus;
}

export interface ComparisonVendorLine {
  vendorBidLineItemId: string;
  vendorBidId: string;
  vendorId: string;
  lineItemId: string;
  unitPrice: number | null;
  totalPrice: number | null;
}

export interface ComparisonLineInput {
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

export interface ComparisonInput {
  bidId: string;
  vendors: ComparisonVendor[];
  lines: ComparisonLineInput[];
  vendorLines: ComparisonVendorLine[];
}

export interface ComparisonCell {
  vendorId: string;
  vendorBidLineItemId: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  isBestPrice: boolean;
  isWorstPrice: boolean;
  declined: boolean;
  percentAboveBest: number | null;
}

export interface ComparisonRow {
  lineItemId: string;
  lineSummary: {
    species: string;
    dimension: string;
    grade: string | null;
    length: string | null;
    quantity: number;
    unit: 'PCS' | 'MBF' | 'MSF';
    buildingTag: string | null;
    phaseNumber: number | null;
  };
  cells: ComparisonCell[];
  bestUnitPrice: number | null;
  worstUnitPrice: number | null;
  spreadAmount: number | null;
  spreadPercent: number | null;
  bidCount: number;
  bestVendorId: string | null;
}

export interface VendorSummary {
  vendorId: string;
  vendorName: string;
  linesPriced: number;
  linesDeclined: number;
  linesNoBid: number;
  responseCoveragePercent: number;
  totalIfAllSelected: number;
}

export interface SuggestedSelection {
  mode: 'cheapest' | 'fewest_vendors';
  selections: Record<string, string>;
  vendorsInvolved: string[];
  totalCost: number;
  unresolvedLineItemIds: string[];
}

export interface ComparisonResult {
  bidId: string;
  vendors: ComparisonVendor[];
  rows: ComparisonRow[];
  vendorSummaries: VendorSummary[];
  suggestions: {
    cheapest: SuggestedSelection;
    fewestVendors: SuggestedSelection;
  };
}

// -----------------------------------------------------------------------------
// Zod input schema (CLAUDE.md: all agent inputs are Zod-validated)
// -----------------------------------------------------------------------------

/**
 * Validates the shape of ComparisonInput at the function boundary.
 * We intentionally do NOT validate ComparisonResult — it's our output, we
 * own its shape, and validating it would add runtime cost with no caller-
 * protection benefit.
 */
export const ComparisonInputSchema = z.object({
  bidId: z.string().min(1),
  vendors: z.array(
    z.object({
      vendorId: z.string().min(1),
      vendorName: z.string(),
      vendorBidId: z.string().min(1),
      status: VendorBidStatusSchema,
    }),
  ),
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
      phaseNumber: z.number().nullable(),
      sortOrder: z.number(),
    }),
  ),
  vendorLines: z.array(
    z.object({
      vendorBidLineItemId: z.string().min(1),
      vendorBidId: z.string().min(1),
      vendorId: z.string().min(1),
      lineItemId: z.string().min(1),
      unitPrice: z.number().nullable(),
      totalPrice: z.number().nullable(),
    }),
  ),
});

// -----------------------------------------------------------------------------
// Status semantics
// -----------------------------------------------------------------------------

/**
 * Returns true for statuses whose prices should participate in the
 * best/worst/spread ranking. See the status-semantics block in the file
 * header for the full rationale. Single source of truth for "live" here —
 * if you change this, also update the file header docs and tests.
 */
function isLive(status: VendorBidStatus): boolean {
  return status === 'submitted' || status === 'partial';
}

// -----------------------------------------------------------------------------
// Rounding helpers
// -----------------------------------------------------------------------------

/** Round to 4 decimals, preserving null. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

export function comparisonAgent(input: ComparisonInput): ComparisonResult {
  // Fail-loud on malformed input (CLAUDE.md: all agent inputs are Zod-validated).
  ComparisonInputSchema.parse(input);

  const { bidId, vendors, lines, vendorLines } = input;

  // --- Empty-input fast path (still returns a valid-shaped result) ---------
  if (vendors.length === 0 && lines.length === 0) {
    return {
      bidId,
      vendors: [],
      rows: [],
      vendorSummaries: [],
      suggestions: {
        cheapest: emptySuggestion('cheapest'),
        fewestVendors: emptySuggestion('fewest_vendors'),
      },
    };
  }

  // --- Index vendors and lines for O(1) lookup -----------------------------
  const vendorById = new Map<string, ComparisonVendor>();
  for (const v of vendors) vendorById.set(v.vendorId, v);

  // Ineligible = any vendor whose status is NOT live. These are excluded
  // from best/worst/spread and render as null-priced cells. The `declined`
  // cell flag is set ONLY for status === 'declined' (see below).
  const ineligibleVendorIds = new Set<string>();
  for (const v of vendors) {
    if (!isLive(v.status)) ineligibleVendorIds.add(v.vendorId);
  }

  // Index vendor lines by (lineItemId, vendorId). If the snapshot somehow
  // contains duplicate rows for the same pair, the latest one wins — this
  // shouldn't happen under the (vendor_bid_id, line_item_id) unique
  // constraint, but we stay defensive so determinism holds.
  const vlByLineAndVendor = new Map<string, Map<string, ComparisonVendorLine>>();
  for (const vl of vendorLines) {
    let perLine = vlByLineAndVendor.get(vl.lineItemId);
    if (!perLine) {
      perLine = new Map();
      vlByLineAndVendor.set(vl.lineItemId, perLine);
    }
    perLine.set(vl.vendorId, vl);
  }

  // --- Sort lines: sortOrder ASC, buildingTag ASC, lineItemId ASC ----------
  const sortedLines = [...lines].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    const aTag = a.buildingTag ?? '';
    const bTag = b.buildingTag ?? '';
    if (aTag !== bTag) return aTag < bTag ? -1 : 1;
    if (a.lineItemId !== b.lineItemId) return a.lineItemId < b.lineItemId ? -1 : 1;
    return 0;
  });

  // --- Pass 1: raw linesPriced per vendor (needed for tiebreak) ------------
  const linesPricedCount = new Map<string, number>();
  for (const v of vendors) linesPricedCount.set(v.vendorId, 0);
  for (const line of sortedLines) {
    const perLine = vlByLineAndVendor.get(line.lineItemId);
    if (!perLine) continue;
    for (const vendor of vendors) {
      if (ineligibleVendorIds.has(vendor.vendorId)) continue;
      const vl = perLine.get(vendor.vendorId);
      if (vl && vl.unitPrice !== null && vl.unitPrice !== undefined) {
        linesPricedCount.set(vendor.vendorId, (linesPricedCount.get(vendor.vendorId) ?? 0) + 1);
      }
    }
  }

  // --- Pass 2: build rows with cells + best/worst --------------------------
  const rows: ComparisonRow[] = [];
  for (const line of sortedLines) {
    const perLine = vlByLineAndVendor.get(line.lineItemId);
    const cells: ComparisonCell[] = [];

    // First pass on this line — collect unit prices for live vendors only.
    const pricedForLine: Array<{ vendorId: string; unitPrice: number }> = [];

    for (const vendor of vendors) {
      const ineligible = ineligibleVendorIds.has(vendor.vendorId);
      const vl = perLine?.get(vendor.vendorId);
      const hasPrice =
        !ineligible && !!vl && vl.unitPrice !== null && vl.unitPrice !== undefined;

      if (hasPrice && vl) {
        pricedForLine.push({ vendorId: vendor.vendorId, unitPrice: vl.unitPrice as number });
      }
    }

    let bestUnitPrice: number | null = null;
    let worstUnitPrice: number | null = null;
    let bestVendorId: string | null = null;

    if (pricedForLine.length > 0) {
      bestUnitPrice = pricedForLine[0]!.unitPrice;
      worstUnitPrice = pricedForLine[0]!.unitPrice;
      for (const entry of pricedForLine) {
        if (entry.unitPrice < bestUnitPrice) bestUnitPrice = entry.unitPrice;
        if (entry.unitPrice > worstUnitPrice) worstUnitPrice = entry.unitPrice;
      }
      // Collect all vendors tied at best price, then apply tiebreak.
      const tied = pricedForLine.filter((p) => p.unitPrice === bestUnitPrice);
      bestVendorId = pickTiebreakWinner(
        tied.map((p) => p.vendorId),
        vendorById,
        linesPricedCount,
      );
    }

    for (const vendor of vendors) {
      const ineligible = ineligibleVendorIds.has(vendor.vendorId);
      // `declined` cell flag: ONLY for explicit 'declined' status. Expired
      // and pending vendors are null-priced but not flagged as declined.
      const isDeclined = vendor.status === 'declined';
      const vl = perLine?.get(vendor.vendorId);
      const unitPrice =
        !ineligible && vl && vl.unitPrice !== null && vl.unitPrice !== undefined
          ? vl.unitPrice
          : null;
      const totalPrice =
        !ineligible && vl && vl.totalPrice !== null && vl.totalPrice !== undefined
          ? vl.totalPrice
          : null;

      let percentAboveBest: number | null = null;
      if (unitPrice !== null && bestUnitPrice !== null && bestUnitPrice !== 0) {
        percentAboveBest = round4((unitPrice - bestUnitPrice) / bestUnitPrice);
      } else if (unitPrice !== null && bestUnitPrice === 0) {
        // Degenerate case — best is exactly 0. Treat anything > 0 as
        // null percentAboveBest (avoid division by zero). Cells AT 0
        // get 0.
        percentAboveBest = unitPrice === 0 ? 0 : null;
      }

      cells.push({
        vendorId: vendor.vendorId,
        vendorBidLineItemId: vl?.vendorBidLineItemId ?? null,
        unitPrice,
        totalPrice,
        isBestPrice: vendor.vendorId === bestVendorId && unitPrice !== null,
        isWorstPrice:
          unitPrice !== null &&
          worstUnitPrice !== null &&
          unitPrice === worstUnitPrice &&
          pricedForLine.length >= 2,
        declined: isDeclined,
        percentAboveBest,
      });
    }

    let spreadAmount: number | null = null;
    let spreadPercent: number | null = null;
    if (pricedForLine.length >= 2 && bestUnitPrice !== null && worstUnitPrice !== null) {
      spreadAmount = worstUnitPrice - bestUnitPrice;
      if (bestUnitPrice !== 0) {
        spreadPercent = round4(spreadAmount / bestUnitPrice);
      }
    }

    rows.push({
      lineItemId: line.lineItemId,
      lineSummary: {
        species: line.species,
        dimension: line.dimension,
        grade: line.grade,
        length: line.length,
        quantity: line.quantity,
        unit: line.unit,
        buildingTag: line.buildingTag,
        phaseNumber: line.phaseNumber,
      },
      cells,
      bestUnitPrice,
      worstUnitPrice,
      spreadAmount,
      spreadPercent,
      bidCount: pricedForLine.length,
      bestVendorId,
    });
  }

  // --- Vendor summaries ----------------------------------------------------
  const totalLines = sortedLines.length;
  const vendorSummaries: VendorSummary[] = vendors.map((vendor) => {
    const ineligible = ineligibleVendorIds.has(vendor.vendorId);
    const isDeclined = vendor.status === 'declined';
    let linesPriced = 0;
    let linesNoBid = 0;
    let totalIfAllSelected = 0;

    for (const line of sortedLines) {
      const vl = vlByLineAndVendor.get(line.lineItemId)?.get(vendor.vendorId);
      if (ineligible) continue; // counted via linesDeclined / linesNoBid below
      const hasPrice = !!vl && vl.unitPrice !== null && vl.unitPrice !== undefined;
      if (hasPrice) {
        linesPriced += 1;
        if (vl && vl.totalPrice !== null && vl.totalPrice !== undefined) {
          totalIfAllSelected += vl.totalPrice;
        }
      } else {
        linesNoBid += 1;
      }
    }

    // Only explicit 'declined' status rolls up into linesDeclined. Expired
    // and pending vendors contribute their line count to linesNoBid so the
    // coverage view reflects "no live price".
    const linesDeclined = isDeclined ? totalLines : 0;
    const ineligibleNoBid = ineligible && !isDeclined ? totalLines : 0;
    const responseCoveragePercent =
      totalLines === 0 ? 0 : round4(linesPriced / totalLines);

    return {
      vendorId: vendor.vendorId,
      vendorName: vendor.vendorName,
      linesPriced,
      linesDeclined,
      linesNoBid: ineligible ? ineligibleNoBid : linesNoBid,
      responseCoveragePercent,
      totalIfAllSelected: round4(totalIfAllSelected),
    };
  });

  // --- Suggestions ---------------------------------------------------------
  const cheapest = buildCheapestSuggestion(rows, vlByLineAndVendor);
  const fewestVendors = buildFewestVendorsSuggestion(
    sortedLines,
    vendors,
    vlByLineAndVendor,
    ineligibleVendorIds,
    linesPricedCount,
  );

  return {
    bidId,
    vendors,
    rows,
    vendorSummaries,
    suggestions: {
      cheapest,
      fewestVendors,
    },
  };
}

// -----------------------------------------------------------------------------
// Tiebreak
// -----------------------------------------------------------------------------

/**
 * Deterministic tiebreak: (most lines priced on this bid) then (alphabetical
 * case-insensitive vendor name). Vendor names are unique per company so the
 * alphabetical step always resolves any remaining tie. Returns null if the
 * input list is empty.
 */
function pickTiebreakWinner(
  vendorIds: string[],
  vendorById: Map<string, ComparisonVendor>,
  linesPricedCount: Map<string, number>,
): string | null {
  if (vendorIds.length === 0) return null;
  if (vendorIds.length === 1) return vendorIds[0] ?? null;

  const sorted = [...vendorIds].sort((a, b) => {
    const aCount = linesPricedCount.get(a) ?? 0;
    const bCount = linesPricedCount.get(b) ?? 0;
    if (aCount !== bCount) return bCount - aCount; // more lines wins
    const aName = (vendorById.get(a)?.vendorName ?? '').toLowerCase();
    const bName = (vendorById.get(b)?.vendorName ?? '').toLowerCase();
    if (aName !== bName) return aName < bName ? -1 : 1;
    // Shouldn't happen (names unique per company) but keep output stable.
    return a < b ? -1 : 1;
  });

  return sorted[0] ?? null;
}

// -----------------------------------------------------------------------------
// Suggested selections
// -----------------------------------------------------------------------------

function emptySuggestion(mode: 'cheapest' | 'fewest_vendors'): SuggestedSelection {
  return {
    mode,
    selections: {},
    vendorsInvolved: [],
    totalCost: 0,
    unresolvedLineItemIds: [],
  };
}

function buildCheapestSuggestion(
  rows: ComparisonRow[],
  vlByLineAndVendor: Map<string, Map<string, ComparisonVendorLine>>,
): SuggestedSelection {
  const selections: Record<string, string> = {};
  const vendorsInvolved = new Set<string>();
  const unresolvedLineItemIds: string[] = [];
  let totalCost = 0;

  for (const row of rows) {
    if (row.bestVendorId === null) {
      unresolvedLineItemIds.push(row.lineItemId);
      continue;
    }
    selections[row.lineItemId] = row.bestVendorId;
    vendorsInvolved.add(row.bestVendorId);
    const vl = vlByLineAndVendor.get(row.lineItemId)?.get(row.bestVendorId);
    if (vl && vl.totalPrice !== null && vl.totalPrice !== undefined) {
      totalCost += vl.totalPrice;
    }
  }

  return {
    mode: 'cheapest',
    selections,
    vendorsInvolved: [...vendorsInvolved].sort(),
    totalCost: round4(totalCost),
    unresolvedLineItemIds,
  };
}

type FewestVendorsCandidate = {
  vendorId: string;
  coveredLineIds: string[];
  coveredTotal: number;
};

function buildFewestVendorsSuggestion(
  sortedLines: ComparisonLineInput[],
  vendors: ComparisonVendor[],
  vlByLineAndVendor: Map<string, Map<string, ComparisonVendorLine>>,
  ineligibleVendorIds: Set<string>,
  linesPricedCount: Map<string, number>,
): SuggestedSelection {
  // Hoisted out of the while-loop below — the map doesn't change between
  // iterations, so rebuilding it each pass was pure overhead.
  const vendorById = new Map(vendors.map((v) => [v.vendorId, v] as const));

  // For each vendor, precompute { lineItemId -> (unitPrice, totalPrice) } for
  // only the lines they actually bid on (non-null unitPrice, live status).
  const coverage = new Map<string, Map<string, { unitPrice: number; totalPrice: number }>>();
  for (const vendor of vendors) {
    if (ineligibleVendorIds.has(vendor.vendorId)) continue;
    const m = new Map<string, { unitPrice: number; totalPrice: number }>();
    for (const line of sortedLines) {
      const vl = vlByLineAndVendor.get(line.lineItemId)?.get(vendor.vendorId);
      if (vl && vl.unitPrice !== null && vl.unitPrice !== undefined) {
        m.set(line.lineItemId, {
          unitPrice: vl.unitPrice,
          totalPrice: vl.totalPrice ?? 0,
        });
      }
    }
    if (m.size > 0) coverage.set(vendor.vendorId, m);
  }

  const unassigned = new Set(sortedLines.map((l) => l.lineItemId));
  const selections: Record<string, string> = {};
  const vendorsInvolved = new Set<string>();
  let totalCost = 0;

  // Iterate until every line is assigned or no vendor can cover more.
  while (unassigned.size > 0) {
    // For every candidate vendor with any coverage of still-unassigned lines,
    // count how many remaining lines they'd cover and the total cost for
    // that subset.
    const candidates: FewestVendorsCandidate[] = [];

    for (const [vendorId, lineMap] of coverage.entries()) {
      const coveredLineIds: string[] = [];
      let coveredTotal = 0;
      for (const lineId of unassigned) {
        const entry = lineMap.get(lineId);
        if (entry) {
          coveredLineIds.push(lineId);
          coveredTotal += entry.totalPrice;
        }
      }
      if (coveredLineIds.length > 0) {
        candidates.push({ vendorId, coveredLineIds, coveredTotal });
      }
    }

    if (candidates.length === 0) break;

    // Sort: most coverage wins; tie → lowest subset total cost; tie →
    // most lines priced across the whole bid; tie → alphabetical name.
    candidates.sort((a, b) => {
      if (a.coveredLineIds.length !== b.coveredLineIds.length) {
        return b.coveredLineIds.length - a.coveredLineIds.length;
      }
      if (a.coveredTotal !== b.coveredTotal) return a.coveredTotal - b.coveredTotal;
      const aCount = linesPricedCount.get(a.vendorId) ?? 0;
      const bCount = linesPricedCount.get(b.vendorId) ?? 0;
      if (aCount !== bCount) return bCount - aCount;
      const aName = (vendorById.get(a.vendorId)?.vendorName ?? '').toLowerCase();
      const bName = (vendorById.get(b.vendorId)?.vendorName ?? '').toLowerCase();
      if (aName !== bName) return aName < bName ? -1 : 1;
      return a.vendorId < b.vendorId ? -1 : 1;
    });

    const winner = candidates[0];
    if (!winner) break;

    for (const lineId of winner.coveredLineIds) {
      selections[lineId] = winner.vendorId;
      unassigned.delete(lineId);
      const entry = coverage.get(winner.vendorId)?.get(lineId);
      if (entry) totalCost += entry.totalPrice;
    }
    vendorsInvolved.add(winner.vendorId);
  }

  return {
    mode: 'fewest_vendors',
    selections,
    vendorsInvolved: [...vendorsInvolved].sort(),
    totalCost: round4(totalCost),
    unresolvedLineItemIds: [...unassigned].sort(),
  };
}
