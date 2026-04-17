/**
 * POST /api/vendors/nudge — Reminder email to a dispatched vendor.
 *
 * Purpose:  The buyer's status board surfaces a "Nudge" button on every
 *           `vendor_bids` row so they can prod a quiet vendor without
 *           leaving the page. This route authenticates the user, proves
 *           tenant access to the vendor_bid row, and sends a follow-up
 *           email from the buyer's own Outlook account (CLAUDE.md rule
 *           #5 — emails never come from a generic LMBR address).
 *
 *           Email failure is surfaced in the response, never thrown.
 *           `error` is the short-code from OutlookMailErrorCode when
 *           available — UI branches on 'outlook_not_connected' to show
 *           the "connect your Outlook" prompt rather than a generic
 *           retry banner.
 *
 * Inputs:   { vendorBidId: uuid }
 * Outputs:  { success: boolean, error: string | null }
 * Agent/API: Microsoft Graph via @lmbr/lib/outlook.
 * Imports:  zod, next/server, Supabase session client, @lmbr/lib.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getSupabaseAdmin, sendVendorNudge } from '@lmbr/lib';

import { getSupabaseRouteHandlerClient } from '../../../../lib/supabase/server';

export const runtime = 'nodejs';

const BodySchema = z.object({
  vendorBidId: z.string().uuid(),
});

function buildSubmitUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '') ?? '';
  return `${base}/vendor-submit/${token}`;
}

function hoursBetween(nowMs: number, laterMs: number): number {
  return Math.max(0, Math.round((laterMs - nowMs) / (60 * 60 * 1000)));
}

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

    // Role gate — nudging vendors is a buyer-aligned action.
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
      .select('id, bid_id, vendor_id, company_id, token, due_by, status')
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
    if (vendorBid.status === 'declined' || vendorBid.status === 'expired') {
      // Nothing to nudge — the row is closed. Surface without send attempt.
      return NextResponse.json({
        success: false,
        error: 'vendor_bid_closed',
      });
    }
    if (!vendorBid.token) {
      // Pre-Prompt-05 vendor_bids rows don't have tokens. Can't nudge
      // without a submission link; surface as a no-op with a code the UI
      // can show as "re-dispatch needed".
      return NextResponse.json({
        success: false,
        error: 'no_token_on_row',
      });
    }

    // Load bid + vendor (service role — we already own the tenant check
    // via RLS on vendor_bids above; this is a faster path than routing
    // another RLS query and lets us read vendor.email cleanly).
    const admin = getSupabaseAdmin();
    const [bidResult, vendorResult] = await Promise.all([
      admin
        .from('bids')
        .select('id, company_id, job_name, customer_name')
        .eq('id', vendorBid.bid_id as string)
        .maybeSingle(),
      admin
        .from('vendors')
        .select('id, company_id, name, email')
        .eq('id', vendorBid.vendor_id as string)
        .maybeSingle(),
    ]);

    const bid = bidResult.data;
    const vendor = vendorResult.data;
    if (!bid || bid.company_id !== profile.company_id) {
      return NextResponse.json({ error: 'Bid not found' }, { status: 404 });
    }
    if (!vendor || vendor.company_id !== profile.company_id) {
      return NextResponse.json({ error: 'Vendor not found' }, { status: 404 });
    }
    if (!vendor.email) {
      return NextResponse.json({
        success: false,
        error: 'no_vendor_email',
      });
    }

    const dueByMs = vendorBid.due_by
      ? new Date(vendorBid.due_by as string).getTime()
      : Date.now();
    const hoursRemaining = hoursBetween(Date.now(), dueByMs);
    const formUrl = buildSubmitUrl(vendorBid.token as string);

    const result = await sendVendorNudge(profile.id, profile.company_id, {
      vendor: { name: vendor.name as string, email: vendor.email as string },
      bid: {
        jobName: (bid.job_name as string | null) ?? null,
        customerName: (bid.customer_name as string | null) ?? null,
        dueByIso: vendorBid.due_by
          ? (vendorBid.due_by as string)
          : new Date().toISOString(),
      },
      hoursRemaining,
      formUrl,
    });

    if (!result.success) {
      console.warn(
        `LMBR.ai nudge: email failed for vendorBidId=${vendorBidId} bidId=${bid.id}: ${result.errorCode ?? 'unknown'}.`,
      );
    }

    return NextResponse.json({
      success: result.success,
      error: result.success ? null : (result.errorCode ?? 'send_failed'),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Nudge failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
