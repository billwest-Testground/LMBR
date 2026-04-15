/**
 * LineItem type — one row on a customer bid or vendor response.
 *
 * Purpose:  Captures a single line of a lumber takeoff: species, grade,
 *           nominal dimensions, length, quantity, unit, optional house/phase
 *           tag (preserved for the customer quote even after consolidation),
 *           and price data (cost from vendor, sell from margin stack).
 *           LMBR.ai consolidates like items across houses/phases for mill
 *           pricing but keeps the original breakdown for customer display.
 * Inputs:   none — declarative module.
 * Outputs:  `LineItem` + `VendorBidLineItem` types and Zod schemas.
 * Agent/API: consumed by extraction-agent (PDF → structured), QA-agent
 *            (validates against catalog), pricing-agent (applies margin),
 *            and comparison-agent (best price per line across vendors).
 * Imports:  zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';

export const LineItemSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  bidId: z.string().uuid(),
  house: z.string().optional(),
  phase: z.string().optional(),
  sequence: z.number().int().nonnegative(),
  species: z.string(),
  grade: z.string().optional(),
  nominalThicknessIn: z.number().positive().optional(),
  nominalWidthIn: z.number().positive().optional(),
  lengthFt: z.number().positive().optional(),
  quantity: z.number().positive(),
  unit: z.enum(['piece', 'bf', 'lf', 'msf']).default('piece'),
  description: z.string(),
  boardFeet: z.number().nonnegative().optional(),
  consolidationKey: z.string().optional(),
  selectedVendorBidId: z.string().uuid().optional(),
  unitCost: z.number().nonnegative().optional(),
  unitSellPrice: z.number().nonnegative().optional(),
  extendedCost: z.number().nonnegative().optional(),
  extendedSellPrice: z.number().nonnegative().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LineItem = z.infer<typeof LineItemSchema>;

export const VendorBidLineItemSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  vendorBidId: z.string().uuid(),
  matchedLineItemId: z.string().uuid().optional(),
  species: z.string(),
  grade: z.string().optional(),
  nominalThicknessIn: z.number().positive().optional(),
  nominalWidthIn: z.number().positive().optional(),
  lengthFt: z.number().positive().optional(),
  quantity: z.number().positive(),
  unit: z.enum(['piece', 'bf', 'lf', 'msf']).default('piece'),
  unitPrice: z.number().nonnegative(),
  currency: z.string().length(3).default('USD'),
  pricePer: z.enum(['piece', 'bf', 'mbf', 'lf', 'msf']).default('mbf'),
  freightIncluded: z.boolean().default(false),
  notes: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type VendorBidLineItem = z.infer<typeof VendorBidLineItemSchema>;
