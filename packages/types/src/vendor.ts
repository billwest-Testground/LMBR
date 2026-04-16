/**
 * Vendor type — lumber mill / supplier the Buyer solicits bids from.
 *
 * Purpose:  Represents an upstream supplier (mill, broker, reload). Vendors
 *           are scoped by company, tagged by commodity capability and region,
 *           and used by the routing-agent to pick the best-fit suppliers to
 *           solicit for a given customer bid.
 *
 *           Schema mirrors public.vendors (migration 005) and
 *           public.vendor_bids (migrations 006 + 017). snake_case DB columns
 *           are surfaced here as camelCase so routes and UI share one shape.
 *
 * Inputs:   none — declarative module.
 * Outputs:  `Vendor` + `VendorBid` types and Zod schemas, plus the
 *           `VendorType`, `VendorBidStatus`, and `VendorSubmissionMethod`
 *           enums pulled directly from the Postgres types.
 * Agent/API: consumed by routing-agent (fit scoring), vendor dispatch API
 *            (Prompt 05 Task 2), scan-back extraction, and the Buyer UI.
 * Imports:  zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';

export const VendorTypeSchema = z.enum(['mill', 'wholesaler', 'distributor', 'retailer']);
export type VendorType = z.infer<typeof VendorTypeSchema>;

export const VendorBidStatusSchema = z.enum([
  'pending',
  'submitted',
  'partial',
  'declined',
  'expired',
]);
export type VendorBidStatus = z.infer<typeof VendorBidStatusSchema>;

export const VendorSubmissionMethodSchema = z.enum(['form', 'scan', 'email']);
export type VendorSubmissionMethod = z.infer<typeof VendorSubmissionMethodSchema>;

export const VendorSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  name: z.string().min(1),
  contactName: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  vendorType: VendorTypeSchema,
  commodities: z.array(z.string()),
  regions: z.array(z.string()),
  minOrderMbf: z.number().nonnegative(),
  active: z.boolean(),
  notes: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Vendor = z.infer<typeof VendorSchema>;

export const VendorBidSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  bidId: z.string().uuid(),
  vendorId: z.string().uuid(),
  status: VendorBidStatusSchema,
  submissionMethod: VendorSubmissionMethodSchema,
  sentAt: z.string().datetime().nullable().optional(),
  dueBy: z.string().datetime().nullable().optional(),
  submittedAt: z.string().datetime().nullable().optional(),
  rawResponseUrl: z.string().url().nullable().optional(),
  token: z.string().nullable().optional(),
  tokenExpiresAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type VendorBid = z.infer<typeof VendorBidSchema>;
