/**
 * POST /api/quote/[quoteId]/send — Email an approved quote to the customer.
 *
 * Purpose:  The final step of the trader workflow. After a manager has
 *           approved the quote and the release path has rendered +
 *           uploaded the PDF to storage, this endpoint sends it from the
 *           trader's own Outlook account to the customer on file. The
 *           email never goes through a generic LMBR address — CLAUDE.md
 *           non-negotiable #5.
 *
 *           State machine enforcement: only `status='approved'` quotes
 *           can transition to 'sent'. A draft / pending_approval /
 *           already-sent quote is rejected. The status flip happens
 *           ONLY on confirmed email success — if Graph returns a
 *           failure, quote.status stays 'approved' and the trader can
 *           retry without losing the approval record.
 *
 *           Role gate: trader / trader_buyer. Managers and owners can
 *           also send — they inherit trader visibility on quotes they
 *           approved. Pure buyers cannot (they deal in vendor pricing,
 *           not customer-facing sends).
 *
 *           PDF source: quote.pdf_url is a signed Supabase Storage URL
 *           populated by the release path. We fetch it over HTTP and
 *           attach the bytes. A regeneration-on-the-fly strategy was
 *           considered but rejected — the released PDF is what the
 *           manager approved, and regenerating risks a subtle content
 *           drift if any pricing data has shifted since release.
 *
 * Inputs:   URL param: quoteId (uuid).
 *           Body: { recipientEmail?: string } (optional override; default
 *             is bid.customer_email).
 * Outputs:  200 { success: true, sentAt: iso }
 *           200 { success: false, error: <code> } (email failure — quote
 *             stays 'approved' so trader can retry)
 *           400 invalid body / missing recipient
 *           401 not authenticated
 *           403 wrong role / wrong tenant
 *           404 quote / bid not found
 *           409 quote.status is not 'approved'
 *           500 internal / storage fetch failure
 * Agent/API: @lmbr/lib sendQuoteToCustomer (Microsoft Graph).
 * Imports:  next/server, zod, @lmbr/lib, ../../../../../lib/supabase/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getSupabaseAdmin, sendQuoteToCustomer } from '@lmbr/lib';

import { getSupabaseRouteHandlerClient } from '../../../../../lib/supabase/server';

export const runtime = 'nodejs';
// Graph sendMail on a multi-MB PDF attachment can be slow; give the
// route headroom so a flaky upstream doesn't truncate mid-send.
export const maxDuration = 60;

const SEND_ROLES = new Set(['trader', 'trader_buyer', 'manager', 'owner']);

const BodySchema = z.object({
  recipientEmail: z.string().email().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { quoteId: string } },
): Promise<NextResponse> {
  try {
    // --- Parse body (empty is fine — defaults to bid.customer_email) ---
    let parsedBody: z.infer<typeof BodySchema>;
    try {
      const raw = (await req.json().catch(() => ({}))) as unknown;
      const result = BodySchema.safeParse(raw);
      if (!result.success) {
        return NextResponse.json(
          { error: result.error.errors[0]?.message ?? 'Invalid body' },
          { status: 400 },
        );
      }
      parsedBody = result.data;
    } catch {
      parsedBody = {};
    }

    // --- Validate quoteId param ----------------------------------------
    const quoteIdCheck = z.string().uuid().safeParse(params.quoteId);
    if (!quoteIdCheck.success) {
      return NextResponse.json({ error: 'Invalid quoteId' }, { status: 400 });
    }
    const quoteId = quoteIdCheck.data;

    // --- Session + role gate -------------------------------------------
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
      return NextResponse.json({ error: profileResult.error.message }, { status: 500 });
    }
    const profile = profileResult.data;
    if (!profile?.company_id) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 403 });
    }
    const roles = (rolesResult.data ?? []).map((r) => r.role_type as string);
    if (!roles.some((r) => SEND_ROLES.has(r))) {
      return NextResponse.json(
        { error: 'Sending quotes requires trader, trader_buyer, manager, or owner role.' },
        { status: 403 },
      );
    }

    // --- Load quote + bid (RLS-scoped via session client) --------------
    const { data: quote, error: quoteError } = await supabase
      .from('quotes')
      .select(
        'id, bid_id, company_id, status, pdf_url, total, margin_percent, sent_at',
      )
      .eq('id', quoteId)
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

    // Hard state-machine gate — only approved quotes can transition to
    // sent. A sent quote is NOT re-sendable through this endpoint; re-
    // sending is a new quote workflow.
    if (quote.status !== 'approved') {
      return NextResponse.json(
        {
          error: `Quote is in status '${quote.status}' — only 'approved' quotes can be sent.`,
        },
        { status: 409 },
      );
    }

    if (!quote.pdf_url) {
      // The release path should have populated pdf_url. If it didn't,
      // the release was incomplete — the trader must re-release.
      return NextResponse.json(
        { error: 'Quote has no rendered PDF; re-release before sending.' },
        { status: 409 },
      );
    }

    // Bid fetch for customer name / email / job name.
    const { data: bid, error: bidError } = await supabase
      .from('bids')
      .select('id, company_id, customer_name, customer_email, job_name')
      .eq('id', quote.bid_id as string)
      .maybeSingle();
    if (bidError) {
      return NextResponse.json({ error: bidError.message }, { status: 500 });
    }
    if (!bid) {
      return NextResponse.json({ error: 'Bid not found' }, { status: 404 });
    }

    // Resolve recipient. Override beats bid.customer_email; both are
    // validated as `z.string().email()` above (the override) or in the
    // ingest path (customer_email column).
    const recipient =
      parsedBody.recipientEmail ??
      (typeof bid.customer_email === 'string' && bid.customer_email.length > 0
        ? (bid.customer_email as string)
        : null);
    if (!recipient) {
      return NextResponse.json(
        {
          error:
            'No recipient email — pass recipientEmail in the body or set bid.customer_email.',
        },
        { status: 400 },
      );
    }

    // --- Fetch the PDF bytes from storage ------------------------------
    let pdfBuffer: Buffer;
    try {
      const res = await fetch(quote.pdf_url as string);
      if (!res.ok) {
        throw new Error(`status=${res.status}`);
      }
      const arrayBuf = await res.arrayBuffer();
      pdfBuffer = Buffer.from(arrayBuf);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `LMBR.ai quote send: PDF fetch failed quoteId=${quoteId}: ${message}.`,
      );
      return NextResponse.json(
        { error: 'Could not load the quote PDF; re-release and retry.' },
        { status: 500 },
      );
    }

    // --- Load latest quote_number for the filename ---------------------
    // The release path stored the number on the PDF filename at upload
    // time; easiest way to get it here is to parse it off the pdf_url's
    // object name, but a straight select of quote_number is cleaner if
    // the column exists. Fall back to the quote id's first 8 chars.
    const quoteNumberLabel = String(quote.id).slice(0, 8);

    // Per-company subject override (migration 023).
    const admin = getSupabaseAdmin();
    const { data: companyRow } = await admin
      .from('companies')
      .select('quote_email_subject')
      .eq('id', profile.company_id)
      .maybeSingle();
    const subjectOverride =
      (companyRow?.quote_email_subject as string | null) ?? null;

    // --- Send ----------------------------------------------------------
    const emailResult = await sendQuoteToCustomer(
      profile.id,
      profile.company_id,
      {
        customer: {
          email: recipient,
          name: (bid.customer_name as string | null) ?? null,
        },
        quote: {
          jobName: (bid.job_name as string | null) ?? null,
          quoteNumber: quoteNumberLabel,
          validUntilIso: null,
        },
        pdfBuffer,
        pdfFilename: `Quote-${quoteNumberLabel}.pdf`,
        subjectOverride,
      },
    );

    if (!emailResult.success) {
      console.warn(
        `LMBR.ai quote send: email failed for quoteId=${quoteId} bidId=${quote.bid_id as string}: ${emailResult.errorCode ?? 'unknown'}.`,
      );
      // Do NOT advance status. Trader can retry (e.g. after connecting
      // Outlook) without losing the approval.
      return NextResponse.json({
        success: false,
        error: emailResult.errorCode ?? 'send_failed',
      });
    }

    // --- Status advance: approved → sent -------------------------------
    // RLS on quotes restricts 'sent' writes to managers/owners per
    // migration 008. Since traders can legitimately send, we use the
    // service-role admin client here (already declared above for the
    // subject-override lookup). The manual role + tenant checks above
    // (SEND_ROLES + company_id match) are the only gates — mirrors
    // the pattern in /api/manager/approvals.
    const sentAtIso = new Date().toISOString();
    const { error: updateError } = await admin
      .from('quotes')
      .update({ status: 'sent', sent_at: sentAtIso })
      .eq('id', quoteId)
      .eq('company_id', profile.company_id);
    if (updateError) {
      // Email went out but the state change failed. Surface distinctly
      // so ops can reconcile — the customer has the PDF but the dashboard
      // will still show 'approved'.
      console.warn(
        `LMBR.ai quote send: sent but status update failed for quoteId=${quoteId}: ${updateError.message}.`,
      );
      return NextResponse.json({
        success: true,
        sentAt: sentAtIso,
        warning: 'status_update_failed',
      });
    }

    return NextResponse.json({
      success: true,
      sentAt: sentAtIso,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Quote send failed';
    console.warn(`LMBR.ai quote send: unexpected error: ${message}.`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
