/**
 * Cost tracker — per-phase ledger writer for the tiered ingest engine.
 *
 * Purpose:  Records how much each phase of a bid's ingest cost, so the
 *           manager dashboard can roll up "extraction spend this month"
 *           and we can empirically tune EXTRACTION_CONFIDENCE_THRESHOLD
 *           over time by seeing where the spend actually lands. Rows go
 *           into public.extraction_costs (migration 015).
 *
 *           Design note — why CostMethod is wider than ExtractionMethod:
 *           line_items.extraction_method records how a *single line* was
 *           produced (excel_parse / pdf_direct / ocr / claude_extraction).
 *           extraction_costs.method records how much a whole *phase* of
 *           the pipeline cost — which splits the two Claude modes apart
 *           (`claude_mode_a` vs `claude_mode_b`) and adds a `qa_llm`
 *           bucket for the Haiku QA pass. Keeping those separate is
 *           what lets us answer "is Mode B actually cheaper than Mode A
 *           in practice" from a single SELECT.
 *
 *           This module is fire-and-forget. A transient DB blip must
 *           never block a bid from reaching the reviewing state, so
 *           every write is wrapped in a try/catch that logs and swallows.
 *           The orchestrator calls `recordExtraction()` for each phase
 *           it actually ran; zero-cost phases (analyzer, parser) still
 *           get logged so the dashboard shows every step a bid touched.
 *
 * Inputs:   { bidId, companyId, method, costCents } per phase.
 * Outputs:  Promise<void> — always resolves, never throws.
 * Agent/API: Supabase service-role client (bypasses RLS; insert policy
 *            is service-role only per migration 015).
 * Imports:  ./supabase (getSupabaseAdmin), @lmbr/types (CostMethod).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import type { CostMethod } from '@lmbr/types';

import { getSupabaseAdmin } from './supabase';

export interface RecordExtractionInput {
  bidId: string;
  companyId: string;
  method: CostMethod;
  costCents: number;
}

/**
 * Insert one extraction_costs row for a single phase. Intentionally
 * fire-and-forget: a write failure is logged but never propagated. The
 * orchestrator must not be gated on cost-ledger availability.
 */
export async function recordExtraction(input: RecordExtractionInput): Promise<void> {
  // Clamp negative / NaN cost values so a buggy caller can't poison the
  // ledger. The DB column is numeric(8,4) so sub-cent precision survives.
  const safeCost = Number.isFinite(input.costCents)
    ? Math.max(0, input.costCents)
    : 0;

  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from('extraction_costs').insert({
      bid_id: input.bidId,
      company_id: input.companyId,
      method: input.method,
      cost_cents: safeCost,
    });
    if (error) {
      console.warn('[cost-tracker] insert failed', {
        bidId: input.bidId,
        method: input.method,
        costCents: safeCost,
        error: error.message,
      });
    }
  } catch (err) {
    console.warn('[cost-tracker] insert threw', {
      bidId: input.bidId,
      method: input.method,
      costCents: safeCost,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Batch variant — insert several phase rows in a single round trip.
 * Same fire-and-forget contract. Used by the orchestrator at the end of
 * `processIngestJob` when it has already tallied every phase it ran.
 */
export async function recordExtractionBatch(
  rows: RecordExtractionInput[],
): Promise<void> {
  if (rows.length === 0) return;

  const payload = rows.map((row) => ({
    bid_id: row.bidId,
    company_id: row.companyId,
    method: row.method,
    cost_cents: Number.isFinite(row.costCents) ? Math.max(0, row.costCents) : 0,
  }));

  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from('extraction_costs').insert(payload);
    if (error) {
      console.warn('[cost-tracker] batch insert failed', {
        count: rows.length,
        error: error.message,
      });
    }
  } catch (err) {
    console.warn('[cost-tracker] batch insert threw', {
      count: rows.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
