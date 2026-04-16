/**
 * /api/manager/approvals — manager/owner approval queue + verdict.
 *
 * Purpose:  GET returns every quote with status=pending_approval for the
 *           caller's company, joined to bid + trader meta so the manager
 *           dashboard can show customer / job / trader / total / blended
 *           margin / submitted-at / action in a single table. POST posts
 *           a verdict: approve flips status → 'approved' + stamps
 *           approved_by/approved_at; request_changes flips back to
 *           'draft' so the buyer can iterate; reject flips to 'declined'.
 *
 *           Manager/Owner only. RLS on public.quotes enforces the write
 *           side (only managers can set 'approved'); we redundantly
 *           gate here so we return clean 403s instead of surfacing
 *           Postgres policy errors to the UI.
 *
 *           Notes textbox / approval_notes column is deferred to
 *           Prompt 08 (email-body). Today request_changes simply flips
 *           the status; the buyer will see the re-opened margin stack.
 *
 * Inputs:   GET: session only. POST: { quoteId, action, notes? }.
 * Outputs:  GET: { items: [...] }. POST: { success, quote }.
 * Agent/API: none.
 * Imports:  next/server, zod, @lmbr/lib, ../../../../lib/supabase/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getSupabaseAdmin } from '@lmbr/lib';

import { getSupabaseRouteHandlerClient } from '../../../../lib/supabase/server';

export const runtime = 'nodejs';

const MANAGER_ROLES = new Set(['manager', 'owner']);

const PostBodySchema = z.object({
  quoteId: z.string().uuid(),
  action: z.enum(['approve', 'request_changes', 'reject']),
  notes: z.string().max(2000).optional(),
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
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
    const profile = profileResult.data;
    if (!profile?.company_id) {
      return NextResponse.json(
        { error: 'User profile not found' },
        { status: 403 },
      );
    }
    const roles = (rolesResult.data ?? []).map((r) => r.role_type as string);
    if (!roles.some((r) => MANAGER_ROLES.has(r))) {
      return NextResponse.json(
        { error: 'Manager or owner role required' },
        { status: 403 },
      );
    }

    // --- Load pending quotes for the company ------------------------------
    const { data: quotes, error: quotesError } = await supabase
      .from('quotes')
      .select(
        'id, bid_id, total, margin_percent, created_by, created_at, updated_at',
      )
      .eq('company_id', profile.company_id)
      .eq('status', 'pending_approval')
      .order('created_at', { ascending: false });
    if (quotesError) {
      return NextResponse.json(
        { error: quotesError.message },
        { status: 500 },
      );
    }

    const quoteRows = quotes ?? [];
    if (quoteRows.length === 0) {
      return NextResponse.json({ items: [] });
    }

    const bidIds = [...new Set(quoteRows.map((q) => q.bid_id as string))];
    const traderIds = [
      ...new Set(quoteRows.map((q) => q.created_by as string)),
    ];

    const [bidsResult, tradersResult] = await Promise.all([
      supabase
        .from('bids')
        .select('id, customer_name, job_name, due_date')
        .in('id', bidIds),
      supabase
        .from('users')
        .select('id, full_name, email')
        .in('id', traderIds),
    ]);
    const bidById = new Map(
      (bidsResult.data ?? []).map((b) => [b.id as string, b] as const),
    );
    const traderById = new Map(
      (tradersResult.data ?? []).map((u) => [u.id as string, u] as const),
    );

    const items = quoteRows.map((q) => {
      const bid = bidById.get(q.bid_id as string);
      const trader = traderById.get(q.created_by as string);
      return {
        quoteId: q.id as string,
        bidId: q.bid_id as string,
        customer: (bid?.customer_name as string | null) ?? 'Unknown customer',
        jobName: (bid?.job_name as string | null) ?? null,
        dueDate: (bid?.due_date as string | null) ?? null,
        trader:
          (trader?.full_name as string | null) ??
          (trader?.email as string | null) ??
          'Unknown trader',
        total: Number(q.total),
        blendedMarginPercent: Number(q.margin_percent),
        submittedAt: (q.updated_at as string) ?? (q.created_at as string),
      };
    });

    return NextResponse.json({ items });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Approval list failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const parsed = PostBodySchema.safeParse(raw);
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
    const profile = profileResult.data;
    if (!profile?.company_id) {
      return NextResponse.json(
        { error: 'User profile not found' },
        { status: 403 },
      );
    }
    const roles = (rolesResult.data ?? []).map((r) => r.role_type as string);
    if (!roles.some((r) => MANAGER_ROLES.has(r))) {
      return NextResponse.json(
        { error: 'Manager or owner role required' },
        { status: 403 },
      );
    }

    // --- Verify quote exists + tenant match -------------------------------
    const { data: quote, error: quoteError } = await supabase
      .from('quotes')
      .select('id, company_id, status, bid_id')
      .eq('id', parsed.data.quoteId)
      .maybeSingle();
    if (quoteError) {
      return NextResponse.json({ error: quoteError.message }, { status: 500 });
    }
    if (!quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
    }
    if (quote.company_id !== profile.company_id) {
      return NextResponse.json(
        { error: 'Quote belongs to a different company' },
        { status: 403 },
      );
    }

    // --- Apply verdict ----------------------------------------------------
    // SECURITY: this admin client bypasses RLS on quotes.approved_by /
    // approved_at / status. The manual manager/owner role check at lines
    // 181-202 above (session lookup + roles query + MANAGER_ROLES guard)
    // plus the tenant check at lines 205-221 (company_id match) are the
    // ONLY gates protecting these writes. DO NOT move or remove those
    // checks without adding an equivalent server-side guard here. See
    // migration 008 (quotes_update policy) for the RLS clause we're
    // intentionally sidestepping — service role bypasses it by design
    // and we enforce the equivalent logic in TypeScript above.
    const admin = getSupabaseAdmin();
    const payload: Record<string, unknown> = {};
    if (parsed.data.action === 'approve') {
      payload.status = 'approved';
      payload.approved_by = session.user.id;
      payload.approved_at = new Date().toISOString();
    } else if (parsed.data.action === 'request_changes') {
      // Drop back to draft; buyer re-edits margin stack. Approval-notes
      // column is deferred to Prompt 08 along with email hand-off.
      payload.status = 'draft';
      payload.approved_by = null;
      payload.approved_at = null;
    } else {
      payload.status = 'declined';
      payload.approved_by = session.user.id;
      payload.approved_at = new Date().toISOString();
    }

    const { data: updated, error: updateError } = await admin
      .from('quotes')
      .update(payload)
      .eq('id', parsed.data.quoteId)
      .select('id, status, approved_by, approved_at, total')
      .single();
    if (updateError) {
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 },
      );
    }

    // Keep bid status in sync so the trader's dashboard reflects the
    // verdict. Non-fatal if this fails.
    if (parsed.data.action === 'approve') {
      const { error: bidErr } = await admin
        .from('bids')
        .update({ status: 'approved' })
        .eq('id', quote.bid_id as string);
      if (bidErr) {
        console.warn(
          `[approvals] bid status advance failed for ${quote.bid_id as string}: ${bidErr.message}`,
        );
      }
    } else if (parsed.data.action === 'request_changes') {
      const { error: bidErr } = await admin
        .from('bids')
        .update({ status: 'pricing' })
        .eq('id', quote.bid_id as string);
      if (bidErr) {
        console.warn(
          `[approvals] bid status revert failed for ${quote.bid_id as string}: ${bidErr.message}`,
        );
      }
    }

    return NextResponse.json({ success: true, quote: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Approval update failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
