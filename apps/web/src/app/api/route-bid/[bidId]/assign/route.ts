/**
 * PATCH /api/route-bid/[bidId]/assign — manual line-item reassignment.
 *
 * Purpose:  Handles the "Assign to buyer" dropdown in routing-map.tsx.
 *           The auto-routing pass may leave some line items unrouted (no
 *           matching commodity_assignment or a species the buyer roster
 *           doesn't cover), or the trader may want to override the
 *           automatic pick. This endpoint moves the given line_item_ids
 *           from wherever they currently live into the target buyer's
 *           routing row for the given commodity_group. It reconciles the
 *           whole routing graph for the bid in one pass to avoid
 *           half-moved state.
 *
 * Input:    PATCH { lineItemIds, buyerUserId, commodityGroup }
 * Output:   { routings: BidRoutingRow[], unroutedLineItemIds }
 * Imports:  next/server, zod, service-role Supabase client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getSupabaseAdmin } from '@lmbr/lib';
import { getSupabaseRouteHandlerClient } from '../../../../../lib/supabase/server';

export const runtime = 'nodejs';

const BodySchema = z.object({
  lineItemIds: z.array(z.string().uuid()).min(1),
  buyerUserId: z.string().uuid(),
  commodityGroup: z.string().min(1).max(64),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { bidId: string } },
): Promise<NextResponse> {
  const sessionClient = getSupabaseRouteHandlerClient();
  const {
    data: { session },
  } = await sessionClient.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Tenant gate via the RLS-backed client.
  const { data: bid, error: bidError } = await sessionClient
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
  const { lineItemIds, buyerUserId, commodityGroup } = parsed.data;

  const admin = getSupabaseAdmin();

  // Verify the target buyer is a buyer/trader_buyer in the tenant.
  const { data: buyerRole } = await admin
    .from('roles')
    .select('id, role_type')
    .eq('user_id', buyerUserId)
    .eq('company_id', bid.company_id)
    .in('role_type', ['buyer', 'trader_buyer'])
    .maybeSingle();
  if (!buyerRole) {
    return NextResponse.json(
      { error: 'Target user is not a buyer in this tenant.' },
      { status: 400 },
    );
  }

  // Load the current routing graph for this bid.
  const { data: currentRoutings, error: loadError } = await admin
    .from('bid_routings')
    .select('id, buyer_user_id, commodity_group, line_item_ids, status')
    .eq('bid_id', bid.id);
  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 });
  }

  const incoming = new Set(lineItemIds);

  // Strip the incoming line items from every existing routing row.
  const updates: Array<{
    id: string;
    line_item_ids: string[];
    isEmpty: boolean;
  }> = [];
  for (const routing of currentRoutings ?? []) {
    const filtered = routing.line_item_ids.filter(
      (id: string) => !incoming.has(id),
    );
    if (filtered.length !== routing.line_item_ids.length) {
      updates.push({
        id: routing.id,
        line_item_ids: filtered,
        isEmpty: filtered.length === 0,
      });
    }
  }

  for (const update of updates) {
    if (update.isEmpty) {
      const { error: deleteError } = await admin
        .from('bid_routings')
        .delete()
        .eq('id', update.id);
      if (deleteError) {
        return NextResponse.json({ error: deleteError.message }, { status: 500 });
      }
    } else {
      const { error: updateError } = await admin
        .from('bid_routings')
        .update({ line_item_ids: update.line_item_ids })
        .eq('id', update.id);
      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 });
      }
    }
  }

  // Find or create the target routing row and merge the incoming ids.
  const { data: existingTarget } = await admin
    .from('bid_routings')
    .select('id, line_item_ids')
    .eq('bid_id', bid.id)
    .eq('buyer_user_id', buyerUserId)
    .eq('commodity_group', commodityGroup)
    .maybeSingle();

  if (existingTarget) {
    const merged = Array.from(
      new Set([...(existingTarget.line_item_ids ?? []), ...lineItemIds]),
    );
    const { error: mergeError } = await admin
      .from('bid_routings')
      .update({ line_item_ids: merged })
      .eq('id', existingTarget.id);
    if (mergeError) {
      return NextResponse.json({ error: mergeError.message }, { status: 500 });
    }
  } else {
    const { error: insertError } = await admin.from('bid_routings').insert({
      bid_id: bid.id,
      company_id: bid.company_id,
      buyer_user_id: buyerUserId,
      commodity_group: commodityGroup,
      line_item_ids: lineItemIds,
      status: 'pending',
      notification_sent_at: new Date().toISOString(),
    });
    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    // In-app notification for the newly-assigned buyer.
    const { error: notifError } = await admin.from('notifications').insert({
      user_id: buyerUserId,
      company_id: bid.company_id,
      type: 'bid_routed',
      title: 'New bid assignment',
      body: `${lineItemIds.length} line item${lineItemIds.length === 1 ? '' : 's'} — ${commodityGroup}`,
      link: `/bids/${bid.id}/route`,
    });
    if (notifError) {
      console.error('[assign] notification insert failed', notifError.message);
    }
  }

  // Re-fetch the canonical state so the client re-renders from DB truth.
  const { data: routings } = await admin
    .from('bid_routings')
    .select('id, buyer_user_id, commodity_group, line_item_ids, status, notification_sent_at')
    .eq('bid_id', bid.id)
    .order('commodity_group', { ascending: true });

  return NextResponse.json({ routings: routings ?? [] });
}
