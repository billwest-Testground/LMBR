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
 *             - Allocates the next quote number via the `next_quote_number`
 *               RPC (migration 018) and formats as `${SLUG}-${00000}`.
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
  getSupabaseAdmin,
  type PdfConsolidationMode,
  type PdfPricedLineInput,
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

    const pricedLines: PdfPricedLineInput[] = qli
      .map((row): PdfPricedLineInput | null => {
        const li = liById.get(row.line_item_id as string);
        if (!li) return null;
        const unitRaw = li.unit as string;
        const unit: 'PCS' | 'MBF' | 'MSF' =
          unitRaw === 'MBF' || unitRaw === 'MSF' ? unitRaw : 'PCS';
        return {
          lineItemId: row.line_item_id as string,
          sortOrder: Number(row.sort_order ?? 0),
          buildingTag: (row.building_tag as string | null) ?? null,
          phaseNumber: (row.phase_number as number | null) ?? null,
          species: li.species as string,
          dimension: li.dimension as string,
          grade: (li.grade as string | null) ?? null,
          length: (li.length as string | null) ?? null,
          quantity: Number(li.quantity),
          unit,
          sellUnitPrice: Number(row.sell_price),
          extendedSell: Number(row.extended_sell),
        };
      })
      .filter((r): r is PdfPricedLineInput => r !== null);

    // --- Mint a quote number ----------------------------------------------
    // Preview uses the existing quote number (if any) or a PREVIEW marker
    // so we don't bump the sequence before the user actually releases.
    let quoteNumber: string;
    let allocatedSequence: number | null = null;
    if (action === 'release') {
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
    } else {
      quoteNumber = `${((company.slug as string) ?? 'LMBR').toUpperCase()}-PREVIEW`;
    }

    // --- Build PDF input + render -----------------------------------------
    const quoteDate = new Date();
    const validUntil = new Date(
      quoteDate.getTime() + VALIDITY_DAYS * 24 * 60 * 60 * 1000,
    );

    const pdfInput = buildQuotePdfInput({
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
      buffer = await renderQuotePdfBuffer(pdfInput);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Quote PDF render failed';
      return NextResponse.json({ error: message }, { status: 500 });
    }

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
      return new NextResponse(pdfBody, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${quoteNumber}.pdf"`,
          'Cache-Control': 'no-store',
        },
      });
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
