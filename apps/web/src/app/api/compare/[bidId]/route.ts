/**
 * GET /api/compare/[bidId] — Build the vendor comparison matrix for a bid.
 *
 * Purpose:  Reads the authenticated user's session, confirms the caller has
 *           a buyer-aligned role (vendor pricing is trade-sensitive), then
 *           delegates the snapshot query + agent run to the shared
 *           loadComparison() helper in lib/compare/load-comparison.ts. The
 *           same helper is used by the server-rendered compare page, so the
 *           HTTP surface and the page always agree.
 *
 *           RLS does most of the tenancy heavy-lifting (migration 007 on
 *           vendor_bid_line_items already restricts SELECT to buyer-aligned
 *           roles), but we still do the role check in-code so the failure
 *           is a crisp 403 with a useful message instead of a silently
 *           empty response.
 *
 *           No LLM. No service-role client for reads — we intentionally use
 *           the session client so Postgres-level RLS is the primary defense.
 *
 * Inputs:   GET /api/compare/:bidId  (bidId is a path param, must be UUID).
 * Outputs:  200 { success: true, result: ComparisonResult }
 *           400 invalid UUID
 *           401 not authenticated
 *           403 wrong company OR role lacks vendor-pricing visibility
 *           404 bid not found
 *           500 DB errors
 * Agent/API: @lmbr/agents comparison-agent (pure, no I/O) via loader helper.
 * Imports:  next/server, ../../../../lib/supabase/server,
 *           ../../../../lib/compare/load-comparison.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { loadComparison } from '../../../../lib/compare/load-comparison';
import { getSupabaseRouteHandlerClient } from '../../../../lib/supabase/server';

export const runtime = 'nodejs';

/**
 * Roles permitted to see vendor pricing. Pure traders are explicitly
 * excluded — they see the final quote_line_items after a buyer has made
 * vendor selections, never the raw comparison matrix.
 */
const COMPARE_ROLES = new Set(['buyer', 'trader_buyer', 'manager', 'owner']);

export async function GET(
  _req: NextRequest,
  { params }: { params: { bidId: string } },
): Promise<NextResponse> {
  try {
    const supabase = getSupabaseRouteHandlerClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // --- Load profile + roles in parallel ---------------------------------
    const [profileResult, rolesResult] = await Promise.all([
      supabase
        .from('users')
        .select('id, company_id')
        .eq('id', session.user.id)
        .maybeSingle(),
      supabase.from('roles').select('role_type').eq('user_id', session.user.id),
    ]);

    if (profileResult.error) {
      return NextResponse.json({ error: profileResult.error.message }, { status: 500 });
    }
    const profile = profileResult.data;
    if (!profile?.company_id) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 403 });
    }

    if (rolesResult.error) {
      return NextResponse.json({ error: rolesResult.error.message }, { status: 500 });
    }
    const roles = (rolesResult.data ?? []).map((r) => r.role_type as string);
    const hasAllowedRole = roles.some((r) => COMPARE_ROLES.has(r));
    if (!hasAllowedRole) {
      return NextResponse.json(
        { error: 'Vendor pricing requires buyer role' },
        { status: 403 },
      );
    }

    // --- Delegate the snapshot + agent run to the shared helper ------------
    const loaded = await loadComparison({
      supabase,
      bidId: params.bidId,
      companyId: profile.company_id as string,
    });

    switch (loaded.status) {
      case 'invalid_bid_id':
        return NextResponse.json({ error: 'Invalid bid id' }, { status: 400 });
      case 'not_found':
        return NextResponse.json({ error: 'Bid not found' }, { status: 404 });
      case 'wrong_company':
        return NextResponse.json(
          { error: 'Bid belongs to a different company' },
          { status: 403 },
        );
      case 'db_error':
        return NextResponse.json({ error: loaded.message }, { status: 500 });
      case 'ok':
        return NextResponse.json({ success: true, result: loaded.result });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Compare failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
