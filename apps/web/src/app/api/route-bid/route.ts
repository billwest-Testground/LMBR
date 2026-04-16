/**
 * POST /api/route-bid — Route a bid's line items to buyers.
 *
 * Purpose:  Main routing orchestrator. After extraction + QA, the trader
 *           clicks "Proceed to routing". This endpoint:
 *             1. Fetches the bid, its line items, and all buyer candidates
 *                with their commodity assignments.
 *             2. Calls routingAgent() — deterministic species + region
 *                matching, no LLM.
 *             3. Upserts bid_routings rows and advances bid status to
 *                'routing'.
 *             4. Returns the routing map + any unrouted items that need
 *                manual assignment.
 *
 * Inputs:   { bidId: string }
 * Outputs:  { success, routing_map, unrouted, requires_manual_assignment,
 *             buyers_assigned?, unrouted_reason?, unrouted_count }
 * Agent/API: @lmbr/agents routingAgent (pure TS, no API calls).
 * Imports:  @lmbr/agents, @lmbr/lib, zod, next/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  routingAgent,
  type RoutingBuyerCandidate,
  type RoutingRoleType,
} from '@lmbr/agents';
import { getSupabaseAdmin } from '@lmbr/lib';

import { getSupabaseRouteHandlerClient } from '../../../lib/supabase/server';

export const runtime = 'nodejs';

const BodySchema = z.object({
  bidId: z.string().uuid(),
});

/** Bid statuses that allow routing to run (or re-run). */
const ROUTABLE_STATUSES = new Set(['reviewing', 'routing']);

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // ----- Parse + validate body ---------------------------------------------
    const body = BodySchema.safeParse(await req.json());
    if (!body.success) {
      return NextResponse.json(
        { error: body.error.errors[0]?.message ?? 'bidId is required' },
        { status: 400 },
      );
    }
    const { bidId } = body.data;

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
      .select('id, company_id, full_name')
      .eq('id', session.user.id)
      .maybeSingle();
    if (!profile?.company_id) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 403 });
    }

    // ----- Fetch bid (RLS-scoped — proves tenant access) ---------------------
    const { data: bid, error: bidError } = await sessionClient
      .from('bids')
      .select('id, company_id, status, job_region')
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
    if (!ROUTABLE_STATUSES.has(bid.status)) {
      return NextResponse.json(
        { error: `Bid status is '${bid.status}' — routing requires 'reviewing' or 'routing'` },
        { status: 409 },
      );
    }

    // ----- Fetch line items --------------------------------------------------
    const admin = getSupabaseAdmin();
    const { data: lineItems, error: liError } = await admin
      .from('line_items')
      .select('id, species')
      .eq('bid_id', bidId)
      .eq('company_id', profile.company_id)
      .order('sort_order', { ascending: true });
    if (liError) {
      return NextResponse.json({ error: liError.message }, { status: 500 });
    }
    if (!lineItems || lineItems.length === 0) {
      return NextResponse.json(
        { error: 'No line items found for this bid' },
        { status: 400 },
      );
    }

    // ----- Fetch submitting user roles ---------------------------------------
    const { data: userRoles } = await admin
      .from('roles')
      .select('role_type')
      .eq('user_id', profile.id)
      .eq('company_id', profile.company_id);
    const submittingUserRoles: RoutingRoleType[] =
      (userRoles ?? []).map((r) => r.role_type as RoutingRoleType);

    // ----- Fetch all buyer candidates + commodity_assignments -----------------
    const { data: buyerRoles } = await admin
      .from('roles')
      .select('id, user_id, role_type')
      .eq('company_id', profile.company_id)
      .in('role_type', ['buyer', 'trader_buyer']);

    if (!buyerRoles || buyerRoles.length === 0) {
      // No buyers configured — tell the client, don't error.
      await admin
        .from('bids')
        .update({ status: 'routing' })
        .eq('id', bidId);

      return NextResponse.json({
        success: false,
        unrouted_reason: 'no_buyers_configured',
        routing_map: [],
        unrouted: lineItems.map((li) => li.id),
        unrouted_count: lineItems.length,
        requires_manual_assignment: true,
      });
    }

    // Fetch user profiles for buyer names.
    const buyerUserIds = [...new Set(buyerRoles.map((r) => r.user_id))];
    const { data: buyerProfiles } = await admin
      .from('users')
      .select('id, full_name')
      .in('id', buyerUserIds);
    const profileMap = new Map(
      (buyerProfiles ?? []).map((p) => [p.id, p.full_name]),
    );

    // Fetch commodity assignments for all buyer roles.
    const buyerRoleIds = buyerRoles.map((r) => r.id);
    const { data: assignments } = await admin
      .from('commodity_assignments')
      .select('role_id, commodity_type, regions')
      .in('role_id', buyerRoleIds);

    // Build RoutingBuyerCandidate[] keyed by user_id.
    const candidateMap = new Map<string, RoutingBuyerCandidate>();
    for (const role of buyerRoles) {
      if (!candidateMap.has(role.user_id)) {
        candidateMap.set(role.user_id, {
          userId: role.user_id,
          fullName: profileMap.get(role.user_id) ?? 'Unknown',
          roleType: role.role_type as 'buyer' | 'trader_buyer',
          assignments: [],
        });
      }
    }
    for (const a of assignments ?? []) {
      const ownerRole = buyerRoles.find((r) => r.id === a.role_id);
      if (!ownerRole) continue;
      const candidate = candidateMap.get(ownerRole.user_id);
      if (!candidate) continue;
      candidate.assignments.push({
        commodityType: a.commodity_type,
        regions: Array.isArray(a.regions) ? a.regions : [],
      });
    }

    // ----- Run routing agent -------------------------------------------------
    const result = routingAgent({
      bid: { id: bidId, jobRegion: bid.job_region },
      lineItems: lineItems.map((li) => ({ id: li.id, species: li.species })),
      submittingUser: {
        id: profile.id,
        fullName: profile.full_name,
        roles: submittingUserRoles,
      },
      buyerCandidates: [...candidateMap.values()],
    });

    // ----- Upsert bid_routings -----------------------------------------------
    for (const entry of result.entries) {
      const { error: upsertError } = await admin
        .from('bid_routings')
        .upsert(
          {
            bid_id: bidId,
            company_id: profile.company_id,
            buyer_user_id: entry.buyerUserId,
            commodity_group: entry.commodityGroup,
            line_item_ids: entry.lineItemIds,
            status: 'pending',
            notes: entry.reason,
          },
          { onConflict: 'bid_id,buyer_user_id,commodity_group' },
        );
      if (upsertError) {
        return NextResponse.json(
          { error: `Failed to save routing: ${upsertError.message}` },
          { status: 500 },
        );
      }
    }

    // ----- Advance bid status to 'routing' -----------------------------------
    await admin
      .from('bids')
      .update({ status: 'routing' })
      .eq('id', bidId);

    // ----- Response ----------------------------------------------------------
    return NextResponse.json({
      success: true,
      requires_manual_assignment: result.unroutedLineItemIds.length > 0,
      routing_map: result.entries.map((e) => ({
        buyer_user_id: e.buyerUserId,
        buyer_name: e.buyerName,
        commodity_group: e.commodityGroup,
        line_item_ids: e.lineItemIds,
        line_count: e.lineItemIds.length,
        reason: e.reason,
      })),
      unrouted: result.unroutedLineItemIds,
      unrouted_count: result.unroutedLineItemIds.length,
      buyers_assigned: result.summary.buyersAssigned,
      strategy: result.strategy,
      summary: result.summary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Routing failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
