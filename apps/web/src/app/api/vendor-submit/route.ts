/**
 * POST /api/vendor-submit — Public vendor pricing submission endpoint.
 *
 * Purpose:  Accepts a submission from the public vendor-submit form. No
 *           logged-in session; the stateless HMAC-signed `token` in the
 *           request body is the ONLY authentication. Every validation
 *           failure — bad token format, bad signature, expired, missing
 *           row, id/bid/vendor/company mismatch — collapses to the same
 *           generic 401 response so the endpoint cannot be used to probe
 *           which tokens exist, which bids exist, or which vendors are
 *           associated with which company. Specific causes are logged
 *           server-side via console.warn for ops visibility.
 *
 *           Flow (on a valid token):
 *             1. Parse + validate body with Zod.
 *             2. verifyVendorBidToken() → null ⇒ 401.
 *             3. Fetch vendor_bids row by payload.vendorBidId via service role.
 *             4. assertTokenMatchesVendorBid() — catch VendorTokenMismatchError
 *                and 401 (known narrow race: a later dispatch can overwrite
 *                an earlier token for the same (bid, vendor)). Never 500.
 *             5. Reject status='expired' | 'declined' with 409 "closed".
 *             6. Fetch the vendor-visible line_items set (consolidated or
 *                originals, per vendorVisibleIsConsolidatedFlag).
 *             7. Reject any submitted lineItemId that isn't in that set.
 *             8. action='decline': blank out any existing priced rows,
 *                status='declined', submitted_at=now.
 *             9. action='submit':
 *                • Upsert one vendor_bid_line_items row per priced line;
 *                  total_price = unit_price * quantity (server-computed).
 *                • Delete priced rows the vendor has blanked out.
 *                • Flip status: all expected lines priced → 'submitted';
 *                  one or more priced → 'partial'; zero → 'partial'.
 *                • Set submitted_at=now.
 *
 *           The trigger on vendor_bid_line_items recomputes is_best_price
 *           automatically — we don't touch that column.
 *
 * Inputs:   { token: string, action: 'submit' | 'decline',
 *             prices: Array<{ lineItemId: uuid, unitPrice?: number,
 *                             notes?: string }> }
 * Outputs:  { success, status, pricedCount, expectedCount } | { error }
 * Agent/API: Supabase service role + @lmbr/lib/vendor-token (no LLM).
 * Imports:  @lmbr/lib, zod, next/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  assertTokenMatchesVendorBid,
  getSupabaseAdmin,
  toNumber,
  vendorVisibleIsConsolidatedFlag,
  VendorTokenMismatchError,
  verifyVendorBidToken,
} from '@lmbr/lib';
import type { ConsolidationMode } from '@lmbr/types';

export const runtime = 'nodejs';

// Generic error surfaced to clients for every auth-related failure. Intentionally
// vague — never tell the caller whether the token was malformed, the signature
// was wrong, the row was missing, or the payload mismatched the row.
const GENERIC_AUTH_ERROR = 'Submission link is invalid or has expired.';

const BodySchema = z.object({
  token: z.string().min(1),
  action: z.enum(['submit', 'decline']),
  prices: z
    .array(
      z.object({
        lineItemId: z.string().uuid(),
        unitPrice: z.number().nonnegative().optional(),
        notes: z.string().max(1000).optional(),
      }),
    )
    .default([]),
});

interface VendorBidRow {
  id: string;
  bid_id: string;
  vendor_id: string;
  company_id: string;
  status: 'pending' | 'submitted' | 'partial' | 'declined' | 'expired';
}

interface BidRow {
  id: string;
  company_id: string;
  consolidation_mode: ConsolidationMode;
}

interface LineItemRow {
  id: string;
  quantity: number | string;
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 401 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // --- Body parse ---------------------------------------------------------
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message ?? 'Invalid request body' },
        { status: 400 },
      );
    }
    const { token, action, prices } = parsed.data;

    // --- Token verify -------------------------------------------------------
    const payload = verifyVendorBidToken(token);
    if (!payload) {
      console.warn('LMBR.ai vendor-submit: token failed signature/format/expiry check.');
      return unauthorized();
    }

    const admin = getSupabaseAdmin();

    // --- vendor_bids row lookup --------------------------------------------
    const { data: vbData, error: vbError } = await admin
      .from('vendor_bids')
      .select('id, bid_id, vendor_id, company_id, status')
      .eq('id', payload.vendorBidId)
      .maybeSingle();
    if (vbError) {
      console.warn(`LMBR.ai vendor-submit: vendor_bids lookup failed: ${vbError.message}`);
      return unauthorized();
    }
    const vendorBid = vbData as VendorBidRow | null;
    if (!vendorBid) {
      console.warn(`LMBR.ai vendor-submit: no vendor_bids row for id=${payload.vendorBidId}.`);
      return unauthorized();
    }

    // --- Cross-check token payload vs row ----------------------------------
    try {
      assertTokenMatchesVendorBid(payload, {
        id: vendorBid.id,
        bid_id: vendorBid.bid_id,
        vendor_id: vendorBid.vendor_id,
        company_id: vendorBid.company_id,
      });
    } catch (err) {
      if (err instanceof VendorTokenMismatchError) {
        console.warn(`LMBR.ai vendor-submit: ${err.message}`);
        return unauthorized();
      }
      throw err;
    }

    // --- Closed statuses ---------------------------------------------------
    if (vendorBid.status === 'expired') {
      return NextResponse.json(
        { error: 'This submission link has expired.' },
        { status: 409 },
      );
    }
    if (vendorBid.status === 'declined') {
      return NextResponse.json(
        { error: 'This submission has been declined and is closed.' },
        { status: 409 },
      );
    }

    // --- Bid row (for consolidation_mode) ----------------------------------
    const { data: bidData, error: bidError } = await admin
      .from('bids')
      .select('id, company_id, consolidation_mode')
      .eq('id', vendorBid.bid_id)
      .maybeSingle();
    if (bidError || !bidData) {
      console.warn(
        `LMBR.ai vendor-submit: bid lookup failed for id=${vendorBid.bid_id}: ${bidError?.message ?? 'not found'}.`,
      );
      return unauthorized();
    }
    const bid = bidData as BidRow;

    // --- Vendor-visible line_items ----------------------------------------
    const isConsolidated = vendorVisibleIsConsolidatedFlag(bid.consolidation_mode);
    const { data: linesData, error: linesError } = await admin
      .from('line_items')
      .select('id, quantity')
      .eq('bid_id', bid.id)
      .eq('company_id', vendorBid.company_id)
      .eq('is_consolidated', isConsolidated)
      .order('sort_order', { ascending: true });
    if (linesError) {
      console.warn(
        `LMBR.ai vendor-submit: line_items lookup failed: ${linesError.message}`,
      );
      return NextResponse.json(
        { error: 'Unable to load pricing request.' },
        { status: 500 },
      );
    }
    const lineRows = (linesData ?? []) as LineItemRow[];
    const expectedLineIds = new Set(lineRows.map((r) => r.id));
    const quantityByLineId = new Map<string, number>(
      lineRows.map((r) => [r.id, toNumber(r.quantity)]),
    );
    const expectedCount = lineRows.length;

    const nowIso = new Date().toISOString();

    // --- Decline branch ----------------------------------------------------
    if (action === 'decline') {
      const { error: delError } = await admin
        .from('vendor_bid_line_items')
        .delete()
        .eq('vendor_bid_id', vendorBid.id);
      if (delError) {
        console.warn(
          `LMBR.ai vendor-submit: failed to clear prices on decline: ${delError.message}`,
        );
        return NextResponse.json(
          { error: 'Unable to record decline.' },
          { status: 500 },
        );
      }

      const { error: updateError } = await admin
        .from('vendor_bids')
        .update({ status: 'declined', submitted_at: nowIso })
        .eq('id', vendorBid.id);
      if (updateError) {
        console.warn(
          `LMBR.ai vendor-submit: failed to flip status to declined: ${updateError.message}`,
        );
        return NextResponse.json(
          { error: 'Unable to record decline.' },
          { status: 500 },
        );
      }

      return NextResponse.json({
        success: true,
        status: 'declined' as const,
        pricedCount: 0,
        expectedCount,
      });
    }

    // --- Submit branch -----------------------------------------------------
    // Validate every incoming lineItemId is part of the expected set.
    for (const p of prices) {
      if (!expectedLineIds.has(p.lineItemId)) {
        return NextResponse.json(
          { error: `Line item ${p.lineItemId} is not part of this submission.` },
          { status: 400 },
        );
      }
    }

    // Partition incoming entries into (has price → upsert) vs (no price → delete).
    const toUpsert: Array<{
      company_id: string;
      vendor_bid_id: string;
      line_item_id: string;
      unit_price: number;
      total_price: number;
      notes: string | null;
    }> = [];
    const toDelete: string[] = [];

    for (const p of prices) {
      if (typeof p.unitPrice === 'number') {
        const qty = quantityByLineId.get(p.lineItemId) ?? 0;
        const total = p.unitPrice * qty;
        toUpsert.push({
          company_id: vendorBid.company_id,
          vendor_bid_id: vendorBid.id,
          line_item_id: p.lineItemId,
          unit_price: p.unitPrice,
          total_price: Number(total.toFixed(2)),
          notes: p.notes && p.notes.length > 0 ? p.notes : null,
        });
      } else {
        // No unit price → vendor cleared their number. Remove any existing row.
        toDelete.push(p.lineItemId);
      }
    }

    if (toUpsert.length > 0) {
      const { error: upsertError } = await admin
        .from('vendor_bid_line_items')
        .upsert(toUpsert, { onConflict: 'vendor_bid_id,line_item_id' });
      if (upsertError) {
        console.warn(
          `LMBR.ai vendor-submit: upsert failed: ${upsertError.message}`,
        );
        return NextResponse.json(
          { error: 'Unable to save pricing.' },
          { status: 500 },
        );
      }
    }

    if (toDelete.length > 0) {
      const { error: delError } = await admin
        .from('vendor_bid_line_items')
        .delete()
        .eq('vendor_bid_id', vendorBid.id)
        .in('line_item_id', toDelete);
      if (delError) {
        console.warn(
          `LMBR.ai vendor-submit: cleanup delete failed: ${delError.message}`,
        );
        return NextResponse.json(
          { error: 'Unable to save pricing.' },
          { status: 500 },
        );
      }
    }

    // Recompute authoritative priced count by reading back from the DB so
    // stale local math can't mislabel the row.
    const { data: pricedData, error: pricedError } = await admin
      .from('vendor_bid_line_items')
      .select('line_item_id, unit_price')
      .eq('vendor_bid_id', vendorBid.id)
      .not('unit_price', 'is', null);
    if (pricedError) {
      console.warn(
        `LMBR.ai vendor-submit: priced count query failed: ${pricedError.message}`,
      );
      return NextResponse.json(
        { error: 'Unable to finalize submission.' },
        { status: 500 },
      );
    }
    const pricedCount = (pricedData ?? []).length;
    const status: 'submitted' | 'partial' =
      pricedCount >= expectedCount && expectedCount > 0 ? 'submitted' : 'partial';

    const { error: statusError } = await admin
      .from('vendor_bids')
      .update({ status, submitted_at: nowIso })
      .eq('id', vendorBid.id);
    if (statusError) {
      console.warn(
        `LMBR.ai vendor-submit: status update failed: ${statusError.message}`,
      );
      return NextResponse.json(
        { error: 'Unable to finalize submission.' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      status,
      pricedCount,
      expectedCount,
    });
  } catch (err) {
    console.warn(
      `LMBR.ai vendor-submit: unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json(
      { error: 'An unexpected error occurred.' },
      { status: 500 },
    );
  }
}
