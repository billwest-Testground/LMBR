/**
 * Commodity type — species/dimension/grade catalog reference.
 *
 * Purpose:  Canonical SKU-like identifier for a lumber commodity: species +
 *           grade + nominal dimensions. Used for consolidation (like-items
 *           merged for mill pricing), vendor capability tagging, and market
 *           intel ticker rows.
 * Inputs:   none — declarative module.
 * Outputs:  `Commodity` type + Zod schema.
 * Agent/API: consumed by QA-agent (validates extracted line items), routing
 *            -agent (vendor/commodity match), market-agent (price lookup).
 * Imports:  zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';

export const CommoditySchema = z.object({
  id: z.string(),
  species: z.string(),
  grade: z.string().optional(),
  nominalThicknessIn: z.number().positive(),
  nominalWidthIn: z.number().positive(),
  category: z.enum(['softwood', 'engineered', 'panel', 'treated']),
  description: z.string().optional(),
});

export type Commodity = z.infer<typeof CommoditySchema>;
