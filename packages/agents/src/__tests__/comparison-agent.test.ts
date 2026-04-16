/**
 * Unit tests for comparison-agent (Prompt 06 Task 1).
 *
 * Purpose:  Lock the deterministic contract of the pure comparison engine.
 *           Covers empty input, best/worst/spread math, declined vendors,
 *           tie-break ordering, both suggestion modes, and stable ordering
 *           under shuffled input.
 * Agent/API: none — pure TypeScript assertions.
 * Imports:  vitest, ../comparison-agent.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { describe, expect, it } from 'vitest';

import {
  comparisonAgent,
  type ComparisonInput,
  type ComparisonLineInput,
  type ComparisonVendor,
  type ComparisonVendorLine,
} from '../comparison-agent';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function mkVendor(
  vendorId: string,
  vendorName: string,
  status: ComparisonVendor['status'] = 'submitted',
): ComparisonVendor {
  return {
    vendorId,
    vendorName,
    vendorBidId: `vb-${vendorId}`,
    status,
  };
}

function mkLine(
  lineItemId: string,
  sortOrder: number,
  overrides: Partial<ComparisonLineInput> = {},
): ComparisonLineInput {
  return {
    lineItemId,
    species: 'SPF',
    dimension: '2x4',
    grade: '#2',
    length: '8',
    quantity: 100,
    unit: 'PCS',
    buildingTag: null,
    phaseNumber: null,
    sortOrder,
    ...overrides,
  };
}

function mkVL(
  vendorBidLineItemId: string,
  vendorId: string,
  lineItemId: string,
  unitPrice: number | null,
  totalPrice: number | null = unitPrice === null ? null : unitPrice * 100,
): ComparisonVendorLine {
  return {
    vendorBidLineItemId,
    vendorBidId: `vb-${vendorId}`,
    vendorId,
    lineItemId,
    unitPrice,
    totalPrice,
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('comparisonAgent — empty input', () => {
  it('returns a valid, empty-shaped result', () => {
    const input: ComparisonInput = {
      bidId: 'bid-1',
      vendors: [],
      lines: [],
      vendorLines: [],
    };
    const out = comparisonAgent(input);
    expect(out.bidId).toBe('bid-1');
    expect(out.vendors).toEqual([]);
    expect(out.rows).toEqual([]);
    expect(out.vendorSummaries).toEqual([]);
    expect(out.suggestions.cheapest).toEqual({
      mode: 'cheapest',
      selections: {},
      vendorsInvolved: [],
      totalCost: 0,
      unresolvedLineItemIds: [],
    });
    expect(out.suggestions.fewestVendors).toEqual({
      mode: 'fewest_vendors',
      selections: {},
      vendorsInvolved: [],
      totalCost: 0,
      unresolvedLineItemIds: [],
    });
  });
});

describe('comparisonAgent — basic 3-vendor × 2-line matrix', () => {
  const vendors = [
    mkVendor('va', 'Alpha Mill'),
    mkVendor('vb', 'Beta Mill'),
    mkVendor('vc', 'Charlie Mill'),
  ];
  const lines = [mkLine('line-1', 0), mkLine('line-2', 1)];
  const vendorLines = [
    mkVL('vl-1', 'va', 'line-1', 500, 50_000),
    mkVL('vl-2', 'vb', 'line-1', 520, 52_000),
    mkVL('vl-3', 'vc', 'line-1', 510, 51_000),
    mkVL('vl-4', 'va', 'line-2', 800, 80_000),
    mkVL('vl-5', 'vb', 'line-2', 780, 78_000),
    // vc does not bid on line-2 (no-bid, not declined)
  ];

  const input: ComparisonInput = {
    bidId: 'bid-1',
    vendors,
    lines,
    vendorLines,
  };
  const out = comparisonAgent(input);

  it('computes best/worst and spread correctly', () => {
    const row1 = out.rows[0]!;
    expect(row1.bestUnitPrice).toBe(500);
    expect(row1.worstUnitPrice).toBe(520);
    expect(row1.spreadAmount).toBe(20);
    expect(row1.spreadPercent).toBe(round4(20 / 500));
    expect(row1.bidCount).toBe(3);
    expect(row1.bestVendorId).toBe('va');

    const row2 = out.rows[1]!;
    expect(row2.bestUnitPrice).toBe(780);
    expect(row2.worstUnitPrice).toBe(800);
    expect(row2.bidCount).toBe(2);
    expect(row2.bestVendorId).toBe('vb');
  });

  it('percentAboveBest is null for no-bid cells, correct for priced cells', () => {
    const row2 = out.rows[1]!;
    const cellVc = row2.cells.find((c) => c.vendorId === 'vc')!;
    expect(cellVc.unitPrice).toBeNull();
    expect(cellVc.percentAboveBest).toBeNull();

    const cellVa = row2.cells.find((c) => c.vendorId === 'va')!;
    expect(cellVa.percentAboveBest).toBe(round4((800 - 780) / 780));
  });

  it('preserves vendor column order from input', () => {
    const row1 = out.rows[0]!;
    expect(row1.cells.map((c) => c.vendorId)).toEqual(['va', 'vb', 'vc']);
  });

  it('suggestion `cheapest` picks best price per line', () => {
    const cheap = out.suggestions.cheapest;
    expect(cheap.selections).toEqual({
      'line-1': 'va',
      'line-2': 'vb',
    });
    expect(cheap.vendorsInvolved).toEqual(['va', 'vb']);
    // 50_000 (va on line-1) + 78_000 (vb on line-2) = 128_000
    expect(cheap.totalCost).toBe(128_000);
    expect(cheap.unresolvedLineItemIds).toEqual([]);
  });
});

describe('comparisonAgent — declined vendor', () => {
  const vendors = [
    mkVendor('va', 'Alpha'),
    mkVendor('vb', 'Beta', 'declined'),
    mkVendor('vc', 'Charlie'),
  ];
  const lines = [mkLine('line-1', 0)];
  const vendorLines = [
    mkVL('vl-1', 'va', 'line-1', 100, 10_000),
    // Beta has a row even though its vendor bid is declined — respect status.
    mkVL('vl-2', 'vb', 'line-1', 50, 5_000),
    mkVL('vl-3', 'vc', 'line-1', 110, 11_000),
  ];
  const out = comparisonAgent({ bidId: 'b', vendors, lines, vendorLines });

  it('declined vendor cells marked declined, not in best/worst', () => {
    const row = out.rows[0]!;
    const cellVb = row.cells.find((c) => c.vendorId === 'vb')!;
    expect(cellVb.declined).toBe(true);
    // Declined vendor's unitPrice collapses to null for matrix purposes.
    expect(cellVb.unitPrice).toBeNull();
    expect(cellVb.isBestPrice).toBe(false);

    expect(row.bestUnitPrice).toBe(100);
    expect(row.worstUnitPrice).toBe(110);
    expect(row.bestVendorId).toBe('va');
    expect(row.bidCount).toBe(2);
  });

  it('vendor summary reports linesDeclined correctly', () => {
    const vbSummary = out.vendorSummaries.find((s) => s.vendorId === 'vb')!;
    expect(vbSummary.linesDeclined).toBe(1);
    expect(vbSummary.linesPriced).toBe(0);
    expect(vbSummary.linesNoBid).toBe(0);
  });
});

describe('comparisonAgent — expired vendor (not-live)', () => {
  // Expired vendors must be excluded from ranking (their window has closed
  // and any stored unit_price is stale), but they must NOT be flagged as
  // declined — they simply render as no-price cells.
  const vendors = [
    mkVendor('va', 'Alpha'),
    mkVendor('vb', 'Beta', 'expired'),
    mkVendor('vc', 'Charlie'),
  ];
  const lines = [mkLine('line-1', 0)];
  const vendorLines = [
    mkVL('vl-1', 'va', 'line-1', 100, 10_000),
    // Beta has stale row data from before expiry — must be ignored.
    mkVL('vl-2', 'vb', 'line-1', 50, 5_000),
    mkVL('vl-3', 'vc', 'line-1', 110, 11_000),
  ];
  const out = comparisonAgent({ bidId: 'b', vendors, lines, vendorLines });

  it('expired vendor cell is null-priced with declined=false', () => {
    const row = out.rows[0]!;
    const cellVb = row.cells.find((c) => c.vendorId === 'vb')!;
    expect(cellVb.unitPrice).toBeNull();
    expect(cellVb.totalPrice).toBeNull();
    expect(cellVb.declined).toBe(false);
    expect(cellVb.isBestPrice).toBe(false);
    expect(cellVb.isWorstPrice).toBe(false);
  });

  it('expired vendor is excluded from best/worst/spread', () => {
    const row = out.rows[0]!;
    expect(row.bestUnitPrice).toBe(100);
    expect(row.worstUnitPrice).toBe(110);
    expect(row.bestVendorId).toBe('va');
    expect(row.bidCount).toBe(2);
  });

  it('expired vendor summary does not inflate linesDeclined', () => {
    const vbSummary = out.vendorSummaries.find((s) => s.vendorId === 'vb')!;
    expect(vbSummary.linesDeclined).toBe(0);
    expect(vbSummary.linesPriced).toBe(0);
    // Lines count as no-bid for coverage purposes.
    expect(vbSummary.linesNoBid).toBe(1);
  });
});

describe('comparisonAgent — pending vendor (not-live)', () => {
  // Pending = vendor hasn't responded yet. Same matrix rendering as expired.
  const vendors = [
    mkVendor('va', 'Alpha'),
    mkVendor('vb', 'Beta', 'pending'),
    mkVendor('vc', 'Charlie'),
  ];
  const lines = [mkLine('line-1', 0)];
  // Pending vendor would normally have NO row at all, but test the defensive
  // case where a stale row exists — it must still be excluded.
  const vendorLines = [
    mkVL('vl-1', 'va', 'line-1', 100, 10_000),
    mkVL('vl-2', 'vb', 'line-1', 50, 5_000),
    mkVL('vl-3', 'vc', 'line-1', 110, 11_000),
  ];
  const out = comparisonAgent({ bidId: 'b', vendors, lines, vendorLines });

  it('pending vendor cell is null-priced with declined=false', () => {
    const row = out.rows[0]!;
    const cellVb = row.cells.find((c) => c.vendorId === 'vb')!;
    expect(cellVb.unitPrice).toBeNull();
    expect(cellVb.totalPrice).toBeNull();
    expect(cellVb.declined).toBe(false);
    expect(cellVb.isBestPrice).toBe(false);
    expect(cellVb.isWorstPrice).toBe(false);
  });

  it('pending vendor is excluded from best/worst/spread', () => {
    const row = out.rows[0]!;
    expect(row.bestUnitPrice).toBe(100);
    expect(row.worstUnitPrice).toBe(110);
    expect(row.bestVendorId).toBe('va');
    expect(row.bidCount).toBe(2);
  });

  it('pending vendor summary does not inflate linesDeclined', () => {
    const vbSummary = out.vendorSummaries.find((s) => s.vendorId === 'vb')!;
    expect(vbSummary.linesDeclined).toBe(0);
    expect(vbSummary.linesPriced).toBe(0);
    expect(vbSummary.linesNoBid).toBe(1);
  });
});

describe('comparisonAgent — tiebreak by coverage then alphabetical', () => {
  it('more lines priced wins over fewer when prices are tied', () => {
    const vendors = [
      // Zeta is alphabetically last — must NOT win on alpha if coverage dominates.
      mkVendor('v1', 'Zeta'),
      mkVendor('v2', 'Alpha'),
    ];
    const lines = [mkLine('l1', 0), mkLine('l2', 1)];
    const vendorLines = [
      // Both tie at 100 on l1.
      mkVL('vl-1', 'v1', 'l1', 100, 10_000),
      mkVL('vl-2', 'v2', 'l1', 100, 10_000),
      // Only Zeta bids on l2 → Zeta has higher coverage.
      mkVL('vl-3', 'v1', 'l2', 200, 20_000),
    ];
    const out = comparisonAgent({ bidId: 'b', vendors, lines, vendorLines });
    expect(out.rows[0]!.bestVendorId).toBe('v1'); // Zeta wins on coverage
  });

  it('alphabetical breaks ties when coverage is equal', () => {
    const vendors = [mkVendor('v1', 'Zeta'), mkVendor('v2', 'Alpha')];
    const lines = [mkLine('l1', 0)];
    const vendorLines = [
      mkVL('vl-1', 'v1', 'l1', 100, 10_000),
      mkVL('vl-2', 'v2', 'l1', 100, 10_000),
    ];
    const out = comparisonAgent({ bidId: 'b', vendors, lines, vendorLines });
    expect(out.rows[0]!.bestVendorId).toBe('v2'); // Alpha < Zeta
  });

  it('alphabetical tiebreak is independent of input vendor order', () => {
    // Run the same scenario with the vendor list reversed to confirm that
    // Alpha wins regardless of insertion order. If the tiebreaker ever
    // accidentally depends on vendor column order, this test fails.
    const lines = [mkLine('l1', 0)];
    const mkVendorLines = (alphaId: string, zetaId: string) => [
      mkVL('vl-1', zetaId, 'l1', 100, 10_000),
      mkVL('vl-2', alphaId, 'l1', 100, 10_000),
    ];

    // Order 1: [Zeta, Alpha]
    const order1 = comparisonAgent({
      bidId: 'b',
      vendors: [mkVendor('vZ', 'Zeta'), mkVendor('vA', 'Alpha')],
      lines,
      vendorLines: mkVendorLines('vA', 'vZ'),
    });
    expect(order1.rows[0]!.bestVendorId).toBe('vA');

    // Order 2: [Alpha, Zeta]
    const order2 = comparisonAgent({
      bidId: 'b',
      vendors: [mkVendor('vA', 'Alpha'), mkVendor('vZ', 'Zeta')],
      lines,
      vendorLines: mkVendorLines('vA', 'vZ'),
    });
    expect(order2.rows[0]!.bestVendorId).toBe('vA');
  });

  it('alphabetical tiebreak is case-insensitive', () => {
    const vendors = [mkVendor('v1', 'bravo'), mkVendor('v2', 'Alpha')];
    const lines = [mkLine('l1', 0)];
    const vendorLines = [
      mkVL('vl-1', 'v1', 'l1', 100, 10_000),
      mkVL('vl-2', 'v2', 'l1', 100, 10_000),
    ];
    const out = comparisonAgent({ bidId: 'b', vendors, lines, vendorLines });
    expect(out.rows[0]!.bestVendorId).toBe('v2'); // Alpha < bravo (lowercased)
  });
});

describe('comparisonAgent — fewestVendors greedy set-cover', () => {
  it('picks the single vendor that covers the most unassigned lines', () => {
    const vendors = [
      mkVendor('v1', 'Alpha'),
      mkVendor('v2', 'Beta'),
      mkVendor('v3', 'Gamma'),
    ];
    const lines = [mkLine('l1', 0), mkLine('l2', 1), mkLine('l3', 2)];
    // Alpha covers l1+l2+l3 — clear single winner.
    // Beta covers l1 only. Gamma covers l2 only.
    const vendorLines = [
      mkVL('a1', 'v1', 'l1', 10, 1000),
      mkVL('a2', 'v1', 'l2', 20, 2000),
      mkVL('a3', 'v1', 'l3', 30, 3000),
      mkVL('b1', 'v2', 'l1', 5, 500),
      mkVL('g1', 'v3', 'l2', 15, 1500),
    ];
    const out = comparisonAgent({ bidId: 'b', vendors, lines, vendorLines });
    const few = out.suggestions.fewestVendors;
    expect(few.vendorsInvolved).toEqual(['v1']);
    expect(Object.values(few.selections).every((v) => v === 'v1')).toBe(true);
    expect(few.unresolvedLineItemIds).toEqual([]);
    expect(few.totalCost).toBe(6000);
  });

  it('handles lines no vendor bids on via unresolvedLineItemIds', () => {
    const vendors = [mkVendor('v1', 'Alpha')];
    const lines = [mkLine('l1', 0), mkLine('l2', 1)];
    const vendorLines = [mkVL('a1', 'v1', 'l1', 10, 1000)];
    const out = comparisonAgent({ bidId: 'b', vendors, lines, vendorLines });
    expect(out.suggestions.fewestVendors.unresolvedLineItemIds).toEqual(['l2']);
    expect(out.suggestions.cheapest.unresolvedLineItemIds).toEqual(['l2']);
  });

  it('greedy with equal coverage breaks ties by lowest subset cost', () => {
    const vendors = [mkVendor('v1', 'Zeta'), mkVendor('v2', 'Alpha')];
    const lines = [mkLine('l1', 0), mkLine('l2', 1)];
    // Both cover both lines; Zeta is cheaper in total.
    const vendorLines = [
      mkVL('z1', 'v1', 'l1', 5, 500),
      mkVL('z2', 'v1', 'l2', 5, 500),
      mkVL('a1', 'v2', 'l1', 10, 1000),
      mkVL('a2', 'v2', 'l2', 10, 1000),
    ];
    const out = comparisonAgent({ bidId: 'b', vendors, lines, vendorLines });
    // Lowest subset cost wins (Zeta @ 1000 < Alpha @ 2000).
    expect(out.suggestions.fewestVendors.vendorsInvolved).toEqual(['v1']);
  });
});

describe('comparisonAgent — determinism', () => {
  it('same input returns JSON-equal output twice', () => {
    const vendors = [mkVendor('v1', 'A'), mkVendor('v2', 'B')];
    const lines = [mkLine('l1', 0), mkLine('l2', 1)];
    const vendorLines = [
      mkVL('x1', 'v1', 'l1', 10, 1000),
      mkVL('x2', 'v2', 'l2', 20, 2000),
    ];
    const input: ComparisonInput = { bidId: 'b', vendors, lines, vendorLines };
    const a = comparisonAgent(input);
    const b = comparisonAgent(input);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('shuffled vendorLines still produces stably ordered rows', () => {
    const vendors = [mkVendor('v1', 'A'), mkVendor('v2', 'B')];
    // sort_order 2,1,0 — forces the agent to actually sort.
    const lines = [
      mkLine('lc', 2, { buildingTag: 'C' }),
      mkLine('lb', 1, { buildingTag: 'B' }),
      mkLine('la', 0, { buildingTag: 'A' }),
    ];
    const vendorLinesOrdered = [
      mkVL('x1', 'v1', 'la', 10, 1000),
      mkVL('x2', 'v2', 'la', 11, 1100),
      mkVL('x3', 'v1', 'lb', 20, 2000),
      mkVL('x4', 'v2', 'lb', 21, 2100),
      mkVL('x5', 'v1', 'lc', 30, 3000),
      mkVL('x6', 'v2', 'lc', 31, 3100),
    ];
    const shuffled = [...vendorLinesOrdered].reverse();

    const ordered = comparisonAgent({
      bidId: 'b',
      vendors,
      lines,
      vendorLines: vendorLinesOrdered,
    });
    const reshuffled = comparisonAgent({
      bidId: 'b',
      vendors,
      lines,
      vendorLines: shuffled,
    });

    expect(ordered.rows.map((r) => r.lineItemId)).toEqual(['la', 'lb', 'lc']);
    expect(reshuffled.rows.map((r) => r.lineItemId)).toEqual(['la', 'lb', 'lc']);
    expect(JSON.stringify(ordered)).toEqual(JSON.stringify(reshuffled));
  });
});

describe('comparisonAgent — vendor summary math', () => {
  it('reports linesPriced, linesNoBid, and response coverage', () => {
    const vendors = [mkVendor('v1', 'A'), mkVendor('v2', 'B')];
    const lines = [mkLine('l1', 0), mkLine('l2', 1), mkLine('l3', 2), mkLine('l4', 3)];
    const vendorLines = [
      mkVL('x1', 'v1', 'l1', 10, 1000),
      mkVL('x2', 'v1', 'l2', 20, 2000),
      mkVL('x3', 'v1', 'l3', 30, 3000),
      // v1 no-bid on l4
      mkVL('x4', 'v2', 'l1', 11, 1100),
      // v2 no-bid on l2, l3, l4
    ];
    const out = comparisonAgent({ bidId: 'b', vendors, lines, vendorLines });
    const s1 = out.vendorSummaries.find((s) => s.vendorId === 'v1')!;
    const s2 = out.vendorSummaries.find((s) => s.vendorId === 'v2')!;
    expect(s1.linesPriced).toBe(3);
    expect(s1.linesNoBid).toBe(1);
    expect(s1.responseCoveragePercent).toBe(0.75);
    expect(s1.totalIfAllSelected).toBe(6000);

    expect(s2.linesPriced).toBe(1);
    expect(s2.linesNoBid).toBe(3);
    expect(s2.responseCoveragePercent).toBe(0.25);
    expect(s2.totalIfAllSelected).toBe(1100);
  });
});

describe('comparisonAgent — input validation', () => {
  it('throws on malformed input (missing bidId)', () => {
    // Cast through unknown because we're deliberately violating the type.
    const bad = {
      vendors: [],
      lines: [],
      vendorLines: [],
    } as unknown as ComparisonInput;
    expect(() => comparisonAgent(bad)).toThrow();
  });

  it('throws on invalid unit enum value', () => {
    const bad = {
      bidId: 'b',
      vendors: [],
      lines: [
        {
          lineItemId: 'l1',
          species: 'SPF',
          dimension: '2x4',
          grade: '#2',
          length: '8',
          quantity: 100,
          // 'LF' is not a legal unit — must be PCS | MBF | MSF.
          unit: 'LF',
          buildingTag: null,
          phaseNumber: null,
          sortOrder: 0,
        },
      ],
      vendorLines: [],
    } as unknown as ComparisonInput;
    expect(() => comparisonAgent(bad)).toThrow();
  });
});

// Local helper mirror of the agent's round4 — tests are allowed to know
// the contract (4 decimals) since it's part of the agent's documented API.
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
