/**
 * POST /api/route-bid/[bidId]/confirm — lock in the routing.
 *
 * Purpose:  Called when the trader clicks "Confirm routing" on the
 *           routing-map screen. Verifies every line item on the bid is
 *           assigned to some buyer (zero unrouted) and advances
 *           bids.status from 'routing' to 'quoting' so the next stage of
 *           the pipeline (vendor bid dispatch in PROMPT 05) takes over.
 *
 * Input:    { } (no body — path params carry the bid id)
 * Output:   { status }
 * Imports:  next/server, service-role Supabase client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getSupabaseAdmin } from '@lmbr/lib';
import { getSupabaseRouteHandlerClient } from '../../../../../lib/supabase/server';

export const runtime = 'nodejs';

export async function POST(
  _req: NextRequest,
  { params }: { params: { bidId: string } },
): Promise<NextResponse> {
  const sessionClient = getSupabaseRouteHandlerClient();
  const {
    data: { session },
  } = await sessionClient.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

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

  const admin = getSupabaseAdmin();

  const [
    { data: lineItems, error: lineItemsError },
    { data: routings, error: routingsError },
  ] = await Promise.all([
    admin.from('line_items').select('id').eq('bid_id', bid.id),
    admin
      .from('bid_routings')
      .select('line_item_ids')
      .eq('bid_id', bid.id),
  ]);
  if (lineItemsError) {
    return NextResponse.json({ error: lineItemsError.message }, { status: 500 });
  }
  if (routingsError) {
    return NextResponse.json({ error: routingsError.message }, { status: 500 });
  }

  const allLineItemIds = new Set((lineItems ?? []).map((li) => li.id));
  const routedLineItemIds = new Set<string>();
  for (const routing of routings ?? []) {
    for (const id of routing.line_item_ids ?? []) {
      routedLineItemIds.add(id);
    }
  }
  const unroutedCount = Array.from(allLineItemIds).filter(
    (id) => !routedLineItemIds.has(id),
  ).length;

  if (unroutedCount > 0) {
    return NextResponse.json(
      {
        error: `Cannot confirm — ${unroutedCount} line item${unroutedCount === 1 ? '' : 's'} still unrouted. Assign them to a buyer first.`,
      },
      { status: 409 },
    );
  }

  const { error: updateError } = await admin
    .from('bids')
    .update({ status: 'quoting' })
    .eq('id', bid.id);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ status: 'quoting' });
}
