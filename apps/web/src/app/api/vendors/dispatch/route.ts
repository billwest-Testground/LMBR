/**
 * POST /api/vendors/dispatch — Fan a bid out to a selected vendor list.
 *
 * Purpose:  After routing (Prompt 03) the buyer hits "Dispatch" on a bid.
 *           For each (bid, vendor) pair we upsert a `vendor_bids` row in a
 *           single atomic write — minting a stateless HMAC-signed submission
 *           token (Task 1) on the pre-chosen row id — and hand the buyer UI
 *           back the URLs to show / print / email.
 *
 *           Atomicity matters: writing the token together with the row in
 *           one statement means a partial failure can never leave a
 *           tokenless row behind, and two concurrent dispatches to the same
 *           (bid, vendor) pair both end up reporting `dispatched` (last
 *           writer wins on the (bid_id, vendor_id) unique constraint).
 *
 *           Re-dispatch is idempotent: if a (bid_id, vendor_id) row already
 *           exists we re-issue the token, refresh due_by + sent_at, and
 *           reset status to 'pending'. That vendor is reported under
 *           `dispatched`, not `skipped` — the operational intent is the
 *           same as a fresh dispatch.
 *
 *           Vendors that the tenant cannot use (unknown id, cross-tenant
 *           id, or inactive) go into `skipped` with a non-leaky reason.
 *           Unknown and cross-tenant are collapsed into `vendor_not_found`
 *           at the wire so the endpoint cannot be used to probe foreign
 *           tenants' vendor UUIDs.
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

import { randomUUID } from 'crypto';

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
    const expiresAtMs = now.getTime() + ttlMs;
    const tokenExpiresAt = new Date(expiresAtMs).toISOString();
    const sentAt = now.toISOString();
    const dueByIso = dueByDate.toISOString();

    for (const vendorId of uniqueVendorIds) {
      const vendor = vendorById.get(vendorId);
      // Collapse "not in the returned set" and "belongs to another tenant"
      // into a single client-visible reason so the API cannot be used to
      // probe whether a given UUID exists in another company's vendor list.
      if (!vendor) {
        skipped.push({ vendorId, reason: 'vendor_not_found' });
        continue;
      }
      if (vendor.company_id !== profile.company_id) {
        console.warn(
          `LMBR.ai dispatch: vendor ${vendorId} belongs to a different company; reporting as vendor_not_found.`,
        );
        skipped.push({ vendorId, reason: 'vendor_not_found' });
        continue;
      }
      if (!vendor.active) {
        skipped.push({ vendorId, reason: 'vendor_inactive' });
        continue;
      }

      // Reuse the existing row's id when present so the token payload stays
      // stable across re-dispatch; otherwise mint a fresh UUID up-front so
      // we can sign the token and write the row in a single atomic upsert.
      const existingId = existingByVendor.get(vendorId);
      const vendorBidId = existingId ?? randomUUID();

      const token = createVendorBidToken(
        {
          vendorBidId,
          bidId,
          vendorId,
          companyId: profile.company_id,
        },
        ttlMs,
        expiresAtMs,
      );

      const { error: upsertError } = await admin
        .from('vendor_bids')
        .upsert(
          {
            id: vendorBidId,
            bid_id: bidId,
            vendor_id: vendorId,
            company_id: profile.company_id,
            status: 'pending',
            submission_method: submissionMethod,
            token,
            token_expires_at: tokenExpiresAt,
            sent_at: sentAt,
            due_by: dueByIso,
          },
          { onConflict: 'bid_id,vendor_id' },
        );
      if (upsertError) {
        skipped.push({
          vendorId,
          reason: `upsert_failed: ${upsertError.message}`,
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
