/**
 * POST /api/quote — Render + optionally release the customer quote PDF.
 *
 * Purpose:  Reads the latest persisted quote for a bid, rebuilds the
 *           vendor-structurally-free QuotePdfInput via
 *           @lmbr/lib/pdf-quote, renders the PDF via @react-pdf/renderer
 *           (apps/web/src/lib/pdf/quote-pdf.tsx), and either returns the
 *           bytes inline ('preview') or uploads to Supabase storage and
 *           flips quote.pdf_url ('release').
 *
 *           Role gating:
 *             - preview: trader | trader_buyer | manager | owner
 *               (traders need to preview their own output pre-send).
 *             - release: manager | owner only. This mirrors the
 *               migration 008 RLS policy — only managers can set the
 *               quote status to 'approved' / 'sent'.
 *
 *           Release semantics:
 *             - Gates on the freshly-read quote.status via canReleaseQuote:
 *               'pending_approval' and 'approved' are allowed; 'draft',
 *               'sent', 'accepted', 'declined' return 409. This prevents
 *               a manager from bypassing the pending_approval gate or
 *               silently overwriting a sent quote.
 *             - Unit sanity: if any quote_line_item carries a unit other
 *               than PCS/MBF/MSF, release fails with 422 'invalid_unit'
 *               (preview still renders but exposes offending line ids
 *               via the `X-Quote-Warnings` response header).
 *             - Renders twice: once with a placeholder quote number to
 *               prove the pipeline works, THEN allocates next_quote_number
 *               (migration 018), THEN re-renders with the real number.
 *               This keeps the customer-visible sequence gap-free even
 *               when a render fails — releases are infrequent so the
 *               extra render is cheap insurance.
 *             - Uploads to the `quotes` Supabase Storage bucket. The
 *               bucket must be provisioned out-of-band (Supabase CLI or
 *               dashboard); a missing bucket surfaces as a readable
 *               `storage_bucket_missing` error rather than a 500 stack.
 *             - Flips quote.pdf_url + quote.status='approved'. Prompt 08
 *               will flip to 'sent' after the Outlook send step.
 *
 * Inputs:   { bidId: uuid, action: 'preview' | 'release' }.
 * Outputs:  preview → 200 application/pdf stream (bytes)
 *           release → 200 { success, pdfUrl, quoteNumber }.
 * Agent/API: @lmbr/lib pdf-quote + apps/web/src/lib/pdf/quote-pdf.
 * Imports:  next/server, zod, @lmbr/lib, ../../../lib/supabase/server,
 *           ../../../lib/pdf/quote-pdf.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  buildQuotePdfInput,
  canReleaseQuote,
  getSupabaseAdmin,
  narrowPdfLineUnit,
  type PdfConsolidationMode,
  type PdfPricedLineInput,
  type QuoteStatus,
} from '@lmbr/lib';

import { renderQuotePdfBuffer } from '../../../lib/pdf/quote-pdf';
import { getSupabaseRouteHandlerClient } from '../../../lib/supabase/server';

export const runtime = 'nodejs';

const BodySchema = z.object({
  bidId: z.string().uuid(),
  action: z.enum(['preview', 'release']),
});

const PREVIEW_ROLES = new Set(['trader', 'trader_buyer', 'manager', 'owner']);
const RELEASE_ROLES = new Set(['manager', 'owner']);

/** Default PDF validity window — 7 days. */
const VALIDITY_DAYS = 7;

function formatQuoteNumber(companySlug: string, sequence: number): string {
  const prefix = companySlug.toUpperCase().slice(0, 12) || 'LMBR';
  return `${prefix}-${String(sequence).padStart(5, '0')}`;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message ?? 'Invalid request body' },
        { status: 400 },
      );
    }
    const { bidId, action } = parsed.data;

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

    const allowedRoles = action === 'release' ? RELEASE_ROLES : PREVIEW_ROLES;
    const hasAllowedRole = roles.some((r) => allowedRoles.has(r));
    if (!hasAllowedRole) {
      return NextResponse.json(
        {
          error:
            action === 'release'
              ? 'Release requires manager or owner role'
              : 'Quote preview requires trader-aligned role',
        },
        { status: 403 },
      );
    }

    // --- Load bid + company + latest quote in parallel ---------------------
    const [bidResult, companyResult, quoteResult] = await Promise.all([
      supabase
        .from('bids')
        .select(
          'id, company_id, customer_name, job_name, job_address, job_state, consolidation_mode',
        )
        .eq('id', bidId)
        .maybeSingle(),
      supabase
        .from('companies')
        .select('id, name, slug, email_domain')
        .eq('id', profile.company_id)
        .maybeSingle(),
      supabase
        .from('quotes')
        .select(
          'id, company_id, bid_id, status, subtotal, margin_percent, margin_dollars, lumber_tax, sales_tax, total, pdf_url',
        )
        .eq('bid_id', bidId)
        .eq('company_id', profile.company_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (bidResult.error) {
      return NextResponse.json({ error: bidResult.error.message }, { status: 500 });
    }
    if (companyResult.error) {
      return NextResponse.json(
        { error: companyResult.error.message },
        { status: 500 },
      );
    }
    if (quoteResult.error) {
      return NextResponse.json(
        { error: quoteResult.error.message },
        { status: 500 },
      );
    }
    const bid = bidResult.data;
    const company = companyResult.data;
    const quote = quoteResult.data;
    if (!bid) {
      return NextResponse.json({ error: 'Bid not found' }, { status: 404 });
    }
    if (bid.company_id !== profile.company_id) {
      return NextResponse.json(
        { error: 'Bid belongs to a different company' },
        { status: 403 },
      );
    }
    if (!company) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }
    if (!quote) {
      return NextResponse.json(
        {
          error:
            'No quote persisted for this bid yet — run /api/margin first',
        },
        { status: 409 },
      );
    }

    // --- Release-only: gate on the freshly-read status --------------------
    // We read `quotes` at the top so this is already the latest row. Re-
    // checking here (before any render / RPC / upload) prevents a manager
    // from bypassing pending_approval and also rejects post-send edits
    // cleanly instead of silently overwriting a 'sent' quote.
    if (action === 'release') {
      const gate = canReleaseQuote(quote.status as QuoteStatus);
      if (!gate.ok) {
        return NextResponse.json(
          { error: gate.error, message: gate.message },
          { status: 409 },
        );
      }
    }

    // --- Load quote_line_items (already vendor-name-free) -----------------
    const { data: qliRows, error: qliError } = await supabase
      .from('quote_line_items')
      .select(
        'id, line_item_id, sell_price, extended_sell, building_tag, phase_number, sort_order',
      )
      .eq('quote_id', quote.id)
      .eq('company_id', profile.company_id)
      .order('sort_order', { ascending: true });
    if (qliError) {
      return NextResponse.json({ error: qliError.message }, { status: 500 });
    }
    const qli = qliRows ?? [];

    // Join back to line_items for the species/dim/grade/length/unit/qty
    // that drive the description. We do NOT read cost_price or
    // vendor_bid_line_item_id — those are internal-only.
    const lineItemIds = [...new Set(qli.map((r) => r.line_item_id as string))];
    const { data: liRows, error: liError } =
      lineItemIds.length > 0
        ? await supabase
            .from('line_items')
            .select(
              'id, species, dimension, grade, length, quantity, unit',
            )
            .in('id', lineItemIds)
        : { data: [] as Array<Record<string, unknown>>, error: null };
    if (liError) {
      return NextResponse.json({ error: liError.message }, { status: 500 });
    }
    const liById = new Map(
      (liRows ?? []).map((r) => [r.id as string, r] as const),
    );

    // Track lines whose `unit` is unrecognized. On release we reject
    // (it would print a wrong UOM on a real customer PDF — a money
    // mistake). On preview we still render but surface the offending
    // line ids in a `warnings` field so the margin-stack UI can flag
    // them to the trader.
    const unitWarnings: string[] = [];
    const pricedLines: PdfPricedLineInput[] = qli
      .map((row): PdfPricedLineInput | null => {
        const li = liById.get(row.line_item_id as string);
        if (!li) return null;
        const unit = narrowPdfLineUnit(li.unit);
        const lineItemId = row.line_item_id as string;
        if (unit === null) {
          unitWarnings.push(lineItemId);
        }
        return {
          lineItemId,
          sortOrder: Number(row.sort_order ?? 0),
          buildingTag: (row.building_tag as string | null) ?? null,
          phaseNumber: (row.phase_number as number | null) ?? null,
          species: li.species as string,
          dimension: li.dimension as string,
          grade: (li.grade as string | null) ?? null,
          length: (li.length as string | null) ?? null,
          quantity: Number(li.quantity),
          // Preview still needs a renderable unit; fall back to PCS for
          // the preview path only. Release reaches the 422 below before
          // this value is ever shipped to a customer.
          unit: unit ?? 'PCS',
          sellUnitPrice: Number(row.sell_price),
          extendedSell: Number(row.extended_sell),
        };
      })
      .filter((r): r is PdfPricedLineInput => r !== null);

    if (action === 'release' && unitWarnings.length > 0) {
      return NextResponse.json(
        {
          error: 'invalid_unit',
          message: 'Line item has unsupported unit; check extraction output',
          lineItemIds: unitWarnings,
        },
        { status: 422 },
      );
    }

    // --- Build PDF input (quote number threaded in below) -----------------
    // Order of operations for release:
    //   1. Build input with a PLACEHOLDER quote number.
    //   2. Render once (proves the render pipeline works for THIS data
    //      and with THIS renderer — fonts, layout, etc.).
    //   3. THEN call next_quote_number so the sequence only bumps when we
    //      are confident we can produce a PDF. Rendering first and
    //      allocating second is a cheap insurance policy against visible
    //      gaps in the customer-facing sequence (ACME-01022, then skip
    //      01023, then 01024 would generate support tickets in prod).
    //   4. Re-render with the real quote number so the on-page "Quote #"
    //      matches the row we're about to write.
    //
    // Preview just uses a "-PREVIEW" marker — no sequence cost, single
    // render.
    const quoteDate = new Date();
    const validUntil = new Date(
      quoteDate.getTime() + VALIDITY_DAYS * 24 * 60 * 60 * 1000,
    );

    const placeholderQuoteNumber =
      action === 'release'
        ? `${((company.slug as string) ?? 'LMBR').toUpperCase()}-PENDING`
        : `${((company.slug as string) ?? 'LMBR').toUpperCase()}-PREVIEW`;

    const buildInput = (quoteNumber: string): ReturnType<typeof buildQuotePdfInput> =>
      buildQuotePdfInput({
        pricedLines,
        totals: {
          lumberTax: Number(quote.lumber_tax),
          salesTax: Number(quote.sales_tax),
          grandTotal: Number(quote.total),
        },
        bid: {
          customerName: (bid.customer_name as string) ?? '',
          jobName: (bid.job_name as string | null) ?? null,
          jobAddress: (bid.job_address as string | null) ?? null,
          jobState: (bid.job_state as string | null) ?? null,
          consolidationMode:
            ((bid.consolidation_mode as PdfConsolidationMode) ?? 'structured'),
        },
        company: {
          name: (company.name as string) ?? 'LMBR.ai',
          slug: (company.slug as string) ?? 'lmbr',
          emailDomain: (company.email_domain as string | null) ?? null,
        },
        quoteNumber,
        quoteDate,
        validUntil,
      });

    let buffer: Buffer;
    try {
      buffer = await renderQuotePdfBuffer(buildInput(placeholderQuoteNumber));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Quote PDF render failed';
      return NextResponse.json({ error: message }, { status: 500 });
    }

    // For preview the placeholder-rendered buffer IS the final output.
    let quoteNumber: string = placeholderQuoteNumber;
    let allocatedSequence: number | null = null;

    // --- Preview: return PDF bytes inline ---------------------------------
    if (action === 'preview') {
      // Recent @types/node made Buffer (and Uint8Array) generic over
      // their underlying ArrayBuffer, which the DOM BlobPart / BodyInit
      // unions no longer accept directly. `.slice()` on the underlying
      // buffer returns a plain ArrayBuffer which IS a BlobPart. The
      // copy is small and pays once per request. Same approach as the
      // /vendor-submit/[token]/print route.
      const pdfArrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer;
      const pdfBody = new Blob([pdfArrayBuffer], { type: 'application/pdf' });
      const headers: Record<string, string> = {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${quoteNumber}.pdf"`,
        'Cache-Control': 'no-store',
      };
      if (unitWarnings.length > 0) {
        // Preview keeps the PDF body (trader still wants to see the
        // rendered output) but exposes the list of bad-unit line ids
        // via a header. The margin-stack UI reads this and surfaces
        // the affected rows so the trader can fix the extraction
        // before attempting a release (which would now 422).
        headers['X-Quote-Warnings'] = JSON.stringify({
          invalidUnitLineItemIds: unitWarnings,
        });
      }
      return new NextResponse(pdfBody, { status: 200, headers });
    }

    // --- Release: allocate number AFTER render, then re-render -----------
    // Rendering the placeholder buffer above proved the pipeline works
    // for this data. Only now do we bump the quote sequence; if the RPC
    // fails we haven't consumed a number and haven't uploaded anything.
    const { data: seqData, error: seqError } = await supabase.rpc(
      'next_quote_number',
      { p_company_id: profile.company_id },
    );
    if (seqError) {
      return NextResponse.json(
        { error: `Quote number allocation failed: ${seqError.message}` },
        { status: 500 },
      );
    }
    allocatedSequence = Number(seqData);
    quoteNumber = formatQuoteNumber(
      (company.slug as string) ?? '',
      allocatedSequence,
    );

    // Re-render with the real quote number so the on-page "Quote #"
    // matches the `quotes` row + storage path we're about to write. The
    // extra render costs ~100ms and only happens on release, which is
    // infrequent by definition.
    try {
      buffer = await renderQuotePdfBuffer(buildInput(quoteNumber));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Quote PDF render failed';
      return NextResponse.json({ error: message }, { status: 500 });
    }

    // --- Release: upload to Storage + flip pdf_url + status ---------------
    const admin = getSupabaseAdmin();
    const storagePath = `${profile.company_id}/${bidId}/${quoteNumber}.pdf`;
    const { error: uploadError } = await admin.storage
      .from('quotes')
      .upload(storagePath, buffer, {
        contentType: 'application/pdf',
        upsert: true,
      });
    if (uploadError) {
      // Common case: the bucket hasn't been created yet. Surface a
      // readable error so the ops team knows exactly what to fix.
      const missingBucket =
        /bucket/i.test(uploadError.message) &&
        /not found|does not exist/i.test(uploadError.message);
      return NextResponse.json(
        {
          error: missingBucket
            ? 'storage_bucket_missing: create the `quotes` Supabase Storage bucket'
            : `Quote upload failed: ${uploadError.message}`,
        },
        { status: 500 },
      );
    }

    // Sign a URL with a long TTL so the customer can open it from email.
    // 30 days matches the longest quote validity we support today.
    const { data: signed, error: signError } = await admin.storage
      .from('quotes')
      .createSignedUrl(storagePath, 60 * 60 * 24 * 30);
    if (signError) {
      return NextResponse.json(
        { error: `Quote sign URL failed: ${signError.message}` },
        { status: 500 },
      );
    }
    const pdfUrl = signed.signedUrl;

    const { error: quoteUpdateError } = await admin
      .from('quotes')
      .update({
        pdf_url: pdfUrl,
        status: 'approved',
        approved_by: session.user.id,
        approved_at: new Date().toISOString(),
      })
      .eq('id', quote.id);
    if (quoteUpdateError) {
      return NextResponse.json(
        { error: `Quote row update failed: ${quoteUpdateError.message}` },
        { status: 500 },
      );
    }

    // Advance the bid into 'approved' — Prompt 08 will flip to 'sent'
    // after the Outlook hand-off.
    await admin.from('bids').update({ status: 'approved' }).eq('id', bidId);

    return NextResponse.json({
      success: true,
      pdfUrl,
      quoteNumber,
      sequence: allocatedSequence,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Quote failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
