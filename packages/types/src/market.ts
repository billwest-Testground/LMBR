/**
 * Market type — cash market + Random Lengths reference prices.
 *
 * Purpose:  Captures a time-stamped market price for a commodity, tagged by
 *           source (cash market vs Random Lengths subscription). Drives the
 *           LMBR.ai market intel dashboard and the budget-quote fast-path
 *           where a Trader needs a ballpark sell number without running a
 *           full vendor solicitation cycle.
 * Inputs:   none — declarative module.
 * Outputs:  `MarketPrice` + `BudgetQuote` types and schemas.
 * Agent/API: consumed by market-agent and the `/api/budget-quote` route.
 * Imports:  zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';

export const MarketSourceSchema = z.enum([
  'cash',
  'random_lengths',
  'internal_average',
]);
export type MarketSource = z.infer<typeof MarketSourceSchema>;

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

export const BudgetQuoteSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  customerName: z.string(),
  region: z.string().optional(),
  lines: z.array(
    z.object({
      commodityId: z.string(),
      quantity: z.number().positive(),
      boardFeet: z.number().nonnegative().optional(),
      marketUnitPrice: z.number().nonnegative(),
      marginPct: z.number(),
      extendedSellPrice: z.number().nonnegative(),
    }),
  ),
  totalSellPrice: z.number().nonnegative(),
  generatedAt: z.string().datetime(),
});
export type BudgetQuote = z.infer<typeof BudgetQuoteSchema>;
