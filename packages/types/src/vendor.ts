/**
 * Vendor type — lumber mill / supplier the Buyer solicits bids from.
 *
 * Purpose:  Represents an upstream supplier (mill, broker, reload). Vendors
 *           are scoped by company, tagged by commodity capability and region,
 *           and used by the routing-agent to pick the best-fit suppliers to
 *           solicit for a given customer bid.
 * Inputs:   none — declarative module.
 * Outputs:  `Vendor` + `VendorBid` types and Zod schemas. `VendorBid` is the
 *           price response captured from the mill — its vendor name is NEVER
 *           surfaced on the customer-facing quote.
 * Agent/API: consumed by routing-agent (fit scoring), extraction-agent
 *            (auto-extract prices from PDF/email response), and the Buyer
 *            dashboard.
 * Imports:  zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';

export const VendorSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  name: z.string().min(1),
  contactName: z.string().optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().optional(),
  regions: z.array(z.string()),
  commodities: z.array(z.string()),
  preferred: z.boolean().default(false),
  notes: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Vendor = z.infer<typeof VendorSchema>;

export const VendorBidSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  bidId: z.string().uuid(),
  vendorId: z.string().uuid(),
  status: z.enum(['requested', 'received', 'extracted', 'declined', 'expired']),
  requestedAt: z.string().datetime(),
  receivedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  sourceDocumentUrl: z.string().url().optional(),
  rawText: z.string().optional(),
  notes: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type VendorBid = z.infer<typeof VendorBidSchema>;
