/**
 * Unit tests for pricing-agent (Prompt 07 Task 1).
 *
 * Purpose:  Lock the deterministic contract of the margin-stack engine.
 *           Covers empty input, percent and dollar modes, scope hierarchy
 *           (all / commodity / line), last-write-wins resolution, approval
 *           and min-margin flags, CA + non-CA tax math, unresolved lines,
 *           Zod validation at the function boundary.
 * Agent/API: none — pure TS.
 * Imports:  vitest, ../pricing-agent.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { describe, expect, it } from 'vitest';

import {
  pricingAgent,
  PricingInputSchema,
  type MarginInstruction,
  type PricingInput,
  type PricingLineInput,
  type PricingSelection,
} from '../pricing-agent';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function mkLine(
  lineItemId: string,
  sortOrder: number,
  overrides: Partial<PricingLineInput> = {},
): PricingLineInput {
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

function mkSelection(
  lineItemId: string,
  costUnitPrice: number,
  overrides: Partial<PricingSelection> = {},
): PricingSelection {
  return {
    lineItemId,
    vendorBidLineItemId: `vbli-${lineItemId}`,
    vendorId: `vendor-1`,
    costUnitPrice,
    costTotalPrice: costUnitPrice * 100,
    ...overrides,
  };
}

function baseInput(overrides: Partial<PricingInput> = {}): PricingInput {
  return {
    bidId: 'bid-1',
    jobState: null,
    consolidationMode: 'structured',
    lines: [],
    selections: [],
    marginInstructions: [],
    settings: {
      approvalThresholdDollars: 50_000,
      minMarginPercent: 0.05,
    },
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('pricingAgent — basic shape', () => {
  it('returns a valid empty result for empty input', () => {
    const result = pricingAgent(baseInput());
    expect(result.bidId).toBe('bid-1');
    expect(result.lines).toHaveLength(0);
    expect(result.totals.totalCost).toBe(0);
    expect(result.totals.totalSell).toBe(0);
    expect(result.totals.blendedMarginPercent).toBe(0);
    expect(result.totals.grandTotal).toBe(0);
    expect(result.flags.needsApproval).toBe(false);
    expect(result.flags.belowMinimumMargin).toBe(true); // 0 < 0.05
    expect(result.flags.unresolvedLineItemIds).toHaveLength(0);
    expect(result.taxJurisdiction.state).toBeNull();
    expect(result.taxJurisdiction.lumberRate).toBe(0);
    expect(result.taxJurisdiction.salesRate).toBe(0);
  });
});

describe('pricingAgent — percent margin', () => {
  it('applies a 10% markup to a single line', () => {
    const line = mkLine('li-1', 0);
    const sel = mkSelection('li-1', 10); // cost $10/PCS × 100 qty
    const instructions: MarginInstruction[] = [
      { scope: 'all', targetId: null, marginType: 'percent', marginValue: 0.1 },
    ];
    const result = pricingAgent(
      baseInput({
        lines: [line],
        selections: [sel],
        marginInstructions: instructions,
      }),
    );
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.sellUnitPrice).toBe(11); // 10 * 1.10
    expect(result.lines[0]!.marginPercent).toBe(0.1);
    expect(result.lines[0]!.extendedSell).toBe(1100);
    expect(result.lines[0]!.appliedInstructionIndex).toBe(0);
    expect(result.totals.totalCost).toBe(1000);
    expect(result.totals.totalSell).toBe(1100);
    expect(result.totals.marginDollars).toBe(100);
    expect(result.totals.blendedMarginPercent).toBeCloseTo(100 / 1100, 4);
  });
});

describe('pricingAgent — dollar margin', () => {
  it('adds a flat dollar amount per unit', () => {
    const line = mkLine('li-1', 0);
    const sel = mkSelection('li-1', 10);
    const result = pricingAgent(
      baseInput({
        lines: [line],
        selections: [sel],
        marginInstructions: [
          { scope: 'all', targetId: null, marginType: 'dollar', marginValue: 2.5 },
        ],
      }),
    );
    expect(result.lines[0]!.sellUnitPrice).toBe(12.5);
    expect(result.lines[0]!.marginPercent).toBeCloseTo(0.25, 4);
    expect(result.lines[0]!.extendedSell).toBe(1250);
  });

  it('coerces effective percent to 0 for zero-cost line + dollar margin', () => {
    const line = mkLine('li-1', 0);
    const sel = mkSelection('li-1', 0);
    const result = pricingAgent(
      baseInput({
        lines: [line],
        selections: [sel],
        marginInstructions: [
          { scope: 'all', targetId: null, marginType: 'dollar', marginValue: 1 },
        ],
      }),
    );
    expect(result.lines[0]!.sellUnitPrice).toBe(1);
    expect(result.lines[0]!.marginPercent).toBe(0);
    expect(result.flags.warnings.some((w) => w.includes('zero-cost'))).toBe(true);
  });
});

describe('pricingAgent — scope hierarchy', () => {
  it('applies commodity-scoped margin only to matching group', () => {
    const lines = [
      mkLine('li-spf', 0, { species: 'SPF' }), // Dimensional
      mkLine('li-cedar', 1, { species: 'Cedar' }),
    ];
    const selections = [mkSelection('li-spf', 10), mkSelection('li-cedar', 20)];
    const result = pricingAgent(
      baseInput({
        lines,
        selections,
        marginInstructions: [
          {
            scope: 'commodity',
            targetId: 'Dimensional',
            marginType: 'percent',
            marginValue: 0.2,
          },
        ],
      }),
    );
    // SPF (Dimensional) — 20% applied
    const spf = result.lines.find((l) => l.lineItemId === 'li-spf')!;
    expect(spf.sellUnitPrice).toBe(12);
    expect(spf.marginPercent).toBe(0.2);
    expect(spf.appliedInstructionIndex).toBe(0);
    // Cedar — no match, sell = cost
    const cedar = result.lines.find((l) => l.lineItemId === 'li-cedar')!;
    expect(cedar.sellUnitPrice).toBe(20);
    expect(cedar.marginPercent).toBe(0);
    expect(cedar.appliedInstructionIndex).toBe(-1);
  });

  it('last-write-wins: all → commodity → line override stack', () => {
    const lines = [
      mkLine('li-a', 0, { species: 'SPF' }), // Dimensional
      mkLine('li-b', 1, { species: 'SPF' }), // Dimensional
      mkLine('li-c', 2, { species: 'Cedar' }),
    ];
    const selections = [
      mkSelection('li-a', 10),
      mkSelection('li-b', 10),
      mkSelection('li-c', 10),
    ];
    const instructions: MarginInstruction[] = [
      { scope: 'all', targetId: null, marginType: 'percent', marginValue: 0.08 },
      {
        scope: 'commodity',
        targetId: 'Dimensional',
        marginType: 'percent',
        marginValue: 0.12,
      },
      { scope: 'line', targetId: 'li-a', marginType: 'percent', marginValue: 0.15 },
    ];
    const result = pricingAgent(
      baseInput({ lines, selections, marginInstructions: instructions }),
    );
    const a = result.lines.find((l) => l.lineItemId === 'li-a')!;
    const b = result.lines.find((l) => l.lineItemId === 'li-b')!;
    const c = result.lines.find((l) => l.lineItemId === 'li-c')!;
    expect(a.marginPercent).toBe(0.15); // line override wins
    expect(a.appliedInstructionIndex).toBe(2);
    expect(b.marginPercent).toBe(0.12); // commodity wins
    expect(b.appliedInstructionIndex).toBe(1);
    expect(c.marginPercent).toBe(0.08); // all wins
    expect(c.appliedInstructionIndex).toBe(0);
  });
});

describe('pricingAgent — approval gate', () => {
  it('needsApproval true when grandTotal > threshold', () => {
    const line = mkLine('li-1', 0, { quantity: 10_000 });
    const sel = mkSelection('li-1', 10); // sell = 10k × $10 × 1.10 = $110,000
    sel.costTotalPrice = 100_000; // align cost totals
    const result = pricingAgent(
      baseInput({
        lines: [line],
        selections: [sel],
        marginInstructions: [
          { scope: 'all', targetId: null, marginType: 'percent', marginValue: 0.1 },
        ],
        settings: { approvalThresholdDollars: 50_000, minMarginPercent: 0.05 },
      }),
    );
    expect(result.totals.grandTotal).toBe(110_000);
    expect(result.flags.needsApproval).toBe(true);
  });

  it('needsApproval false when grandTotal equals threshold', () => {
    const line = mkLine('li-1', 0);
    const sel = mkSelection('li-1', 10);
    const result = pricingAgent(
      baseInput({
        lines: [line],
        selections: [sel],
        marginInstructions: [
          { scope: 'all', targetId: null, marginType: 'percent', marginValue: 0 },
        ],
        settings: { approvalThresholdDollars: 1000, minMarginPercent: 0 },
      }),
    );
    expect(result.totals.grandTotal).toBe(1000);
    expect(result.flags.needsApproval).toBe(false);
  });

  it('belowMinimumMargin fires when blended margin < floor', () => {
    const line = mkLine('li-1', 0);
    const sel = mkSelection('li-1', 10);
    const result = pricingAgent(
      baseInput({
        lines: [line],
        selections: [sel],
        marginInstructions: [
          { scope: 'all', targetId: null, marginType: 'percent', marginValue: 0.02 },
        ],
        settings: { approvalThresholdDollars: 50_000, minMarginPercent: 0.05 },
      }),
    );
    // blended = 0.02 / 1.02 ≈ 0.0196 → below floor 0.05
    expect(result.flags.belowMinimumMargin).toBe(true);
  });
});

describe('pricingAgent — tax math', () => {
  it('CA jobState applies both lumber assessment + state sales tax', () => {
    const line = mkLine('li-1', 0);
    const sel = mkSelection('li-1', 10);
    const result = pricingAgent(
      baseInput({
        jobState: 'CA',
        lines: [line],
        selections: [sel],
        marginInstructions: [
          { scope: 'all', targetId: null, marginType: 'percent', marginValue: 0.1 },
        ],
      }),
    );
    expect(result.taxJurisdiction.state).toBe('CA');
    expect(result.taxJurisdiction.lumberRate).toBeGreaterThan(0);
    expect(result.taxJurisdiction.salesRate).toBeGreaterThan(0);
    expect(result.totals.lumberTax).toBeCloseTo(1100 * 0.01, 2); // $11
    expect(result.totals.salesTax).toBeCloseTo(1100 * 0.0725, 2); // ~$79.75
    expect(result.totals.grandTotal).toBeCloseTo(1100 + 11 + 79.75, 2);
  });

  it('TX jobState applies sales tax but NOT lumber assessment', () => {
    const line = mkLine('li-1', 0);
    const sel = mkSelection('li-1', 10);
    const result = pricingAgent(
      baseInput({
        jobState: 'TX',
        lines: [line],
        selections: [sel],
        marginInstructions: [
          { scope: 'all', targetId: null, marginType: 'percent', marginValue: 0.1 },
        ],
      }),
    );
    expect(result.taxJurisdiction.state).toBe('TX');
    expect(result.taxJurisdiction.lumberRate).toBe(0);
    expect(result.totals.lumberTax).toBe(0);
    expect(result.totals.salesTax).toBeGreaterThan(0);
  });

  it('null jobState yields zero tax', () => {
    const line = mkLine('li-1', 0);
    const sel = mkSelection('li-1', 10);
    const result = pricingAgent(
      baseInput({
        jobState: null,
        lines: [line],
        selections: [sel],
        marginInstructions: [
          { scope: 'all', targetId: null, marginType: 'percent', marginValue: 0.1 },
        ],
      }),
    );
    expect(result.taxJurisdiction.state).toBeNull();
    expect(result.totals.lumberTax).toBe(0);
    expect(result.totals.salesTax).toBe(0);
    expect(result.totals.grandTotal).toBe(1100);
  });
});

describe('pricingAgent — no instruction match', () => {
  it('emits warning and sets appliedInstructionIndex=-1 when no instruction matches a line', () => {
    // 1 SPF line; the margin instruction targets commodity 'Cedar' → no match.
    // Expected: line carries 0% margin, appliedInstructionIndex === -1,
    // and flags.warnings references the unmatched line id.
    const line = mkLine('li-spf-1', 0, { species: 'SPF' });
    const sel = mkSelection('li-spf-1', 10);
    const result = pricingAgent(
      baseInput({
        lines: [line],
        selections: [sel],
        marginInstructions: [
          {
            scope: 'commodity',
            targetId: 'Cedar',
            marginType: 'percent',
            marginValue: 0.2,
          },
        ],
      }),
    );
    const priced = result.lines.find((l) => l.lineItemId === 'li-spf-1')!;
    expect(priced.marginPercent).toBe(0);
    expect(priced.appliedInstructionIndex).toBe(-1);
    // sell falls back to cost when no instruction matched
    expect(priced.sellUnitPrice).toBe(10);
    expect(
      result.flags.warnings.some((w) => w.includes('li-spf-1')),
    ).toBe(true);
  });
});

describe('pricingAgent — unresolved lines', () => {
  it('excludes unresolved lines from totals but surfaces them on the result', () => {
    const lines = [mkLine('li-1', 0), mkLine('li-2', 1)];
    const selections = [mkSelection('li-1', 10)]; // li-2 is unresolved
    const result = pricingAgent(
      baseInput({
        lines,
        selections,
        marginInstructions: [
          { scope: 'all', targetId: null, marginType: 'percent', marginValue: 0.1 },
        ],
      }),
    );
    expect(result.lines).toHaveLength(2);
    const unresolved = result.lines.find((l) => l.lineItemId === 'li-2')!;
    expect(unresolved.vendorBidLineItemId).toBe('');
    expect(unresolved.costTotalPrice).toBe(0);
    expect(unresolved.extendedSell).toBe(0);
    expect(result.totals.totalCost).toBe(1000); // only li-1 counted
    expect(result.totals.totalSell).toBe(1100);
    expect(result.flags.unresolvedLineItemIds).toEqual(['li-2']);
  });
});

describe('pricingAgent — determinism', () => {
  it('produces identical output for identical input across runs', () => {
    const lines = [
      mkLine('li-a', 2, { buildingTag: 'B', species: 'SPF' }),
      mkLine('li-b', 1, { buildingTag: 'A', species: 'Cedar' }),
      mkLine('li-c', 0, { buildingTag: 'A', species: 'SPF' }),
    ];
    const selections = [
      mkSelection('li-a', 10),
      mkSelection('li-b', 15),
      mkSelection('li-c', 8),
    ];
    const input = baseInput({
      jobState: 'CA',
      lines,
      selections,
      marginInstructions: [
        { scope: 'all', targetId: null, marginType: 'percent', marginValue: 0.1 },
        {
          scope: 'commodity',
          targetId: 'Dimensional',
          marginType: 'percent',
          marginValue: 0.15,
        },
      ],
    });
    const r1 = pricingAgent(input);
    const r2 = pricingAgent(input);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('sorts lines by (sortOrder, buildingTag, lineItemId)', () => {
    const lines = [
      mkLine('li-z', 2, { buildingTag: 'A' }),
      mkLine('li-a', 0, { buildingTag: 'B' }),
      mkLine('li-m', 0, { buildingTag: 'A' }),
    ];
    const selections = lines.map((l) => mkSelection(l.lineItemId, 10));
    const result = pricingAgent(
      baseInput({
        lines,
        selections,
        marginInstructions: [
          { scope: 'all', targetId: null, marginType: 'percent', marginValue: 0 },
        ],
      }),
    );
    // sortOrder 0 comes first — tiebreak buildingTag: A < B
    expect(result.lines.map((l) => l.lineItemId)).toEqual([
      'li-m', // sortOrder 0, buildingTag A
      'li-a', // sortOrder 0, buildingTag B
      'li-z', // sortOrder 2
    ]);
  });
});

describe('PricingInputSchema', () => {
  it('throws on malformed input', () => {
    expect(() =>
      pricingAgent({
        // @ts-expect-error deliberate shape violation
        bidId: 123,
      }),
    ).toThrow();
  });

  it('accepts well-formed input via the exported schema', () => {
    const parsed = PricingInputSchema.safeParse(baseInput());
    expect(parsed.success).toBe(true);
  });
});
