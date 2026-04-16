/**
 * applyMargin — shared margin-API loader / orchestrator.
 *
 * Purpose:  Single implementation of the "run pricing-agent against a
 *           bid's snapshot and persist the result" flow. The /api/margin
 *           POST handler just wires session + HTTP and delegates here,
 *           mirroring the loadComparison pattern used by /api/compare.
 *
 *           Runs the agent under the caller's session client (RLS is
 *           the primary defense), and falls back to the service-role
 *           client for the write side only (`quotes` + `quote_line_items`
 *           upserts) because the RLS rules on `quotes.status` +
 *           `quote_line_items` are deliberately narrow for manager
 *           gating — a buyer submitting a draft would otherwise fail on
 *           the `with check` clause on update. The read side stays
 *           tenant-gated.
 *
 *           Return is a discriminated `ApplyMarginResult` so the route
 *           handler can translate into HTTP status codes without a
 *           sprawl of try/catch.
 *
 * Inputs:   { supabase, adminSupabase, bidId, companyId, userId, body }.
 * Outputs:  ApplyMarginResult — 'ok' | 'invalid_bid_id' | 'not_found' |
 *           'wrong_company' | 'bad_state' | 'forbidden' | 'db_error'.
 * Agent/API: @lmbr/agents pricingAgent (pure, no I/O).
 * Imports:  @lmbr/agents, zod, @supabase/supabase-js.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import {
  pricingAgent,
  type ConsolidationMode,
  type MarginInstruction,
  type PricingInput,
  type PricingLineInput,
  type PricingResult,
  type PricingSelection,
} from '@lmbr/agents';

// ---------------------------------------------------------------------------
// Public schema (used by the route handler for request body validation)
// ---------------------------------------------------------------------------

export const MarginSelectionSchema = z.object({
  lineItemId: z.string().uuid(),
  vendorBidLineItemId: z.string().uuid(),
  vendorId: z.string().uuid(),
  costUnitPrice: z.number(),
  costTotalPrice: z.number(),
});

export const MarginInstructionSchema = z.object({
  scope: z.enum(['line', 'commodity', 'all']),
  targetId: z.string().nullable(),
  marginType: z.enum(['percent', 'dollar']),
  marginValue: z.number(),
});

export const ApplyMarginBodySchema = z.object({
  bidId: z.string().uuid(),
  selections: z.array(MarginSelectionSchema),
  marginInstructions: z.array(MarginInstructionSchema),
  action: z.enum(['draft', 'submit_for_approval']),
});

export type ApplyMarginBody = z.infer<typeof ApplyMarginBodySchema>;

// ---------------------------------------------------------------------------
// Result union
// ---------------------------------------------------------------------------

export interface ApplyMarginOk {
  status: 'ok';
  pricing: PricingResult;
  quote: {
    id: string;
    status: 'draft' | 'pending_approval' | 'approved';
    subtotal: number;
    marginPercent: number;
    marginDollars: number;
    lumberTax: number;
    salesTax: number;
    total: number;
  };
  needsApproval: boolean;
  belowMinimumMargin: boolean;
}

export type ApplyMarginResult =
  | ApplyMarginOk
  | { status: 'invalid_bid_id' }
  | { status: 'not_found' }
  | { status: 'wrong_company' }
  | { status: 'bad_state'; message: string }
  | { status: 'forbidden'; message: string }
  | { status: 'db_error'; message: string };

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

export interface ApplyMarginArgs {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, 'public', any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, 'public', any>;
  bidId: string;
  companyId: string;
  userId: string;
  userIsManagerOrOwner: boolean;
  body: ApplyMarginBody;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function applyMargin(
  args: ApplyMarginArgs,
): Promise<ApplyMarginResult> {
  const { supabase, admin, bidId, companyId, userId, userIsManagerOrOwner, body } =
    args;

  // --- Verify bid + tenancy + status ----------------------------------------
  const { data: bid, error: bidError } = await supabase
    .from('bids')
    .select('id, company_id, status, consolidation_mode, job_state')
    .eq('id', bidId)
    .maybeSingle();
  if (bidError) {
    return { status: 'db_error', message: bidError.message };
  }
  if (!bid) {
    return { status: 'not_found' };
  }
  if (bid.company_id !== companyId) {
    return { status: 'wrong_company' };
  }

  // Margin stacking is meaningful once the bid is in vendor-pricing
  // territory. Block from pre-routing states so we don't stack margin on
  // an incomplete extraction.
  const allowedBidStatuses = new Set([
    'quoting',
    'comparing',
    'pricing',
    'pending_approval',
    'approved', // allow re-save after approval (manager tweaks)
  ]);
  if (!allowedBidStatuses.has(bid.status as string)) {
    return {
      status: 'bad_state',
      message: `Bid status '${bid.status}' does not accept margin stacking`,
    };
  }

  // --- Load line items + company settings in parallel -----------------------
  const [linesResult, companyResult] = await Promise.all([
    supabase
      .from('line_items')
      .select(
        'id, species, dimension, grade, length, quantity, unit, building_tag, phase_number, sort_order',
      )
      .eq('bid_id', bidId)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
    supabase
      .from('companies')
      .select('approval_threshold_dollars, min_margin_percent')
      .eq('id', companyId)
      .maybeSingle(),
  ]);

  if (linesResult.error) {
    return { status: 'db_error', message: linesResult.error.message };
  }
  if (companyResult.error) {
    return { status: 'db_error', message: companyResult.error.message };
  }

  const company = companyResult.data;
  if (!company) {
    return { status: 'not_found' };
  }

  const lines: PricingLineInput[] = (linesResult.data ?? []).map((row) => ({
    lineItemId: row.id as string,
    species: row.species as string,
    dimension: row.dimension as string,
    grade: (row.grade as string | null) ?? null,
    length: (row.length as string | null) ?? null,
    quantity: Number(row.quantity),
    unit: row.unit as 'PCS' | 'MBF' | 'MSF',
    buildingTag: (row.building_tag as string | null) ?? null,
    phaseNumber: (row.phase_number as number | null) ?? null,
    sortOrder: Number(row.sort_order ?? 0),
  }));

  const selections: PricingSelection[] = body.selections.map((s) => ({
    lineItemId: s.lineItemId,
    vendorBidLineItemId: s.vendorBidLineItemId,
    vendorId: s.vendorId,
    costUnitPrice: s.costUnitPrice,
    costTotalPrice: s.costTotalPrice,
  }));

  const marginInstructions: MarginInstruction[] = body.marginInstructions.map(
    (m) => ({
      scope: m.scope,
      targetId: m.targetId,
      marginType: m.marginType,
      marginValue: m.marginValue,
    }),
  );

  const pricingInput: PricingInput = {
    bidId,
    jobState: (bid.job_state as string | null) ?? null,
    consolidationMode: (bid.consolidation_mode as ConsolidationMode) ?? 'structured',
    lines,
    selections,
    marginInstructions,
    settings: {
      approvalThresholdDollars: Number(company.approval_threshold_dollars),
      minMarginPercent: Number(company.min_margin_percent),
    },
  };

  const pricing = pricingAgent(pricingInput);

  // --- Decide target quote status -------------------------------------------
  // draft        — the trader is still iterating
  // submit_for_approval + needsApproval → pending_approval
  // submit_for_approval + !needsApproval + manager/owner → approved
  // submit_for_approval + !needsApproval + not manager → draft
  //   (can't auto-approve yourself if you're below the gate; route
  //    handler will surface this so the UI can redirect to release)
  let targetStatus: 'draft' | 'pending_approval' | 'approved' = 'draft';
  if (body.action === 'submit_for_approval') {
    if (pricing.flags.needsApproval) {
      targetStatus = 'pending_approval';
    } else if (userIsManagerOrOwner) {
      targetStatus = 'approved';
    } else {
      targetStatus = 'draft';
    }
  }

  // --- Upsert quotes row ----------------------------------------------------
  // We use the admin client for the write side because approval-column
  // gating is enforced here (in the loader) and again by the route's
  // role check. The session client would reject 'approved' writes by
  // design in the migration 008 RLS policy; we re-derive the invariant
  // here so the user-facing semantics stay exactly the same.
  const { data: existingQuoteRows, error: existingQuoteError } = await supabase
    .from('quotes')
    .select('id')
    .eq('bid_id', bidId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (existingQuoteError) {
    return { status: 'db_error', message: existingQuoteError.message };
  }
  const existingQuoteId = existingQuoteRows?.[0]?.id as string | undefined;

  const quotePayload: Record<string, unknown> = {
    bid_id: bidId,
    company_id: companyId,
    created_by: userId,
    status: targetStatus,
    subtotal: pricing.totals.totalSell,
    margin_percent: pricing.totals.blendedMarginPercent,
    margin_dollars: pricing.totals.marginDollars,
    lumber_tax: pricing.totals.lumberTax,
    sales_tax: pricing.totals.salesTax,
    total: pricing.totals.grandTotal,
  };
  if (targetStatus === 'approved') {
    quotePayload.approved_by = userId;
    quotePayload.approved_at = new Date().toISOString();
  }

  let quoteId: string;
  if (existingQuoteId) {
    const { error: updateError } = await admin
      .from('quotes')
      .update(quotePayload)
      .eq('id', existingQuoteId);
    if (updateError) {
      return { status: 'db_error', message: updateError.message };
    }
    quoteId = existingQuoteId;
  } else {
    const { data: inserted, error: insertError } = await admin
      .from('quotes')
      .insert(quotePayload)
      .select('id')
      .single();
    if (insertError) {
      return { status: 'db_error', message: insertError.message };
    }
    quoteId = inserted.id as string;
  }

  // --- Replace quote_line_items ---------------------------------------------
  // Delete + insert (idempotent, atomic enough for our scale). The
  // unique (quote_id, line_item_id) index would otherwise collide on
  // re-save.
  const { error: deleteError } = await admin
    .from('quote_line_items')
    .delete()
    .eq('quote_id', quoteId);
  if (deleteError) {
    return { status: 'db_error', message: deleteError.message };
  }

  // Only persist resolved lines (vendorBidLineItemId set). Unresolved
  // lines were surfaced in pricing.flags and the UI should have blocked
  // the submit, but we stay defensive and skip them here too.
  const qliRows = pricing.lines
    .filter((l) => l.vendorBidLineItemId !== '')
    .map((l) => ({
      quote_id: quoteId,
      line_item_id: l.lineItemId,
      vendor_bid_line_item_id: l.vendorBidLineItemId,
      company_id: companyId,
      cost_price: l.costUnitPrice,
      margin_percent: l.marginPercent,
      sell_price: l.sellUnitPrice,
      extended_sell: l.extendedSell,
      building_tag: l.building.tag,
      phase_number: l.building.phaseNumber,
      sort_order: l.sortOrder,
    }));

  if (qliRows.length > 0) {
    const { error: insertLinesError } = await admin
      .from('quote_line_items')
      .insert(qliRows);
    if (insertLinesError) {
      return { status: 'db_error', message: insertLinesError.message };
    }
  }

  // --- Advance bid status (narrow state transitions) ------------------------
  if (
    bid.status === 'quoting' ||
    bid.status === 'comparing'
  ) {
    const nextBidStatus = targetStatus === 'pending_approval' ? 'pending_approval' : 'pricing';
    const { error: bidUpdateError } = await admin
      .from('bids')
      .update({ status: nextBidStatus })
      .eq('id', bidId);
    // Non-fatal — we already wrote the quote. Surface via warnings on
    // pricing if this becomes a real pain point.
    if (bidUpdateError) {
      console.warn(
        `LMBR.ai applyMargin: bid status advance failed for ${bidId}: ${bidUpdateError.message}`,
      );
    }
  } else if (bid.status === 'pricing' && targetStatus === 'pending_approval') {
    await admin
      .from('bids')
      .update({ status: 'pending_approval' })
      .eq('id', bidId);
  }

  return {
    status: 'ok',
    pricing,
    quote: {
      id: quoteId,
      status: targetStatus,
      subtotal: pricing.totals.totalSell,
      marginPercent: pricing.totals.blendedMarginPercent,
      marginDollars: pricing.totals.marginDollars,
      lumberTax: pricing.totals.lumberTax,
      salesTax: pricing.totals.salesTax,
      total: pricing.totals.grandTotal,
    },
    needsApproval: pricing.flags.needsApproval,
    belowMinimumMargin: pricing.flags.belowMinimumMargin,
  };
}
