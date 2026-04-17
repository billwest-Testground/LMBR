/**
 * Unit tests for @lmbr/lib/pdf-quote (Prompt 07 Task 1).
 *
 * Purpose:  Verify the customer-facing quote input builder produces the
 *           correct section layout for each of the four consolidation
 *           modes. The critical invariant: hybrid mode yields the SAME
 *           customer-facing shape as structured mode (vendors see the
 *           aggregated tally; the PDF never does). Also type-level checks
 *           that QuotePdfInput has no vendor / cost / margin fields.
 * Agent/API: none — pure TS.
 * Imports:  vitest, ../pdf-quote.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  buildQuotePdfInput,
  type BuildQuotePdfInputArgs,
  type PdfPricedLineInput,
  type QuotePdfInput,
} from '../pdf-quote';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function mkPriced(
  lineItemId: string,
  overrides: Partial<PdfPricedLineInput> = {},
): PdfPricedLineInput {
  return {
    lineItemId,
    sortOrder: 0,
    buildingTag: null,
    phaseNumber: null,
    species: 'SPF',
    dimension: '2x4',
    grade: '#2',
    length: '8',
    quantity: 100,
    unit: 'PCS',
    sellUnitPrice: 5,
    extendedSell: 500,
    ...overrides,
  };
}

function baseArgs(
  overrides: Partial<BuildQuotePdfInputArgs> = {},
): BuildQuotePdfInputArgs {
  return {
    pricedLines: [],
    totals: { lumberTax: 0, salesTax: 0, grandTotal: 0 },
    bid: {
      customerName: 'Acme Construction',
      jobName: 'Test Job',
      jobAddress: '100 Main St',
      jobState: 'NC',
      consolidationMode: 'structured',
    },
    company: { name: 'LMBR Supply', slug: 'lmbr', emailDomain: 'lmbr.ai' },
    timezone: null,
    quoteNumber: 'LMBR-01001',
    quoteDate: new Date('2026-04-15T12:00:00Z'),
    validUntil: new Date('2026-04-22T12:00:00Z'),
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Consolidation-mode tests
// -----------------------------------------------------------------------------

describe('buildQuotePdfInput — structured mode', () => {
  it('groups lines by buildingTag + phaseNumber', () => {
    const pricedLines: PdfPricedLineInput[] = [
      mkPriced('li-1', { buildingTag: 'Building A', phaseNumber: null }),
      mkPriced('li-2', { buildingTag: 'Building A', phaseNumber: null, sortOrder: 1 }),
      mkPriced('li-3', { buildingTag: 'Building B', phaseNumber: 2, sortOrder: 2 }),
    ];
    const result = buildQuotePdfInput(
      baseArgs({
        pricedLines,
        bid: { ...baseArgs().bid, consolidationMode: 'structured' },
      }),
    );
    expect(result.sections).toHaveLength(2);
    const a = result.sections.find((s) => s.heading === 'Building A')!;
    expect(a.lines).toHaveLength(2);
    expect(a.subtotal).toBe(1000);
    const b = result.sections.find((s) => s.heading === 'Building B · Phase 2')!;
    expect(b.lines).toHaveLength(1);
    expect(b.subtotal).toBe(500);
  });
});

describe('buildQuotePdfInput — consolidated mode', () => {
  it('returns a single section with heading=null and aggregates like items', () => {
    const pricedLines: PdfPricedLineInput[] = [
      mkPriced('li-1', {
        buildingTag: 'A',
        quantity: 100,
        sellUnitPrice: 5,
        extendedSell: 500,
      }),
      mkPriced('li-2', {
        buildingTag: 'B',
        quantity: 50,
        sellUnitPrice: 5,
        extendedSell: 250,
      }),
    ];
    const result = buildQuotePdfInput(
      baseArgs({
        pricedLines,
        bid: { ...baseArgs().bid, consolidationMode: 'consolidated' },
      }),
    );
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.heading).toBeNull();
    expect(result.sections[0]!.lines).toHaveLength(1); // aggregated
    expect(result.sections[0]!.lines[0]!.quantity).toBe(150);
    expect(result.sections[0]!.lines[0]!.extendedPrice).toBe(750);
    expect(result.sections[0]!.lines[0]!.unitPrice).toBe(5);
  });
});

describe('buildQuotePdfInput — phased mode', () => {
  it('groups by phaseNumber with Unphased last', () => {
    const pricedLines: PdfPricedLineInput[] = [
      mkPriced('li-1', { phaseNumber: 2 }),
      mkPriced('li-2', { phaseNumber: 1, sortOrder: 1 }),
      mkPriced('li-3', { phaseNumber: null, sortOrder: 2 }),
    ];
    const result = buildQuotePdfInput(
      baseArgs({
        pricedLines,
        bid: { ...baseArgs().bid, consolidationMode: 'phased' },
      }),
    );
    expect(result.sections.map((s) => s.heading)).toEqual([
      'Phase 1',
      'Phase 2',
      'Unphased',
    ]);
  });
});

describe('buildQuotePdfInput — hybrid mode', () => {
  it('produces the SAME customer-facing sections as structured mode', () => {
    const pricedLines: PdfPricedLineInput[] = [
      mkPriced('li-1', { buildingTag: 'Building A', phaseNumber: 1 }),
      mkPriced('li-2', { buildingTag: 'Building A', phaseNumber: 2, sortOrder: 1 }),
      mkPriced('li-3', { buildingTag: 'Building B', phaseNumber: null, sortOrder: 2 }),
    ];

    const structured = buildQuotePdfInput(
      baseArgs({
        pricedLines,
        bid: { ...baseArgs().bid, consolidationMode: 'structured' },
      }),
    );
    const hybrid = buildQuotePdfInput(
      baseArgs({
        pricedLines,
        bid: { ...baseArgs().bid, consolidationMode: 'hybrid' },
      }),
    );

    // Sections must be byte-for-byte identical apart from the top-level
    // consolidationMode field. This proves the invariant: hybrid's
    // customer-facing PDF is structured; the vendor-facing consolidated
    // view never reaches the PDF layer.
    expect(hybrid.sections).toEqual(structured.sections);
    expect(hybrid.subtotal).toBe(structured.subtotal);
  });
});

describe('buildQuotePdfInput — edge cases', () => {
  it('filters out zero-priced (unresolved) lines', () => {
    const pricedLines: PdfPricedLineInput[] = [
      mkPriced('li-1'),
      mkPriced('li-2', { extendedSell: 0, sellUnitPrice: 0 }),
    ];
    const result = buildQuotePdfInput(baseArgs({ pricedLines }));
    expect(
      result.sections.reduce((sum, s) => sum + s.lines.length, 0),
    ).toBe(1);
  });

  it('uses "General" heading when neither building nor phase is set', () => {
    const pricedLines: PdfPricedLineInput[] = [mkPriced('li-1')];
    const result = buildQuotePdfInput(
      baseArgs({
        pricedLines,
        bid: { ...baseArgs().bid, consolidationMode: 'structured' },
      }),
    );
    expect(result.sections[0]!.heading).toBe('General');
  });

  it('passes taxes and totals through unchanged', () => {
    const pricedLines: PdfPricedLineInput[] = [mkPriced('li-1')];
    const result = buildQuotePdfInput(
      baseArgs({
        pricedLines,
        totals: { lumberTax: 5, salesTax: 36.25, grandTotal: 541.25 },
      }),
    );
    expect(result.lumberTax).toBe(5);
    expect(result.salesTax).toBe(36.25);
    expect(result.grandTotal).toBe(541.25);
  });
});

// -----------------------------------------------------------------------------
// Type-level invariants — QuotePdfInput must be vendor/cost/margin-free
// -----------------------------------------------------------------------------

describe('QuotePdfInput type shape', () => {
  it('has no vendor, cost, or margin fields (type-level)', () => {
    // These checks fail at type-check time if someone adds forbidden
    // fields to QuotePdfInput.
    expectTypeOf<QuotePdfInput>().not.toHaveProperty('vendorId');
    expectTypeOf<QuotePdfInput>().not.toHaveProperty('vendorName');
    expectTypeOf<QuotePdfInput>().not.toHaveProperty('costPrice');
    expectTypeOf<QuotePdfInput>().not.toHaveProperty('marginPercent');
    expectTypeOf<QuotePdfInput>().not.toHaveProperty('marginDollars');
  });

  it('PdfPricedLineInput has no vendor, cost, or margin fields (type-level)', () => {
    // The input shape the /api/quote route builds from quote_line_items
    // is also vendor-/cost-/margin-free by contract. These assertions
    // make sure a future refactor can't leak internal fields into a
    // customer-facing projection.
    expectTypeOf<PdfPricedLineInput>().not.toHaveProperty('vendorId');
    expectTypeOf<PdfPricedLineInput>().not.toHaveProperty('costUnitPrice');
    expectTypeOf<PdfPricedLineInput>().not.toHaveProperty('costTotalPrice');
    expectTypeOf<PdfPricedLineInput>().not.toHaveProperty('marginPercent');
  });
});
