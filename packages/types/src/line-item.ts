/**
 * LineItem type — one extracted lumber row on a customer bid.
 *
 * Purpose:  Captures a single line of a lumber takeoff. Mirrors the
 *           public.line_items migration exactly: building_tag +
 *           phase_number preserve the customer's original structure
 *           (never auto-collapsed), species/dimension/grade/length are
 *           normalized to LMBR's canonical vocabulary, quantity + unit
 *           feed the board_feet volume formula, and the self-reference
 *           original_line_item_id keeps the consolidation source mapping
 *           so hybrid quotes can show "what the vendor sees" and "what
 *           the customer sees" from the same dataset.
 *
 *           Consumed by extraction-agent (model output → this), qa-agent
 *           (validates against @lmbr/config catalog), consolidation-agent
 *           (derived consolidation rows), pricing-agent (applies margin),
 *           and comparison-agent (best vendor per line).
 *
 * Imports:  zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';

export const LineItemUnitSchema = z.enum(['PCS', 'MBF', 'MSF']);
export type LineItemUnit = z.infer<typeof LineItemUnitSchema>;

export const LineItemSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  bidId: z.string().uuid(),
  buildingTag: z.string().nullable().optional(),
  phaseNumber: z.number().int().nullable().optional(),
  species: z.string(),
  dimension: z.string(),
  grade: z.string().nullable().optional(),
  length: z.string().nullable().optional(),
  quantity: z.number().positive(),
  unit: LineItemUnitSchema,
  boardFeet: z.number().nonnegative().nullable().optional(),
  notes: z.string().nullable().optional(),
  isConsolidated: z.boolean().default(false),
  originalLineItemId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
});
export type LineItem = z.infer<typeof LineItemSchema>;

/**
 * Extracted line item — not yet persisted. Used by ingest-agent and
 * extraction-agent to pass structured rows through the pipeline before
 * the route handler assigns UUIDs and writes them to Postgres.
 */
export const ExtractedLineItemSchema = z.object({
  species: z.string(),
  dimension: z.string(),
  grade: z.string().optional().default(''),
  length: z.string().optional().default(''),
  quantity: z.number().positive(),
  unit: LineItemUnitSchema,
  boardFeet: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  flags: z.array(z.string()),
  originalText: z.string(),
});
export type ExtractedLineItem = z.infer<typeof ExtractedLineItemSchema>;

export const ExtractedBuildingGroupSchema = z.object({
  buildingTag: z.string(),
  phaseNumber: z.number().int().nullable(),
  lineItems: z.array(ExtractedLineItemSchema),
});
export type ExtractedBuildingGroup = z.infer<typeof ExtractedBuildingGroupSchema>;

export const ExtractionOutputSchema = z.object({
  extractionConfidence: z.number().min(0).max(1),
  buildingGroups: z.array(ExtractedBuildingGroupSchema),
  totalLineItems: z.number().int().nonnegative(),
  totalBoardFeet: z.number().nonnegative(),
  flagsRequiringReview: z.array(z.string()),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

/**
 * Vendor bid line item — one priced row a vendor returned for a
 * specific customer-bid line_item. Mirrors public.vendor_bid_line_items.
 */
export const VendorBidLineItemSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  vendorBidId: z.string().uuid(),
  lineItemId: z.string().uuid(),
  unitPrice: z.number().nullable().optional(),
  totalPrice: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
  isBestPrice: z.boolean().default(false),
  createdAt: z.string().datetime(),
});
export type VendorBidLineItem = z.infer<typeof VendorBidLineItemSchema>;
