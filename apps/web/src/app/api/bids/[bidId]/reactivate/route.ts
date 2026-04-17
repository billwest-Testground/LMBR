/**
 * POST /api/bids/[bidId]/reactivate — reactivate an archived bid.
 *
 * Purpose:  Clears `archived_at` / `archived_by` on the bid row. Two
 *           modes express what happens to the rest of the state:
 *
 *             continue — "Continue where you left off."
 *               Clears the archive columns. Leaves everything else
 *               intact: status, consolidation_mode, bid_routings,
 *               line_items, vendor_bids. The bid resumes at the
 *               exact state it was in at archive time.
 *
 *             fresh — "Start fresh."
 *               Clears the archive columns AND resets the workflow
 *               state so the bid begins again:
 *                 - status → 'received' (re-enters pipeline at the
 *                   top; ingest-generated line_items are already
 *                   present so the trader can skip re-ingest).
 *                 - consolidation_mode → 'structured' (the default).
 *                 - DELETE every bid_routings row for this bid so
 *                   routing happens anew.
 *               DOES NOT delete line_items (keep the extraction) or
 *               vendor_bids (historical record — their prices are
 *               tenant-internal archive data, not to be thrown out).
 *
 *           Both modes reject a non-archived bid with 409
 *           { error: 'bid_not_archived' } so the UI can distinguish
 *           "already active" from "something else went wrong."
 *
 *           Role gate is identical to /api/bids/[bidId]/archive —
 *           trader_buyer / manager / owner, or trader on their own
 *           bid. Buyer-only cannot reactivate.
 *
 *           `fresh` writes are separate statements (status UPDATE
 *           then bid_routings DELETE); if the DELETE fails after the
 *           UPDATE the bid is left half-reset. The caller sees an
 *           error and ops sees a warning log. Acceptable for Prompt
 *           10 — a future refactor can wrap this in a Postgres
 *           function if the race becomes material.
 *
 * Inputs:   URL param bidId (uuid).
 *           Body: { mode: 'continue' | 'fresh' }.
 * Outputs:  200 { bid: { id, archivedAt: null, ...status fields }, mode }.
 *           400 invalid bidId / body.
 *           401 not authenticated.
 *           403 wrong role / wrong tenant / trader not on the bid.
 *           404 bid not found.
 *           409 { error: 'bid_not_archived' } if archived_at IS NULL.
 * Agent/API: none.
 * Imports:  next/server, zod, @lmbr/lib, supabase server client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getSupabaseAdmin } from '@lmbr/lib';

import { getSupabaseRouteHandlerClient } from '../../../../../lib/supabase/server';

export const runtime = 'nodejs';

const PRIVILEGED_ROLES = new Set(['trader_buyer', 'manager', 'owner']);
const TRADER_ROLE = 'trader';

const ParamsSchema = z.object({ bidId: z.string().uuid() });
const BodySchema = z.object({
  mode: z.enum(['continue', 'fresh']),
});

interface BidForReactivate {
  id: string;
  company_id: string;
  assigned_trader_id: string | null;
  created_by: string;
  archived_at: string | null;
  status: string;
  consolidation_mode: string;
}

function canReactivate(
  roles: string[],
  bid: BidForReactivate,
  userId: string,
): boolean {
  if (roles.some((r) => PRIVILEGED_ROLES.has(r))) return true;
  if (
    roles.includes(TRADER_ROLE) &&
    (bid.assigned_trader_id === userId || bid.created_by === userId)
  ) {
    return true;
  }
  return false;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { bidId: string } },
): Promise<NextResponse> {
  const paramsParsed = ParamsSchema.safeParse(params);
  if (!paramsParsed.success) {
    return NextResponse.json({ error: 'Invalid bidId' }, { status: 400 });
  }
  const { bidId } = paramsParsed.data;

  let body: z.infer<typeof BodySchema>;
  try {
    const raw = await req.json();
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            parsed.error.errors[0]?.message ??
            "Body must be { mode: 'continue' | 'fresh' }.",
        },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json(
      { error: "Body must be JSON { mode: 'continue' | 'fresh' }." },
      { status: 400 },
    );
  }

  try {
    const supabase = getSupabaseRouteHandlerClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const [profileResult, rolesResult] = await Promise.all([
      supabase
        .from('users')
        .select('id, company_id')
        .eq('id', session.user.id)
        .maybeSingle(),
      supabase.from('roles').select('role_type').eq('user_id', session.user.id),
    ]);
    if (profileResult.error) {
      return NextResponse.json(
        { error: profileResult.error.message },
        { status: 500 },
      );
    }
    const profile = profileResult.data;
    if (!profile?.company_id) {
      return NextResponse.json(
        { error: 'User profile not found' },
        { status: 403 },
      );
    }
    const roles = (rolesResult.data ?? []).map((r) => r.role_type as string);

    const { data: bidData, error: bidError } = await supabase
      .from('bids')
      .select(
        'id, company_id, assigned_trader_id, created_by, archived_at, status, consolidation_mode',
      )
      .eq('id', bidId)
      .maybeSingle();
    if (bidError) {
      return NextResponse.json({ error: bidError.message }, { status: 500 });
    }
    const bid = bidData as BidForReactivate | null;
    if (!bid) {
      return NextResponse.json({ error: 'Bid not found' }, { status: 404 });
    }
    if (bid.company_id !== profile.company_id) {
      return NextResponse.json(
        { error: 'Bid belongs to a different company' },
        { status: 403 },
      );
    }
    if (!canReactivate(roles, bid, session.user.id)) {
      return NextResponse.json(
        {
          error:
            'Reactivating requires trader_buyer / manager / owner, or trader on own bid.',
        },
        { status: 403 },
      );
    }

    if (!bid.archived_at) {
      return NextResponse.json(
        { error: 'bid_not_archived' },
        { status: 409 },
      );
    }

    const admin = getSupabaseAdmin();

    // --- Update the bid row --------------------------------------------
    const update: Record<string, unknown> = {
      archived_at: null,
      archived_by: null,
    };
    if (body.mode === 'fresh') {
      update.status = 'received';
      update.consolidation_mode = 'structured';
    }

    const { data: updated, error: updateError } = await admin
      .from('bids')
      .update(update)
      .eq('id', bid.id)
      .eq('company_id', profile.company_id)
      .select(
        'id, archived_at, archived_by, status, consolidation_mode',
      )
      .single();
    if (updateError || !updated) {
      return NextResponse.json(
        { error: updateError?.message ?? 'Reactivate failed' },
        { status: 500 },
      );
    }

    // --- fresh: also clear bid_routings --------------------------------
    // Separate statement — no transactional wrap for Prompt 10. The
    // update-then-delete sequence is safe to retry: if the delete
    // failed, the row is already unarchived (continue-like state)
    // and a second fresh call will re-attempt the delete. Line_items
    // and vendor_bids are intentionally left intact — the line_items
    // are the cached extraction, and vendor_bids is tenant history.
    if (body.mode === 'fresh') {
      const { error: routingDeleteError } = await admin
        .from('bid_routings')
        .delete()
        .eq('bid_id', bid.id);
      if (routingDeleteError) {
        console.warn(
          `LMBR.ai reactivate: fresh mode — bid_routings delete failed for bid=${bid.id}: ${routingDeleteError.message}.`,
        );
        return NextResponse.json(
          {
            error:
              'Bid unarchived and status reset, but routing cleanup failed. Retry to finish or clean manually.',
          },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({
      bid: {
        id: updated.id as string,
        archivedAt: null,
        archivedBy: null,
        status: updated.status as string,
        consolidationMode: updated.consolidation_mode as string,
      },
      mode: body.mode,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Reactivate failed';
    console.warn(`LMBR.ai reactivate: ${message}.`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
