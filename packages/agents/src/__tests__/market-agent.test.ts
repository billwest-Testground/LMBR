/**
 * Unit tests for market-agent (Prompt 09 Step 3).
 *
 * Purpose:  Locks the deterministic contracts of the pure-TS market
 *           primitives. Covers the 3-buyer anonymization floor, the
 *           distribution math, the 4-level fallback cascade with the
 *           30-day staleness cutoff, the budget-estimate composer
 *           (including unpriced-line surfacing and per-line fallback
 *           labeling), and the re-run idempotency of buildSnapshots.
 *
 *           Only the pure functions are covered here — the DB
 *           orchestrators (aggregateMarketSnapshots, lookupMarketPrice,
 *           generateBudgetQuote) are thin wrappers around them and
 *           are exercised by the smoke-e2e suite. Keeping this file
 *           pure-TS means the suite runs in <1s and stays safe to
 *           execute in CI without a live Supabase.
 *
 * Agent/API: none — pure assertions over injected fixtures.
 * Imports:  vitest, ../market-agent.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { describe, expect, it } from 'vitest';

import type { MarketPriceSnapshot } from '@lmbr/types';

import {
  buildSnapshots,
  composeBudgetQuote,
  matchCascade,
  type BudgetQuoteLineInput,
  type LookupQuery,
  type LookupResult,
  type RawBidPrice,
} from '../market-agent';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function mkRow(
  companyId: string,
  unitPrice: number,
  overrides: Partial<RawBidPrice> = {},
): RawBidPrice {
  return {
    unitPrice,
    species: 'SPF',
    dimension: '2x4',
    grade: '#2',
    unit: 'mbf',
    region: 'west',
    companyId,
    ...overrides,
  };
}

function mkSnapshot(
  overrides: Partial<MarketPriceSnapshot> = {},
): MarketPriceSnapshot {
  return {
    id: `snap-${Math.random().toString(36).slice(2, 10)}`,
    species: 'SPF',
    dimension: '2x4',
    grade: '#2',
    region: 'west',
    unit: 'mbf',
    sampleDate: '2026-04-17',
    companyCount: 3,
    sampleSize: 3,
    priceMedian: 500,
    priceMean: 500,
    priceLow: 400,
    priceHigh: 600,
    priceSpread: 200,
    createdAt: '2026-04-17T00:00:00.000Z',
    ...overrides,
  };
}

function mkLineInput(
  overrides: Partial<BudgetQuoteLineInput> = {},
): BudgetQuoteLineInput {
  return {
    commodityId: 'spf-2x4-2',
    species: 'SPF',
    dimension: '2x4',
    grade: '#2',
    unit: 'mbf',
    quantity: 10,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Test 1 — 3-company floor
// -----------------------------------------------------------------------------

describe('buildSnapshots: anonymization floor', () => {
  it('writes a snapshot when 3 distinct buyer companies contributed', () => {
    const rows = [
      mkRow('company-a', 400),
      mkRow('company-b', 500),
      mkRow('company-c', 600),
    ];
    const snapshots = buildSnapshots(rows, '2026-04-17');

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.company_count).toBe(3);
    expect(snapshots[0]!.sample_size).toBe(3);
  });

  it('suppresses the slice when only 2 companies contributed', () => {
    const rows = [
      mkRow('company-a', 400),
      mkRow('company-b', 500),
      // Same buyer as company-a would be a repeat bid; still only 2
      // distinct buyers — below floor.
      mkRow('company-a', 450),
    ];
    const snapshots = buildSnapshots(rows, '2026-04-17');
    expect(snapshots).toHaveLength(0);
  });

  it('counts buyers, not vendors — 3 bids from 1 buyer is still below floor', () => {
    // Five rows but all from one buyer (e.g. one bid with five vendor
    // responses on the same line). Floor is 3 BUYERS.
    const rows = [
      mkRow('company-a', 400),
      mkRow('company-a', 450),
      mkRow('company-a', 500),
      mkRow('company-a', 550),
      mkRow('company-a', 600),
    ];
    const snapshots = buildSnapshots(rows, '2026-04-17');
    expect(snapshots).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Test 2 — aggregation math
// -----------------------------------------------------------------------------

describe('buildSnapshots: distribution math', () => {
  it('computes median/mean/low/high/spread on a known 5-price slice', () => {
    // Prices [400, 450, 500, 550, 600] — spec's fixture
    //   median = 500 (middle of odd-length sorted array)
    //   mean   = 500 (arithmetic average)
    //   low    = 400
    //   high   = 600
    //   spread = 200
    const rows = [
      mkRow('company-a', 400),
      mkRow('company-b', 450),
      mkRow('company-c', 500),
      mkRow('company-d', 550),
      mkRow('company-e', 600),
    ];
    const [snapshot] = buildSnapshots(rows, '2026-04-17');
    expect(snapshot).toBeDefined();
    expect(snapshot!.price_median).toBe(500);
    expect(snapshot!.price_mean).toBe(500);
    expect(snapshot!.price_low).toBe(400);
    expect(snapshot!.price_high).toBe(600);
    expect(snapshot!.price_spread).toBe(200);
    expect(snapshot!.sample_size).toBe(5);
    expect(snapshot!.company_count).toBe(5);
  });

  it('computes median correctly on an even-count slice (average of two middles)', () => {
    const rows = [
      mkRow('company-a', 400),
      mkRow('company-b', 500),
      mkRow('company-c', 600),
      mkRow('company-d', 700),
    ];
    const [snapshot] = buildSnapshots(rows, '2026-04-17');
    expect(snapshot!.price_median).toBe(550); // (500 + 600) / 2
    expect(snapshot!.price_mean).toBe(550); // (400+500+600+700)/4
    expect(snapshot!.price_spread).toBe(300);
  });

  it('groups independent slices separately', () => {
    // Two separate slices — one for 2x4, one for 2x6. Each has
    // 3 distinct companies so both clear the floor.
    const rows = [
      mkRow('company-a', 400, { dimension: '2x4' }),
      mkRow('company-b', 500, { dimension: '2x4' }),
      mkRow('company-c', 600, { dimension: '2x4' }),
      mkRow('company-a', 700, { dimension: '2x6' }),
      mkRow('company-b', 750, { dimension: '2x6' }),
      mkRow('company-c', 800, { dimension: '2x6' }),
    ];
    const snapshots = buildSnapshots(rows, '2026-04-17');
    expect(snapshots).toHaveLength(2);
    const by24 = snapshots.find((s) => s.dimension === '2x4')!;
    const by26 = snapshots.find((s) => s.dimension === '2x6')!;
    expect(by24.price_median).toBe(500);
    expect(by26.price_median).toBe(750);
  });

  it('ignores rows with zero / negative / non-finite prices', () => {
    const rows = [
      mkRow('company-a', 400),
      mkRow('company-b', 0),
      mkRow('company-c', -50),
      mkRow('company-d', Number.NaN),
      mkRow('company-e', 500),
      mkRow('company-f', 600),
    ];
    const [snapshot] = buildSnapshots(rows, '2026-04-17');
    expect(snapshot).toBeDefined();
    // Only the three positive finite prices survive.
    expect(snapshot!.sample_size).toBe(3);
    expect(snapshot!.price_low).toBe(400);
    expect(snapshot!.price_high).toBe(600);
    expect(snapshot!.price_median).toBe(500);
  });
});

// -----------------------------------------------------------------------------
// Test 3 — fallback cascade
// -----------------------------------------------------------------------------

describe('matchCascade: 4-level fallback', () => {
  const query: LookupQuery = {
    species: 'SPF',
    dimension: '2x4',
    grade: '#2',
    region: 'west',
    unit: 'mbf',
  };

  it('returns level=exact when species+dim+grade+region all match', () => {
    const snapshots = [mkSnapshot()];
    const result = matchCascade(snapshots, query);
    expect(result.level).toBe('exact');
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot!.region).toBe('west');
  });

  it('falls back to region_any when no region match exists', () => {
    const snapshots = [mkSnapshot({ region: 'south' })];
    const result = matchCascade(snapshots, query);
    expect(result.level).toBe('region_any');
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot!.region).toBe('south');
  });

  it('falls back to grade_any when no grade+region match exists', () => {
    const snapshots = [mkSnapshot({ grade: '#1', region: 'south' })];
    const result = matchCascade(snapshots, query);
    expect(result.level).toBe('grade_any');
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot!.grade).toBe('#1');
  });

  it('returns none when nothing matches the species+dimension+unit', () => {
    const snapshots = [mkSnapshot({ dimension: '2x6' })];
    const result = matchCascade(snapshots, query);
    expect(result.level).toBe('none');
    expect(result.snapshot).toBeNull();
  });

  it('returns none when the candidate pool is empty (30-day cutoff applied upstream)', () => {
    // Caller is responsible for the staleness window; matchCascade just
    // returns `none` when no candidates survive. Simulate that here.
    const result = matchCascade([], query);
    expect(result.level).toBe('none');
    expect(result.snapshot).toBeNull();
  });

  it('picks the most recent sample_date at the matching cascade level', () => {
    const older = mkSnapshot({ sampleDate: '2026-04-10', priceMedian: 450 });
    const newer = mkSnapshot({ sampleDate: '2026-04-17', priceMedian: 500 });
    const result = matchCascade([older, newer], query);
    expect(result.level).toBe('exact');
    expect(result.snapshot!.sampleDate).toBe('2026-04-17');
    expect(result.snapshot!.priceMedian).toBe(500);
  });

  it('requires unit to match — never crosses MBF and MSF', () => {
    // Same species, same dimension, same grade, same region — but the
    // candidate is MSF. Querying MBF must not match.
    const snapshots = [mkSnapshot({ unit: 'msf' })];
    const result = matchCascade(snapshots, query);
    expect(result.level).toBe('none');
  });
});

// -----------------------------------------------------------------------------
// Test 4 — budget quote composition
// -----------------------------------------------------------------------------

describe('composeBudgetQuote: priced + unpriced lines', () => {
  it('prices available lines and surfaces unpriced ones without crashing', () => {
    const pricedSnapshot = mkSnapshot({ priceMedian: 500, companyCount: 4 });
    // Lookup: SPF 2x4 #2 priced; SPF 2x12 #2 unpriced.
    const lookup = (q: LookupQuery): LookupResult => {
      if (q.dimension === '2x4') {
        return { snapshot: pricedSnapshot, level: 'exact' };
      }
      return { snapshot: null, level: 'none' };
    };

    const quote = composeBudgetQuote(
      {
        companyId: '00000000-0000-0000-0000-000000000001',
        customerName: 'Acme Construction',
        region: 'west',
        marginPct: 0.1,
        lines: [
          mkLineInput({ commodityId: 'spf-2x4', dimension: '2x4' }),
          mkLineInput({ commodityId: 'spf-2x12', dimension: '2x12' }),
        ],
      },
      lookup,
    );

    expect(quote.lines).toHaveLength(1);
    expect(quote.unpricedLines).toHaveLength(1);
    expect(quote.unpricedLines[0]!.commodityId).toBe('spf-2x12');
    expect(quote.unpricedLines[0]!.reason).toBe('insufficient_data');

    // Priced line math: 500 * (1 + 0.10) * 10 = 5500
    const priced = quote.lines[0]!;
    expect(priced.commodityId).toBe('spf-2x4');
    expect(priced.marketUnitPrice).toBe(500);
    expect(priced.marginPct).toBe(0.1);
    expect(priced.extendedSellPrice).toBe(5500);
    expect(priced.fallbackLevel).toBe('exact');
    expect(priced.companyCount).toBe(4);

    // Total only sums priced lines.
    expect(quote.totalSellPrice).toBe(5500);
  });

  it('labels each priced line with the fallback level it used', () => {
    const exactSnap = mkSnapshot({ priceMedian: 500, dimension: '2x4' });
    const regionSnap = mkSnapshot({
      priceMedian: 550,
      dimension: '2x6',
      region: 'south',
    });
    const gradeSnap = mkSnapshot({
      priceMedian: 600,
      dimension: '2x8',
      grade: '#1',
      region: 'south',
    });

    const lookup = (q: LookupQuery): LookupResult => {
      if (q.dimension === '2x4') return { snapshot: exactSnap, level: 'exact' };
      if (q.dimension === '2x6')
        return { snapshot: regionSnap, level: 'region_any' };
      if (q.dimension === '2x8')
        return { snapshot: gradeSnap, level: 'grade_any' };
      return { snapshot: null, level: 'none' };
    };

    const quote = composeBudgetQuote(
      {
        companyId: '00000000-0000-0000-0000-000000000001',
        customerName: 'Acme',
        region: 'west',
        marginPct: 0,
        lines: [
          mkLineInput({ dimension: '2x4', commodityId: 'c1' }),
          mkLineInput({ dimension: '2x6', commodityId: 'c2' }),
          mkLineInput({ dimension: '2x8', commodityId: 'c3' }),
        ],
      },
      lookup,
    );

    expect(quote.lines).toHaveLength(3);
    const byId = new Map(quote.lines.map((l) => [l.commodityId, l]));
    expect(byId.get('c1')!.fallbackLevel).toBe('exact');
    expect(byId.get('c2')!.fallbackLevel).toBe('region_any');
    expect(byId.get('c3')!.fallbackLevel).toBe('grade_any');
  });

  it('preserves boardFeet on priced lines when provided', () => {
    const lookup = (): LookupResult => ({
      snapshot: mkSnapshot(),
      level: 'exact',
    });
    const quote = composeBudgetQuote(
      {
        companyId: '00000000-0000-0000-0000-000000000001',
        customerName: 'Acme',
        region: 'west',
        marginPct: 0,
        lines: [mkLineInput({ boardFeet: 320 })],
      },
      lookup,
    );
    expect(quote.lines[0]!.boardFeet).toBe(320);
  });
});

// -----------------------------------------------------------------------------
// Test 5 — idempotency (deterministic re-run)
// -----------------------------------------------------------------------------

describe('buildSnapshots: idempotency', () => {
  it('produces identical output on repeated runs over the same input', () => {
    const rows = [
      mkRow('company-a', 400),
      mkRow('company-b', 500),
      mkRow('company-c', 600),
      mkRow('company-d', 450, { dimension: '2x6' }),
      mkRow('company-e', 550, { dimension: '2x6' }),
      mkRow('company-f', 650, { dimension: '2x6' }),
    ];
    const first = buildSnapshots(rows, '2026-04-17');
    const second = buildSnapshots(rows, '2026-04-17');

    expect(second).toEqual(first);
    // Two slices cleared the floor; neither doubled on re-run.
    expect(first).toHaveLength(2);
  });

  it('produces the same output regardless of input order', () => {
    const a = [
      mkRow('company-a', 400),
      mkRow('company-b', 500),
      mkRow('company-c', 600),
    ];
    const b = [
      mkRow('company-c', 600),
      mkRow('company-a', 400),
      mkRow('company-b', 500),
    ];
    expect(buildSnapshots(a, '2026-04-17')).toEqual(
      buildSnapshots(b, '2026-04-17'),
    );
  });
});
