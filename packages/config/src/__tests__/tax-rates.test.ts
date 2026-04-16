/**
 * Unit tests for @lmbr/config/tax-rates.
 *
 * Purpose:  Lock down the quiet-fallback contract for getStateSalesTax and
 *           the non-negative / non-finite guards on getCaLumberAssessment.
 *           These resolvers drive /api/margin and /api/quote money math —
 *           a silent NaN here becomes a wrong total on the PDF.
 * Agent/API: none — pure TS.
 * Imports:  vitest, ../tax-rates.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { describe, expect, it } from 'vitest';

import {
  CA_LUMBER_ASSESSMENT,
  STATE_SALES_TAX,
  getCaLumberAssessment,
  getStateSalesTax,
} from '../tax-rates';

describe('getStateSalesTax', () => {
  it('resolves a known state code', () => {
    expect(getStateSalesTax('CA')).toBe(STATE_SALES_TAX.CA);
    expect(getStateSalesTax('TX')).toBe(STATE_SALES_TAX.TX);
  });

  it('upper-cases lower-case input before lookup', () => {
    expect(getStateSalesTax('ca')).toBe(STATE_SALES_TAX.CA);
    expect(getStateSalesTax('tX')).toBe(STATE_SALES_TAX.TX);
  });

  it('trims surrounding whitespace', () => {
    expect(getStateSalesTax('  CA  ')).toBe(STATE_SALES_TAX.CA);
  });

  it('returns 0 for unknown states', () => {
    expect(getStateSalesTax('XX')).toBe(0);
    expect(getStateSalesTax('ZZZ')).toBe(0);
  });

  it('returns 0 for empty / whitespace-only input', () => {
    expect(getStateSalesTax('')).toBe(0);
    expect(getStateSalesTax('   ')).toBe(0);
  });

  it('returns 0 for non-string garbage', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getStateSalesTax(null as any)).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getStateSalesTax(undefined as any)).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getStateSalesTax(42 as any)).toBe(0);
  });
});

describe('getCaLumberAssessment', () => {
  it('returns 1% of the subtotal on positive input', () => {
    expect(getCaLumberAssessment(1000)).toBe(10);
    expect(getCaLumberAssessment(12345.67)).toBeCloseTo(123.46, 2);
  });

  it('rounds to the nearest cent', () => {
    // 333.335 * 0.01 = 3.33335; rounded = 3.33
    expect(getCaLumberAssessment(333.335)).toBe(3.33);
    // 333.445 * 0.01 = 3.33445; rounded = 3.33
    expect(getCaLumberAssessment(333.445)).toBe(3.33);
  });

  it('returns 0 for zero or negative input', () => {
    expect(getCaLumberAssessment(0)).toBe(0);
    expect(getCaLumberAssessment(-100)).toBe(0);
  });

  it('returns 0 for NaN or Infinity', () => {
    expect(getCaLumberAssessment(Number.NaN)).toBe(0);
    expect(getCaLumberAssessment(Number.POSITIVE_INFINITY)).toBe(0);
    expect(getCaLumberAssessment(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('respects the CA_LUMBER_ASSESSMENT constant', () => {
    expect(CA_LUMBER_ASSESSMENT).toBe(0.01);
  });
});
