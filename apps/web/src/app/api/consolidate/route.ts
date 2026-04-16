/**
 * POST /api/consolidate — Apply consolidation mode to a bid's line items.
 *
 * Purpose:  Idempotent consolidation orchestrator. Re-consolidation deletes
 *           only rows where is_consolidated = true, NEVER originals. Handles
 *           all four modes: STRUCTURED, CONSOLIDATED, PHASED, HYBRID.
 *
 *           For STRUCTURED: skips aggregation, just updates bid mode.
 *           For PHASED: requires at least one activePhase.
 *           For CONSOLIDATED / HYBRID: aggregates like items via the
 *           consolidation agent and inserts consolidated rows with
 *           source_line_item_ids + original_line_item_id back-pointers.
 *
 * Inputs:   { bidId: string, mode: ConsolidationMode, activePhases?: number[] }
 * Outputs:  { success, mode, consolidated_items, original_count,
 *             consolidated_count, reduction_percent, summary }
 * Agent/API: @lmbr/agents consolidationAgent (pure TS, no LLM).
 * Imports:  @lmbr/agents, @lmbr/lib, @lmbr/types, zod, next/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  consolidationAgent,
  type ConsolidationLineItem,
} from '@lmbr/agents';
import { getSupabaseAdmin } from '@lmbr/lib';
import { ConsolidationModeSchema } from '@lmbr/types';

import { getSupabaseRouteHandlerClient } from '../../../lib/supabase/server';

export const runtime = 'nodejs';

const BodySchema = z.object({
  bidId: z.string().uuid(),
  mode: ConsolidationModeSchema,
  activePhases: z.array(z.number().int()).optional(),
});

/** Bid statuses that allow consolidation to run (or re-run). */
const CONSOLIDATABLE_STATUSES = new Set(['reviewing', 'routing']);

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // ----- Parse + validate body ---------------------------------------------
    const body = BodySchema.safeParse(await req.json());
    if (!body.success) {
      return NextResponse.json(
        { error: body.error.errors[0]?.message ?? 'Invalid request body' },
        { status: 400 },
      );
    }
    const { bidId, mode, activePhases } = body.data;

    // ----- Validate PHASED requires activePhases -----------------------------
    if (mode === 'phased' && (!activePhases || activePhases.length === 0)) {
      return NextResponse.json(
        { error: 'PHASED mode requires at least one active phase' },
        { status: 400 },
      );
    }

    // ----- Auth + tenant gate ------------------------------------------------
    const sessionClient = getSupabaseRouteHandlerClient();
    const {
      data: { session },
    } = await sessionClient.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: profile } = await sessionClient
      .from('users')
      .select('id, company_id')
      .eq('id', session.user.id)
      .maybeSingle();
    if (!profile?.company_id) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 403 });
    }

    // ----- Fetch bid (RLS-scoped — proves tenant access) ---------------------
    const { data: bid, error: bidError } = await sessionClient
      .from('bids')
      .select('id, company_id, status')
      .eq('id', bidId)
      .maybeSingle();
    if (bidError) {
      return NextResponse.json({ error: bidError.message }, { status: 500 });
    }
    if (!bid) {
      return NextResponse.json({ error: 'Bid not found' }, { status: 404 });
    }
    if (bid.company_id !== profile.company_id) {
      return NextResponse.json({ error: 'Bid belongs to a different company' }, { status: 403 });
    }
    if (!CONSOLIDATABLE_STATUSES.has(bid.status)) {
      return NextResponse.json(
        { error: `Bid status is '${bid.status}' — consolidation requires 'reviewing' or 'routing'` },
        { status: 409 },
      );
    }

    const admin = getSupabaseAdmin();

    // ----- Fetch original (non-consolidated) line items ----------------------
    const { data: originals, error: origError } = await admin
      .from('line_items')
      .select(
        'id, bid_id, company_id, building_tag, phase_number, species, dimension, grade, length, quantity, unit, board_feet, notes, sort_order, extraction_method, extraction_confidence, cost_cents',
      )
      .eq('bid_id', bidId)
      .eq('company_id', profile.company_id)
      .eq('is_consolidated', false)
      .order('sort_order', { ascending: true });
    if (origError) {
      return NextResponse.json({ error: origError.message }, { status: 500 });
    }
    if (!originals || originals.length === 0) {
      return NextResponse.json(
        { error: 'No line items found for this bid' },
        { status: 400 },
      );
    }

    // ----- Delete existing consolidated rows ONLY ----------------------------
    const { error: deleteError } = await admin
      .from('line_items')
      .delete()
      .eq('bid_id', bidId)
      .eq('company_id', profile.company_id)
      .eq('is_consolidated', true);
    if (deleteError) {
      return NextResponse.json(
        { error: `Failed to clear previous consolidation: ${deleteError.message}` },
        { status: 500 },
      );
    }

    // ----- Update bid consolidation_mode -------------------------------------
    const { error: updateError } = await admin
      .from('bids')
      .update({ consolidation_mode: mode })
      .eq('id', bidId);
    if (updateError) {
      return NextResponse.json(
        { error: `Failed to update bid: ${updateError.message}` },
        { status: 500 },
      );
    }

    // ----- For STRUCTURED: no aggregation needed -----------------------------
    if (mode === 'structured') {
      return NextResponse.json({
        success: true,
        mode,
        consolidated_items: [],
        original_count: originals.length,
        consolidated_count: originals.length,
        reduction_percent: 0,
        summary: {
          originalCount: originals.length,
          consolidatedCount: originals.length,
          reductionPercent: 0,
          buildingCount: new Set(originals.map((r) => r.building_tag).filter(Boolean)).size,
          phaseCount: new Set(originals.map((r) => r.phase_number).filter((p): p is number => p != null)).size,
          totalBoardFeet: originals.reduce((s, r) => s + (Number(r.board_feet) || 0), 0),
        },
      });
    }

    // ----- Map DB rows to ConsolidationLineItem ------------------------------
    const agentLineItems: ConsolidationLineItem[] = originals.map((row) => {
      // Parse flags from notes JSON blob (legacy format: { flags: string[] })
      let flags: string[] = [];
      if (row.notes) {
        try {
          const parsed = JSON.parse(row.notes);
          if (Array.isArray(parsed.flags)) {
            flags = parsed.flags;
          }
        } catch {
          // notes is not JSON — ignore
        }
      }

      return {
        id: row.id,
        bidId: row.bid_id,
        companyId: row.company_id,
        buildingTag: row.building_tag,
        phaseNumber: row.phase_number,
        species: row.species,
        dimension: row.dimension,
        grade: row.grade,
        length: row.length,
        quantity: Number(row.quantity),
        unit: row.unit,
        boardFeet: row.board_feet != null ? Number(row.board_feet) : null,
        confidence: row.extraction_confidence != null ? Number(row.extraction_confidence) : null,
        flags,
        sortOrder: row.sort_order,
        extractionMethod: row.extraction_method,
        extractionConfidence: row.extraction_confidence != null ? Number(row.extraction_confidence) : null,
        costCents: row.cost_cents != null ? Number(row.cost_cents) : null,
      };
    });

    // ----- Run consolidation agent -------------------------------------------
    const result = consolidationAgent({
      lineItems: agentLineItems,
      mode,
      activePhases,
    });

    // ----- Insert consolidated rows ------------------------------------------
    if (result.consolidatedItems.length > 0) {
      const inserts = result.consolidatedItems.map((item) => ({
        company_id: profile.company_id,
        bid_id: bidId,
        species: item.species,
        dimension: item.dimension,
        grade: item.grade,
        length: item.length,
        quantity: item.quantity,
        unit: item.unit,
        board_feet: item.boardFeet,
        is_consolidated: true,
        source_line_item_ids: item.sourceLineItemIds,
        original_line_item_id: item.originalLineItemId,
        sort_order: item.sortOrder,
        extraction_confidence: item.confidence,
        notes: JSON.stringify({ flags: item.flags, consolidation_key: item.consolidationKey }),
      }));

      const { error: insertError } = await admin
        .from('line_items')
        .insert(inserts);
      if (insertError) {
        return NextResponse.json(
          { error: `Failed to insert consolidated rows: ${insertError.message}` },
          { status: 500 },
        );
      }
    }

    // ----- Response ----------------------------------------------------------
    return NextResponse.json({
      success: true,
      mode,
      consolidated_items: result.consolidatedItems.map((item) => ({
        species: item.species,
        dimension: item.dimension,
        grade: item.grade,
        length: item.length,
        quantity: item.quantity,
        unit: item.unit,
        board_feet: item.boardFeet,
        confidence: item.confidence,
        source_line_item_ids: item.sourceLineItemIds,
        consolidation_key: item.consolidationKey,
      })),
      original_count: result.summary.originalCount,
      consolidated_count: result.summary.consolidatedCount,
      reduction_percent: result.summary.reductionPercent,
      summary: result.summary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Consolidation failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
