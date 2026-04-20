/**
 * PATCH /api/bids/[bidId]/line-items — save trader edits to extracted rows.
 *
 * Purpose:  After the ingest pipeline populates public.line_items, the
 *           trader reviews them in the LineItemTable and may correct
 *           species / dimension / grade / length / quantity / unit /
 *           board_feet on any row. This route accepts the full edited
 *           row set and reconciles it against the DB:
 *             - rows with a matching (bid_id, sort_order) are updated
 *             - rows with no match are inserted (trader added a row)
 *             - rows present in the DB but missing from the payload are
 *               deleted (trader removed a row)
 *
 *           All writes go through the authenticated SSR Supabase client
 *           so RLS enforces tenancy automatically — the caller must own
 *           the bid or trader_buyer/buyer/manager/owner the tenant.
 *
 * Input:    PATCH { lineItems: EditableLineItemPayload[] }
 * Output:   { ok: true, inserted, updated, deleted }
 * Imports:  zod, next/server, ../../../../lib/supabase/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getSupabaseRouteHandlerClient } from '../../../../../lib/supabase/server';

export const runtime = 'nodejs';

const LineItemPayloadSchema = z.object({
  localId: z.string(),
  buildingTag: z.string().nullable(),
  phaseNumber: z.number().int().nullable(),
  species: z.string().min(1),
  dimension: z.string().min(1),
  grade: z.string().nullable().optional(),
  length: z.string().nullable().optional(),
  quantity: z.number().positive(),
  unit: z.enum(['PCS', 'MBF', 'MSF']),
  boardFeet: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  flags: z.array(z.string()).default([]),
  originalText: z.string().default(''),
});

const BodySchema = z.object({
  lineItems: z.array(LineItemPayloadSchema),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { bidId: string } },
): Promise<NextResponse> {
  const supabase = getSupabaseRouteHandlerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Verify the bid exists and the caller can see it — RLS does the heavy
  // lifting, so an RLS-denied bid simply comes back as null.
  const { data: bid, error: bidError } = await supabase
    .from('bids')
    .select('id, company_id')
    .eq('id', params.bidId)
    .maybeSingle();
  if (bidError) {
    return NextResponse.json({ error: bidError.message }, { status: 500 });
  }
  if (!bid) {
    return NextResponse.json({ error: 'Bid not found' }, { status: 404 });
  }

  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message ?? 'Invalid body' },
      { status: 400 },
    );
  }

  // Select every column the correction-log diff might reference so we
  // can compute pre-edit vs post-edit snapshots without a second read.
  const { data: existing, error: existingError } = await supabase
    .from('line_items')
    .select(
      'id, sort_order, building_tag, phase_number, species, dimension, grade, length, quantity, unit, board_feet',
    )
    .eq('bid_id', bid.id)
    .order('sort_order', { ascending: true });
  if (existingError) {
    return NextResponse.json({ error: existingError.message }, { status: 500 });
  }

  const existingRows = existing ?? [];
  const payload = parsed.data.lineItems;

  // We rely on sort_order as the stable join key between the DB rows
  // and the editable UI rows — the ingest route wrote sort_order in
  // extraction order, and the table preserves it until the trader
  // explicitly reorders (reordering is a follow-up feature).
  const updates: Array<{
    id: string;
    patch: Record<string, unknown>;
    // Snapshot of the row as it stood in the DB before this edit.
    // Used later to compute the correction_logs delta without a
    // second read. Present on every update; absent on inserts.
    before: Record<string, unknown>;
  }> = [];
  const inserts: Array<Record<string, unknown>> = [];

  payload.forEach((row, index) => {
    const metaBlob = JSON.stringify({
      confidence: row.confidence,
      flags: row.flags,
      original_text: row.originalText,
    });
    const dbRow: Record<string, unknown> = {
      bid_id: bid.id,
      company_id: bid.company_id,
      building_tag: row.buildingTag,
      phase_number: row.phaseNumber,
      species: row.species,
      dimension: row.dimension,
      grade: row.grade ?? null,
      length: row.length ?? null,
      quantity: row.quantity,
      unit: row.unit,
      board_feet: row.boardFeet,
      notes: metaBlob,
      sort_order: index,
    };
    const match = existingRows[index];
    if (match) {
      const before: Record<string, unknown> = {
        building_tag: match.building_tag,
        phase_number: match.phase_number,
        species: match.species,
        dimension: match.dimension,
        grade: match.grade,
        length: match.length,
        quantity: match.quantity,
        unit: match.unit,
        board_feet: match.board_feet,
      };
      updates.push({ id: match.id, patch: dbRow, before });
    } else {
      inserts.push(dbRow);
    }
  });

  const deleteIds = existingRows
    .slice(payload.length)
    .map((row) => row.id);

  let insertedCount = 0;
  let updatedCount = 0;
  let deletedCount = 0;

  if (inserts.length > 0) {
    const { error, count } = await supabase
      .from('line_items')
      .insert(inserts, { count: 'exact' });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    insertedCount = count ?? inserts.length;
  }

  // Fields the correction_logs delta inspects. Must match the `before`
  // snapshot keys exactly — any field added here needs a matching read
  // in the select above and a matching assignment when building `dbRow`.
  const TRACKED_FIELDS = [
    'building_tag',
    'phase_number',
    'species',
    'dimension',
    'grade',
    'length',
    'quantity',
    'unit',
    'board_feet',
  ] as const;

  const correctionInserts: Array<Record<string, unknown>> = [];

  for (const { id, patch, before } of updates) {
    const { error } = await supabase.from('line_items').update(patch).eq('id', id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    updatedCount += 1;

    // Compute the structured delta. Skip the row entirely if nothing
    // meaningful changed — we don't want to flood the log with no-op
    // saves (a trader hits Save after only toggling a flag, say).
    const fieldsChanged: string[] = [];
    const details: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of TRACKED_FIELDS) {
      const b = before[field];
      const a = patch[field];
      // Number equality is safe because we coerce above; string/null
      // equality is shallow. For numeric quantity/board_feet, small
      // float drift after a PCS↔MBF round-trip still registers as a
      // change — that's correct for fine-tune purposes.
      if (b !== a) {
        fieldsChanged.push(field);
        details[field] = { before: b, after: a };
      }
    }
    if (fieldsChanged.length === 0) continue;

    correctionInserts.push({
      company_id: bid.company_id,
      bid_id: bid.id,
      line_item_id: id,
      original_extraction: before,
      corrected_extraction: Object.fromEntries(
        TRACKED_FIELDS.map((field) => [field, patch[field] ?? null]),
      ),
      correction_delta: { fieldsChanged, details },
      corrected_by: session.user.id,
    });
  }

  // Fire-and-forget correction_logs write. A failure here must NOT
  // fail the line-item edit — the training dataset is secondary to
  // the trader's actual bid workflow. Log a warn-level line so ops
  // can see the write rate if something regresses.
  if (correctionInserts.length > 0) {
    void supabase
      .from('correction_logs')
      .insert(correctionInserts)
      .then(({ error }) => {
        if (error) {
          console.warn('[correction_logs] insert failed', {
            bidId: bid.id,
            count: correctionInserts.length,
            error: error.message,
          });
        }
      });
  }

  if (deleteIds.length > 0) {
    const { error, count } = await supabase
      .from('line_items')
      .delete({ count: 'exact' })
      .in('id', deleteIds);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    deletedCount = count ?? deleteIds.length;
  }

  return NextResponse.json({
    ok: true,
    inserted: insertedCount,
    updated: updatedCount,
    deleted: deletedCount,
  });
}
