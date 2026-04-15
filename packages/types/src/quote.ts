/**
 * Quote type — customer-facing clean PDF output (no vendor names).
 *
 * Purpose:  Represents the final Quote artifact released to a customer.
 *           Aggregates selected line items with unit sell prices, totals,
 *           tax, optional freight, a margin snapshot, and the storage URL of
 *           the rendered PDF. Vendor identities are intentionally stripped —
 *           LMBR.ai never exposes upstream supplier names on the customer
 *           quote.
 * Inputs:   none — declarative module.
 * Outputs:  `Quote` type + `QuoteSchema`.
 * Agent/API: produced by the quote API route (apps/web/src/app/api/quote),
 *            gated by manager-owner approval before release.
 * Imports:  zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';

export const QuoteSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  bidId: z.string().uuid(),
  quoteNumber: z.string(),
  version: z.number().int().positive().default(1),
  status: z.enum(['draft', 'pending_approval', 'released', 'revised', 'expired']),
  customerName: z.string(),
  customerEmail: z.string().email().optional(),
  projectName: z.string().optional(),
  subtotal: z.number().nonnegative(),
  freight: z.number().nonnegative().default(0),
  taxRate: z.number().nonnegative().default(0),
  taxAmount: z.number().nonnegative().default(0),
  total: z.number().nonnegative(),
  marginPct: z.number(),
  validUntil: z.string().datetime().optional(),
  releasedPdfUrl: z.string().url().optional(),
  approvedBy: z.string().uuid().optional(),
  approvedAt: z.string().datetime().optional(),
  releasedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Quote = z.infer<typeof QuoteSchema>;
