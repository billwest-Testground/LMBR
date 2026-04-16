/**
 * GET /api/compare/[bidId] — Build the vendor comparison matrix for a bid.
 *
 * Purpose:  Reads the authenticated user's session, confirms the caller has
 *           a buyer-aligned role (vendor pricing is trade-sensitive), loads
 *           the full raw snapshot of line items + vendor bids + vendor-line
 *           prices for the target bid under RLS, and hands the snapshot to
 *           the deterministic comparison-agent. The agent produces the
 *           matrix the UI renders: per-line cells, best/worst/spread math,
 *           per-vendor response coverage, and two suggested selection
 *           strategies (cheapest / fewestVendors).
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
 * Agent/API: @lmbr/agents comparison-agent (pure, no I/O).
 * Imports:  @lmbr/agents, zod, next/server,
 *           ../../../../lib/supabase/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  comparisonAgent,
  type ComparisonInput,
  type ComparisonLineInput,
  type ComparisonVendor,
  type ComparisonVendorLine,
} from '@lmbr/agents';
import type { VendorBidStatus } from '@lmbr/types';

import { getSupabaseRouteHandlerClient } from '../../../../lib/supabase/server';

export const runtime = 'nodejs';

const BidIdSchema = z.string().uuid();

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
    const bidIdParse = BidIdSchema.safeParse(params.bidId);
    if (!bidIdParse.success) {
      return NextResponse.json({ error: 'Invalid bid id' }, { status: 400 });
    }
    const bidId = bidIdParse.data;

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

    // --- Verify bid + company ownership -----------------------------------
    const { data: bid, error: bidError } = await supabase
      .from('bids')
      .select('id, company_id')
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

    // --- Load line_items for the bid --------------------------------------
    const { data: lineItemRows, error: lineItemError } = await supabase
      .from('line_items')
      .select(
        'id, species, dimension, grade, length, quantity, unit, building_tag, phase_number, sort_order',
      )
      .eq('bid_id', bidId)
      .order('sort_order', { ascending: true })
      .order('building_tag', { ascending: true })
      .order('id', { ascending: true });
    if (lineItemError) {
      return NextResponse.json({ error: lineItemError.message }, { status: 500 });
    }

    // --- Load vendor_bids + vendor names in parallel ----------------------
    const { data: vendorBidRows, error: vendorBidError } = await supabase
      .from('vendor_bids')
      .select('id, vendor_id, status')
      .eq('bid_id', bidId);
    if (vendorBidError) {
      return NextResponse.json({ error: vendorBidError.message }, { status: 500 });
    }

    const vendorBids = vendorBidRows ?? [];
    const vendorBidIds = vendorBids.map((vb) => vb.id);
    const vendorIds = [...new Set(vendorBids.map((vb) => vb.vendor_id))];

    const [vendorsResult, vendorLinesResult] = await Promise.all([
      vendorIds.length > 0
        ? supabase.from('vendors').select('id, name').in('id', vendorIds)
        : Promise.resolve({ data: [], error: null as Error | null }),
      vendorBidIds.length > 0
        ? supabase
            .from('vendor_bid_line_items')
            .select('id, vendor_bid_id, line_item_id, unit_price, total_price')
            .in('vendor_bid_id', vendorBidIds)
        : Promise.resolve({ data: [], error: null as Error | null }),
    ]);

    if (vendorsResult.error) {
      return NextResponse.json({ error: vendorsResult.error.message }, { status: 500 });
    }
    if (vendorLinesResult.error) {
      return NextResponse.json({ error: vendorLinesResult.error.message }, { status: 500 });
    }

    const vendorsById = new Map(
      (vendorsResult.data ?? []).map((v) => [v.id as string, v.name as string]),
    );
    const vendorBidById = new Map(
      vendorBids.map((vb) => [vb.id as string, vb] as const),
    );

    // --- Assemble ComparisonInput -----------------------------------------
    const vendors: ComparisonVendor[] = vendorBids.map((vb) => ({
      vendorId: vb.vendor_id as string,
      vendorName: vendorsById.get(vb.vendor_id as string) ?? '(unknown vendor)',
      vendorBidId: vb.id as string,
      status: vb.status as VendorBidStatus,
    }));

    const lines: ComparisonLineInput[] = (lineItemRows ?? []).map((row) => ({
      lineItemId: row.id as string,
      species: row.species as string,
      dimension: row.dimension as string,
      grade: (row.grade as string | null) ?? null,
      length: (row.length as string | null) ?? null,
      quantity: Number(row.quantity),
      unit: row.unit as 'PCS' | 'MBF' | 'MSF',
      buildingTag: (row.building_tag as string | null) ?? null,
      phaseNumber: (row.phase_number as number | null) ?? null,
      sortOrder: Number(row.sort_order ?? 0),
    }));

    const vendorLines: ComparisonVendorLine[] = (vendorLinesResult.data ?? [])
      .map((row) => {
        const vb = vendorBidById.get(row.vendor_bid_id as string);
        if (!vb) return null; // defensive: orphaned row
        return {
          vendorBidLineItemId: row.id as string,
          vendorBidId: row.vendor_bid_id as string,
          vendorId: vb.vendor_id as string,
          lineItemId: row.line_item_id as string,
          unitPrice: row.unit_price === null ? null : Number(row.unit_price),
          totalPrice: row.total_price === null ? null : Number(row.total_price),
        } satisfies ComparisonVendorLine;
      })
      .filter((v): v is ComparisonVendorLine => v !== null);

    const input: ComparisonInput = { bidId, vendors, lines, vendorLines };
    const result = comparisonAgent(input);

    return NextResponse.json({ success: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Compare failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
