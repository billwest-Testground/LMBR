/**
 * Bid type — customer RFQ / job takeoff flowing through LMBR.ai.
 *
 * Purpose:  Central entity of the bid-automation workflow. A customer bid
 *           begins as a PDF/Excel/email/scanned document (ingest), is
 *           routed to the right Buyer by commodity + geography, fans out
 *           as vendor bid requests, is consolidated for mill pricing
 *           while preserving house/phase breakdown for the customer
 *           quote, compared for best price per line, margined by the
 *           Trader, gated by a Manager-Owner, and released as a clean
 *           customer quote.
 *
 *           Mirrors public.bids migration exactly (see 003_bids.sql) so
 *           Zod-validated API payloads map 1:1 to DB rows with no
 *           client-side munging.
 *
 * Imports:  zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';

export const BidStatusSchema = z.enum([
  'received',
  'extracting',
  'reviewing',
  'routing',
  'quoting',
  'comparing',
  'pricing',
  'approved',
  'sent',
  'archived',
]);
export type BidStatus = z.infer<typeof BidStatusSchema>;

export const ConsolidationModeSchema = z.enum([
  'structured',
  'consolidated',
  'phased',
  'hybrid',
]);
export type ConsolidationMode = z.infer<typeof ConsolidationModeSchema>;

/**
 * Inbound source classification — how the RFQ entered LMBR. Used to
 * branch ingest-agent pipelines and to populate bid-source badges in the
 * trader dashboard.
 */
export const BidSourceSchema = z.enum([
  'pdf',
  'excel',
  'image',
  'email',
  'scan',
  'manual',
]);
export type BidSource = z.infer<typeof BidSourceSchema>;

export const BidSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  createdBy: z.string().uuid(),
  assignedTraderId: z.string().uuid().nullable().optional(),
  customerName: z.string().min(1),
  customerEmail: z.string().email().nullable().optional(),
  jobName: z.string().nullable().optional(),
  jobAddress: z.string().nullable().optional(),
  jobState: z.string().nullable().optional(),
  jobRegion: z.string().nullable().optional(),
  status: BidStatusSchema,
  dueDate: z.string().datetime().nullable().optional(),
  consolidationMode: ConsolidationModeSchema.default('structured'),
  rawFileUrl: z.string().url().nullable().optional(),
  notes: z.string().nullable().optional(),
  // Archive lifecycle (migration 027). NULL = active. archivedAt is
  // the single source of truth for the archive / active filter — the
  // legacy `'archived'` BidStatus value is dormant.
  archivedAt: z.string().datetime().nullable().optional(),
  archivedBy: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Bid = z.infer<typeof BidSchema>;
