/**
 * Bid type — customer RFQ / job takeoff flowing through LMBR.ai.
 *
 * Purpose:  Central entity of the bid-automation workflow. A customer bid
 *           begins as a PDF/Excel/email/scanned document (ingest), is routed
 *           to the right Buyer by commodity + geography, fans out as vendor
 *           bid requests, is consolidated for mill pricing while preserving
 *           house/phase breakdown for the customer quote, compared for best
 *           price per line, margined by the Trader, gated by a Manager-Owner,
 *           and released as a clean customer quote.
 * Inputs:   none — declarative module.
 * Outputs:  `Bid`, `BidStatus`, `BidSource` types + Zod schemas.
 * Agent/API: consumed by every agent in @lmbr/agents and every bid-related
 *            API route under apps/web/src/app/api/.
 * Imports:  zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';

export const BidStatusSchema = z.enum([
  'draft',
  'ingesting',
  'routed',
  'vendor_pending',
  'quoted',
  'won',
  'lost',
  'archived',
]);
export type BidStatus = z.infer<typeof BidStatusSchema>;

export const BidSourceSchema = z.enum([
  'pdf',
  'excel',
  'email',
  'scan',
  'manual',
]);
export type BidSource = z.infer<typeof BidSourceSchema>;

export const BidSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  customerName: z.string().min(1),
  projectName: z.string().optional(),
  jobAddress: z.string().optional(),
  jobState: z.string().length(2).optional(),
  jobRegion: z.string().optional(),
  source: BidSourceSchema,
  sourceDocumentUrl: z.string().url().optional(),
  status: BidStatusSchema,
  ownerTraderId: z.string().uuid().optional(),
  assignedBuyerId: z.string().uuid().optional(),
  quoteDueAt: z.string().datetime().optional(),
  totalBoardFeet: z.number().nonnegative().optional(),
  totalCost: z.number().nonnegative().optional(),
  totalSellPrice: z.number().nonnegative().optional(),
  marginPct: z.number().min(-1).max(1).optional(),
  marginApprovedBy: z.string().uuid().optional(),
  marginApprovedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Bid = z.infer<typeof BidSchema>;
