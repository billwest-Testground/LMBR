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
 * Narrowed from the migration-010 enum after the V1 scope cut that
 * removed the futures ticker (see commit history around migration 026).
 *   - vendor_aggregated: rolled up from our own vendor bids — this is
 *     the LMBR Cash Market Index, the thing quotes actually price
 *     against.
 *   - manual: hand-entered override for a species we don't have vendor
 *     coverage on yet. Rare; used during onboarding.
 * The legacy 'cme_futures' value is no longer written by any code path;
 * leaving it in the DB enum is harmless (Postgres accepts the narrower
 * set), and we avoid a risky ALTER TYPE migration for a dormant value.
 */
export const MarketSourceSchema = z.enum(['vendor_aggregated', 'manual']);
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
// Budget quote output
// -----------------------------------------------------------------------------

/**
 * Which level of the fallback cascade priced this line:
 *   - exact:      species + dimension + grade + region all matched.
 *   - region_any: same species/dimension/grade, any region.
 *   - grade_any:  same species/dimension, any grade / any region.
 *
 * Shown in the UI so the trader reads their confidence in the estimate.
 * Exact is a tight signal; grade_any is "this is the best we have, treat
 * as directional." `none` is never a priced line — those land in
 * unpricedLines[] instead.
 */
export const BudgetQuoteFallbackLevelSchema = z.enum([
  'exact',
  'region_any',
  'grade_any',
]);
export type BudgetQuoteFallbackLevel = z.infer<
  typeof BudgetQuoteFallbackLevelSchema
>;

export const BudgetQuoteLineSchema = z.object({
  commodityId: z.string(),
  quantity: z.number().positive(),
  boardFeet: z.number().nonnegative().optional(),
  marketUnitPrice: z.number().nonnegative(),
  marginPct: z.number(),
  extendedSellPrice: z.number().nonnegative(),
  /** "How thin is the signal behind this line?" — null = no snapshot. */
  companyCount: z.number().int().nullable(),
  /** Which level of the cascade produced this price. */
  fallbackLevel: BudgetQuoteFallbackLevelSchema,
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
