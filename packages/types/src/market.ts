/**
 * Market types — LMBR Cash Market Index + CME futures cache + budget quote.
 *
 * Purpose:  The shapes that the market-intel pipeline passes around.
 *           There are three persisted surfaces the dashboard and the
 *           budget-quote fast-path both read:
 *
 *             1. MarketPriceSnapshot — one slice × one day row written
 *                by the daily aggregation job to public.market_price_
 *                snapshots (migration 024). Encodes distribution stats
 *                (median / mean / low / high / spread) across every
 *                contributing company, subject to the 3-company floor
 *                that keeps the index anonymized.
 *             2. MarketFutures — Barchart CME cache row from
 *                public.market_futures (migration 025). One row per
 *                (symbol, contract_month), upserted on refresh.
 *             3. BudgetQuote — ballpark-sell-price fast-path output
 *                produced by market-agent.generateBudgetQuote when a
 *                trader wants a number before the vendor cycle runs.
 *
 *           MarketPrice + MarketSourceSchema stay for backwards compat
 *           with migration 010's market_prices table (dormant; not
 *           written to in the Cash Index flow). Source enum values
 *           match the DB check on market_prices.source: vendor_aggregated
 *           / cme_futures / manual. No Random-Lengths references — that
 *           product decision is locked (see CLAUDE.md).
 *
 * Inputs:   none — declarative module.
 * Outputs:  MarketSource, MarketPrice, MarketPriceSnapshot,
 *           MarketFutures, BudgetQuote + Zod schemas for each.
 * Agent/API: consumed by market-agent, /api/market/*, /api/budget-quote.
 * Imports:  zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';

// -----------------------------------------------------------------------------
// Source enum
// -----------------------------------------------------------------------------

/**
 * Matches the `market_source` enum in supabase/migrations/010_market_prices.sql.
 *   - vendor_aggregated: rolled up from our own vendor bids (this is the
 *     Cash Index — the thing customers actually get priced against).
 *   - cme_futures: pulled from Barchart. Sentiment / direction only.
 *   - manual: hand-entered override for a species we don't have vendor
 *     coverage on yet. Rare; used during onboarding.
 */
export const MarketSourceSchema = z.enum([
  'vendor_aggregated',
  'cme_futures',
  'manual',
]);
export type MarketSource = z.infer<typeof MarketSourceSchema>;

// -----------------------------------------------------------------------------
// Legacy market_prices row shape — kept for the dormant migration-010 table
// -----------------------------------------------------------------------------

export const MarketPriceSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid().optional(),
  commodityId: z.string(),
  region: z.string().optional(),
  source: MarketSourceSchema,
  unitPrice: z.number().nonnegative(),
  pricePer: z.enum(['piece', 'bf', 'mbf', 'lf', 'msf']).default('mbf'),
  currency: z.string().length(3).default('USD'),
  recordedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type MarketPrice = z.infer<typeof MarketPriceSchema>;

// -----------------------------------------------------------------------------
// Cash Index snapshot (migration 024)
// -----------------------------------------------------------------------------

/**
 * The unit a market snapshot is quoted in. MBF for dimensional lumber,
 * MSF for sheet goods (OSB, plywood), piece for specialty items.
 */
export const MarketSnapshotUnitSchema = z.enum(['mbf', 'msf', 'piece']);
export type MarketSnapshotUnit = z.infer<typeof MarketSnapshotUnitSchema>;

/**
 * One aggregated slice × day from market_price_snapshots. The DB enforces
 * the same invariants via CHECK constraints; Zod gives us the same
 * shape at the application boundary.
 */
export const MarketPriceSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    species: z.string(),
    dimension: z.string().nullable(),
    grade: z.string().nullable(),
    region: z.string().nullable(),
    unit: MarketSnapshotUnitSchema,
    sampleDate: z.string(), // ISO date (YYYY-MM-DD)
    companyCount: z.number().int().min(3),
    sampleSize: z.number().int(),
    priceMedian: z.number().nonnegative(),
    priceMean: z.number().nonnegative(),
    priceLow: z.number().nonnegative(),
    priceHigh: z.number().nonnegative(),
    priceSpread: z.number().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .refine((row) => row.sampleSize >= row.companyCount, {
    message: 'sampleSize must be >= companyCount',
    path: ['sampleSize'],
  })
  .refine((row) => row.priceHigh >= row.priceLow, {
    message: 'priceHigh must be >= priceLow',
    path: ['priceHigh'],
  });
export type MarketPriceSnapshot = z.infer<typeof MarketPriceSnapshotSchema>;

// -----------------------------------------------------------------------------
// CME futures cache (migration 025)
// -----------------------------------------------------------------------------

export const MarketFuturesSchema = z.object({
  id: z.string().uuid(),
  symbol: z.string(),
  contractMonth: z.string(),
  lastPrice: z.number().nonnegative(),
  priceChange: z.number().nullable(),
  priceChangePct: z.number().nullable(),
  openInterest: z.number().int().nonnegative().nullable(),
  volume: z.number().int().nonnegative().nullable(),
  fetchedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type MarketFutures = z.infer<typeof MarketFuturesSchema>;

// -----------------------------------------------------------------------------
// Budget quote output
// -----------------------------------------------------------------------------

export const BudgetQuoteLineSchema = z.object({
  commodityId: z.string(),
  quantity: z.number().positive(),
  boardFeet: z.number().nonnegative().optional(),
  marketUnitPrice: z.number().nonnegative(),
  marginPct: z.number(),
  extendedSellPrice: z.number().nonnegative(),
  /** "How thin is the signal behind this line?" — null = no snapshot. */
  companyCount: z.number().int().nullable(),
});
export type BudgetQuoteLine = z.infer<typeof BudgetQuoteLineSchema>;

export const BudgetQuoteSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  customerName: z.string(),
  region: z.string().optional(),
  lines: z.array(BudgetQuoteLineSchema),
  totalSellPrice: z.number().nonnegative(),
  generatedAt: z.string().datetime(),
  /**
   * Any lines we could not price because the LMBR Cash Index has fewer
   * than 3 contributing companies for that slice. Surfaced to the UI so
   * the trader sees "we don't have enough signal on 2x12 #2 Cedar in
   * California" instead of a silent $0 line.
   */
  unpricedLines: z.array(
    z.object({
      commodityId: z.string(),
      reason: z.enum(['insufficient_data', 'unknown_commodity']),
    }),
  ),
});
export type BudgetQuote = z.infer<typeof BudgetQuoteSchema>;
