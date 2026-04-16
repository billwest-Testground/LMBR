/**
 * POST /api/vendors/dispatch — Fan a bid out to a selected vendor list.
 *
 * Purpose:  After routing (Prompt 03) the buyer hits "Dispatch" on a bid.
 *           For each (bid, vendor) pair we upsert a `vendor_bids` row,
 *           mint a stateless HMAC-signed submission token (Task 1), and
 *           hand the buyer UI back the URLs to show / print / email.
 *
 *           Re-dispatch is idempotent: if a (bid_id, vendor_id) row already
 *           exists we re-issue the token, refresh due_by + sent_at, and
 *           reset status to 'pending'. That vendor is reported under
 *           `dispatched`, not `skipped` — the operational intent is the
 *           same as a fresh dispatch.
 *
 *           Vendors that don't belong to the tenant go into `skipped` with
 *           a reason rather than failing the whole request, so a single
 *           racy delete doesn't block the rest of the fan-out.
 *
 * Inputs:   { bidId: uuid, vendorIds: uuid[], dueBy: ISO datetime,
 *             submissionMethod?: 'form' | 'scan' | 'email' }
 * Outputs:  { success, bidId, dispatched[], skipped[] }
 * Agent/API: Supabase + @lmbr/lib/vendor-token (no LLM).
 * Imports:  @lmbr/lib, @lmbr/types, zod, next/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { createVendorBidToken, getSupabaseAdmin } from '@lmbr/lib';
import { VendorSubmissionMethodSchema } from '@lmbr/types';

import { getSupabaseRouteHandlerClient } from '../../../../lib/supabase/server';

export const runtime = 'nodejs';

const BodySchema = z.object({
  bidId: z.string().uuid(),
  vendorIds: z.array(z.string().uuid()).min(1),
  dueBy: z.string().datetime(),
  submissionMethod: VendorSubmissionMethodSchema.optional(),
});

/** Bid statuses that allow vendor dispatch. 'routing' flips to 'quoting'. */
const DISPATCHABLE_STATUSES = new Set(['routing', 'quoting']);

/**
 * Grace buffer past `dueBy` so late scanned price sheets still validate.
 * Rationale: a mill might reply the morning after the deadline — the
 * buyer still wants that price in the comparison matrix.
 */
const TOKEN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

interface DispatchedEntry {
  vendorBidId: string;
  vendorId: string;
  vendorName: string;
  token: string;
  submitUrl: string;
  printUrl: string;
  tokenExpiresAt: string;
  status: 'pending';
}

interface SkippedEntry {
  vendorId: string;
  reason: string;
}

function buildSubmitUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '') ?? '';
  return `${base}/vendor-submit/${token}`;
}

function buildPrintUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '') ?? '';
  return `${base}/vendor-submit/${token}/print`;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = BodySchema.safeParse(await req.json());
    if (!body.success) {
      return NextResponse.json(
        { error: body.error.errors[0]?.message ?? 'Invalid request body' },
        { status: 400 },
      );
    }
    const { bidId, vendorIds, dueBy, submissionMethod = 'form' } = body.data;

    const dueByDate = new Date(dueBy);
    const now = new Date();
    if (dueByDate.getTime() <= now.getTime()) {
      return NextResponse.json(
        { error: 'dueBy must be in the future' },
        { status: 400 },
      );
    }

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

    const { data: bid, error: bidError } = await sessionClient
      .from('bids')
      .select('id, company_id, status')
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
    if (!DISPATCHABLE_STATUSES.has(bid.status)) {
      return NextResponse.json(
        { error: `Bid status is '${bid.status}' — dispatch requires 'routing' or 'quoting'` },
        { status: 409 },
      );
    }

    const admin = getSupabaseAdmin();

    const uniqueVendorIds = [...new Set(vendorIds)];
    const { data: vendorRows, error: vendorError } = await admin
      .from('vendors')
      .select('id, company_id, name, active')
      .in('id', uniqueVendorIds);
    if (vendorError) {
      return NextResponse.json({ error: vendorError.message }, { status: 500 });
    }

    const vendorById = new Map((vendorRows ?? []).map((v) => [v.id, v]));

    const { data: existingRows, error: existingError } = await admin
      .from('vendor_bids')
      .select('id, vendor_id')
      .eq('bid_id', bidId)
      .eq('company_id', profile.company_id)
      .in('vendor_id', uniqueVendorIds);
    if (existingError) {
      return NextResponse.json({ error: existingError.message }, { status: 500 });
    }
    const existingByVendor = new Map((existingRows ?? []).map((r) => [r.vendor_id, r.id]));

    const dispatched: DispatchedEntry[] = [];
    const skipped: SkippedEntry[] = [];

    const ttlMs = dueByDate.getTime() - now.getTime() + TOKEN_GRACE_MS;
    const tokenExpiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const sentAt = now.toISOString();

    for (const vendorId of uniqueVendorIds) {
      const vendor = vendorById.get(vendorId);
      if (!vendor) {
        skipped.push({ vendorId, reason: 'vendor_not_found' });
        continue;
      }
      if (vendor.company_id !== profile.company_id) {
        skipped.push({ vendorId, reason: 'vendor_different_company' });
        continue;
      }
      if (!vendor.active) {
        skipped.push({ vendorId, reason: 'vendor_inactive' });
        continue;
      }

      const existingId = existingByVendor.get(vendorId);

      let vendorBidId: string;
      if (existingId) {
        vendorBidId = existingId;
      } else {
        const { data: inserted, error: insertError } = await admin
          .from('vendor_bids')
          .insert({
            bid_id: bidId,
            vendor_id: vendorId,
            company_id: profile.company_id,
            status: 'pending',
            submission_method: submissionMethod,
            sent_at: sentAt,
            due_by: dueByDate.toISOString(),
          })
          .select('id')
          .single();
        if (insertError || !inserted) {
          skipped.push({
            vendorId,
            reason: `insert_failed: ${insertError?.message ?? 'no row returned'}`,
          });
          continue;
        }
        vendorBidId = inserted.id;
      }

      const token = createVendorBidToken(
        {
          vendorBidId,
          bidId,
          vendorId,
          companyId: profile.company_id,
        },
        ttlMs,
      );

      const { error: updateError } = await admin
        .from('vendor_bids')
        .update({
          token,
          token_expires_at: tokenExpiresAt,
          status: 'pending',
          submission_method: submissionMethod,
          sent_at: sentAt,
          due_by: dueByDate.toISOString(),
        })
        .eq('id', vendorBidId);
      if (updateError) {
        skipped.push({
          vendorId,
          reason: `token_update_failed: ${updateError.message}`,
        });
        continue;
      }

      dispatched.push({
        vendorBidId,
        vendorId,
        vendorName: vendor.name,
        token,
        submitUrl: buildSubmitUrl(token),
        printUrl: buildPrintUrl(token),
        tokenExpiresAt,
        status: 'pending',
      });
    }

    if (bid.status === 'routing' && dispatched.length > 0) {
      const { error: statusError } = await admin
        .from('bids')
        .update({ status: 'quoting' })
        .eq('id', bidId);
      if (statusError) {
        return NextResponse.json(
          { error: `Dispatched ${dispatched.length} vendors but failed to advance bid status: ${statusError.message}` },
          { status: 500 },
        );
      }
    }

    return NextResponse.json({
      success: true,
      bidId,
      dispatched,
      skipped,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Dispatch failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
