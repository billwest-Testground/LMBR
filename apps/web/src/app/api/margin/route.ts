/**
 * POST /api/margin — Apply the margin stack to a bid + persist the draft.
 *
 * Purpose:  Buyers, trader_buyers, and managers POST margin selections +
 *           a list of margin instructions. The pricing-agent evaluates
 *           the stack deterministically (see applyMargin loader), then
 *           this route upserts public.quotes + public.quote_line_items
 *           and returns the full PricingResult so the UI can render
 *           numbers + approval flags without a second round-trip.
 *
 *           Action semantics:
 *             - 'draft' → persist as draft, always.
 *             - 'submit_for_approval' → if grandTotal > approval
 *               threshold, status=pending_approval; if not and user is
 *               manager/owner, status=approved (auto-approved below the
 *               gate); if not and user is a buyer, status=draft (the
 *               UI should then prompt them to hand off to a manager).
 *
 * Inputs:   { bidId, selections[], marginInstructions[], action }.
 * Outputs:  { success, quote, pricing, needsApproval, belowMinimumMargin }.
 * Agent/API: @lmbr/agents pricing-agent via applyMargin loader.
 * Imports:  next/server, ../../../lib/supabase/server, @lmbr/lib,
 *           ../../../lib/margin/apply-margin.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getSupabaseAdmin } from '@lmbr/lib';

import {
  applyMargin,
  ApplyMarginBodySchema,
} from '../../../lib/margin/apply-margin';
import { getSupabaseRouteHandlerClient } from '../../../lib/supabase/server';

export const runtime = 'nodejs';

/** Roles permitted to run the margin stack. Pure traders cannot see
 *  vendor costs, so they also cannot drive the margin stack. */
const MARGIN_ROLES = new Set([
  'buyer',
  'trader_buyer',
  'manager',
  'owner',
]);

const MANAGER_ROLES = new Set(['manager', 'owner']);

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 },
      );
    }
    const parsed = ApplyMarginBodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message ?? 'Invalid request body' },
        { status: 400 },
      );
    }

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
    if (rolesResult.error) {
      return NextResponse.json(
        { error: rolesResult.error.message },
        { status: 500 },
      );
    }
    const profile = profileResult.data;
    if (!profile?.company_id) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 403 });
    }
    const roles = (rolesResult.data ?? []).map((r) => r.role_type as string);
    const hasAllowedRole = roles.some((r) => MARGIN_ROLES.has(r));
    if (!hasAllowedRole) {
      return NextResponse.json(
        { error: 'Margin stacking requires buyer-aligned role' },
        { status: 403 },
      );
    }
    const userIsManagerOrOwner = roles.some((r) => MANAGER_ROLES.has(r));

    const admin = getSupabaseAdmin();

    const result = await applyMargin({
      supabase,
      admin,
      bidId: parsed.data.bidId,
      companyId: profile.company_id as string,
      userId: session.user.id,
      userIsManagerOrOwner,
      body: parsed.data,
    });

    switch (result.status) {
      case 'invalid_bid_id':
        return NextResponse.json({ error: 'Invalid bid id' }, { status: 400 });
      case 'not_found':
        return NextResponse.json({ error: 'Bid not found' }, { status: 404 });
      case 'wrong_company':
        return NextResponse.json(
          { error: 'Bid belongs to a different company' },
          { status: 403 },
        );
      case 'forbidden':
        return NextResponse.json({ error: result.message }, { status: 403 });
      case 'bad_state':
        return NextResponse.json({ error: result.message }, { status: 409 });
      case 'db_error':
        return NextResponse.json({ error: result.message }, { status: 500 });
      case 'ok':
        return NextResponse.json({
          success: true,
          quote: result.quote,
          pricing: result.pricing,
          needsApproval: result.needsApproval,
          belowMinimumMargin: result.belowMinimumMargin,
        });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Margin failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
