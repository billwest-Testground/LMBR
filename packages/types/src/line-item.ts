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

// Tiered ingest engine (Session Prompt 04): how a given line made it into
// the system. Excel/CSV/clean-PDF/DOCX/email are free parser paths, OCR is
// Azure Document Intelligence at ~0.15 cents per page, and
// claude_extraction covers both Mode A (full-doc Sonnet) and Mode B
// (targeted cleanup) — the per-bid extraction_costs table splits those
// two so threshold tuning has the data it needs.
export const ExtractionMethodSchema = z.enum([
  'excel_parse',
  'csv_parse',
  'docx_parse',
  'pdf_direct',
  'ocr',
  'email_text',
  'direct_text',
  'claude_extraction',
]);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

// Wider enum used only by the cost ledger. Splits the two Claude modes
// and adds a bucket for the Haiku QA pass so per-phase spend is legible.
export const CostMethodSchema = z.union([
  ExtractionMethodSchema,
  z.enum(['claude_mode_a', 'claude_mode_b', 'qa_llm']),
]);
export type CostMethod = z.infer<typeof CostMethodSchema>;

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
  sourceLineItemIds: z.array(z.string().uuid()).nullable().optional(),
  sortOrder: z.number().int().nonnegative().default(0),
  extractionMethod: ExtractionMethodSchema.nullable().optional(),
  extractionConfidence: z.number().min(0).max(1).nullable().optional(),
  costCents: z.number().min(0).nullable().optional(),
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
  // Tiered ingest provenance. Optional on the extracted shape so existing
  // code paths that don't yet set them still type-check; the orchestrator
  // sets both before writing to line_items.
  extractionMethod: ExtractionMethodSchema.optional(),
  costCents: z.number().min(0).optional(),
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
