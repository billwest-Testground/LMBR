/**
 * POST /api/vendors/nudge — (STUB) Reminder email to a dispatched vendor.
 *
 * Purpose:  The buyer's status board (Task 6) surfaces a "Nudge" button on
 *           every `vendor_bids` row so they can prod a quiet vendor without
 *           leaving the page. This route is the stubbed landing pad for
 *           that button: it authenticates the user, proves tenant access
 *           to the vendor_bid row, and logs the intent.
 *
 *           Prompt 08 will replace the `console.log` below with a Microsoft
 *           Graph send-mail call templated by @lmbr/lib/outlook.ts (the
 *           email must come from the buyer's own Outlook account, not a
 *           generic LMBR address — see CLAUDE.md non-negotiable #5).
 *
 *           TODO (Prompt 08): swap the console.log for a Graph send-mail
 *           call. Template should re-issue the vendor's submit URL, quote
 *           the dueBy label (shared formatDueByLabel helper), and CC the
 *           buyer's own inbox so they have a paper trail.
 *
 * Inputs:   { vendorBidId: uuid }
 * Outputs:  { success: true, stubbed: true, message: string }
 * Agent/API: none yet (stub). Prompt 08 wires Microsoft Graph.
 * Imports:  zod, next/server, Supabase session client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getSupabaseRouteHandlerClient } from '../../../../lib/supabase/server';

export const runtime = 'nodejs';

const BodySchema = z.object({
  vendorBidId: z.string().uuid(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = BodySchema.safeParse(await req.json());
    if (!body.success) {
      return NextResponse.json(
        { error: body.error.errors[0]?.message ?? 'vendorBidId is required' },
        { status: 400 },
      );
    }
    const { vendorBidId } = body.data;

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

    // Role gate — nudging vendors is a buyer-aligned action. Mirrors the
    // roles lookup pattern in /api/route-bid (where the same table is used
    // to build RoutingRoleType[] for the submitting user).
    const { data: userRoles } = await sessionClient
      .from('roles')
      .select('role_type')
      .eq('user_id', session.user.id)
      .eq('company_id', profile.company_id);

    const allowedRoles = new Set(['buyer', 'trader_buyer', 'manager', 'owner']);
    const hasRole = (userRoles ?? []).some((r) => allowedRoles.has(r.role_type));
    if (!hasRole) {
      return NextResponse.json(
        { error: 'Nudging vendors requires a buyer, trader_buyer, manager, or owner role.' },
        { status: 403 },
      );
    }

    // RLS-scoped lookup — if the vendor_bid belongs to another tenant, the
    // query returns null and we respond 404 without leaking existence.
    const { data: vendorBid, error: vbError } = await sessionClient
      .from('vendor_bids')
      .select('id, bid_id, vendor_id, company_id')
      .eq('id', vendorBidId)
      .maybeSingle();
    if (vbError) {
      return NextResponse.json({ error: vbError.message }, { status: 500 });
    }
    if (!vendorBid) {
      return NextResponse.json({ error: 'Vendor bid not found' }, { status: 404 });
    }
    if (vendorBid.company_id !== profile.company_id) {
      return NextResponse.json({ error: 'Vendor bid belongs to a different company' }, { status: 403 });
    }

    // STUB — Prompt 08 will replace this with a Graph API send-mail call
    // templated by @lmbr/lib/outlook.ts. Until then we only log intent.
    console.log('[nudge-stub]', {
      vendorBidId: vendorBid.id,
      bidId: vendorBid.bid_id,
      vendorId: vendorBid.vendor_id,
      userId: profile.id,
    });

    return NextResponse.json({
      success: true,
      stubbed: true,
      message: 'Outlook integration lands in Prompt 08',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Nudge failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
