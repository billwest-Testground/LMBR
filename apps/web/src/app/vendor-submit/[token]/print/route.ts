/**
 * GET /vendor-submit/[token]/print — Printable PDF tally for paper-workflow vendors.
 *
 * Purpose:  Serves the PDF counterpart to the sibling /vendor-submit/[token]
 *           form page. Both routes authenticate identically via the HMAC-
 *           signed token in the URL — web form and PDF are two renderings
 *           of the same vendor_bids row. A vendor who prefers paper prints
 *           this PDF, hand-writes prices in the blank Unit Price / Notes
 *           boxes, then scans or faxes it back; Task 5's scan-back OCR
 *           reads the token printed at the footer to re-attach the prices
 *           to the correct row.
 *
 *           Error-response discipline mirrors POST /api/vendor-submit:
 *             • Any auth-style failure (bad signature, expired token,
 *               missing vendor_bids row, token/row id mismatch) →
 *               plain-text 401 "Link invalid or expired." No HTML error
 *               page, no leaked structure. Specifics logged via
 *               console.warn for ops.
 *             • Status 'expired' | 'declined' → plain-text 409
 *               "Submission link is closed." Matches POST.
 *             • Any unexpected render/runtime error → plain-text 500.
 *
 *           Runtime is pinned to 'nodejs' because @react-pdf/renderer's
 *           renderToBuffer is not Edge-compatible.
 *
 * Inputs:   URL path param `token` (HMAC-signed).
 * Outputs:  application/pdf binary body with Content-Disposition:
 *           attachment; filename="lmbr-bid-<short>-<vendor-slug>.pdf".
 * Agent/API: getSupabaseAdmin (service role), verifyVendorBidToken,
 *            assertTokenMatchesVendorBid, vendorVisibleIsConsolidatedFlag.
 * Imports:  @lmbr/lib, @lmbr/types, next/server, our vendor-tally-pdf component.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  assertTokenMatchesVendorBid,
  getSupabaseAdmin,
  toNumber,
  vendorVisibleIsConsolidatedFlag,
  VendorTokenMismatchError,
  verifyVendorBidToken,
} from '@lmbr/lib';
import type { ConsolidationMode } from '@lmbr/types';

import renderVendorTallyPdf, {
  vendorTallyFilenameSlug,
  type VendorTallyPdfLine,
} from '../../../../components/vendors/vendor-tally-pdf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Row types (local — identical shape to the sibling page.tsx)
// ---------------------------------------------------------------------------

interface VendorBidRow {
  id: string;
  bid_id: string;
  vendor_id: string;
  company_id: string;
  status: 'pending' | 'submitted' | 'partial' | 'declined' | 'expired';
  due_by: string | null;
}

interface BidRow {
  id: string;
  company_id: string;
  customer_name: string;
  job_name: string | null;
  job_address: string | null;
  due_date: string | null;
  consolidation_mode: ConsolidationMode;
}

interface VendorRow {
  id: string;
  name: string;
}

interface CompanyRow {
  id: string;
  name: string;
}

interface LineItemRow {
  id: string;
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number | string;
  unit: string;
  board_feet: number | string | null;
  sort_order: number;
}

// ---------------------------------------------------------------------------
// Generic error helpers — plain text only; don't leak PDF structure.
// ---------------------------------------------------------------------------

function unauthorized(): NextResponse {
  return new NextResponse('Link invalid or expired.', {
    status: 401,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function closed(): NextResponse {
  return new NextResponse('Submission link is closed.', {
    status: 409,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function serverError(): NextResponse {
  return new NextResponse('Unable to generate PDF.', {
    status: 500,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function buildSubmitUrl(req: NextRequest, token: string): string {
  // Prefer the canonical app URL from env so the printed submit URL
  // matches the URL the vendor originally received in their dispatch
  // email (e.g. https://app.lmbr.ai) — NOT whatever Host header was used
  // to reach this route (could be a preview domain or an internal proxy).
  // Fall back to the request origin only if the env is unset.
  const envBase = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '');
  const base = envBase && envBase.length > 0 ? envBase : req.nextUrl.origin;
  return `${base}/vendor-submit/${token}`;
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

interface RouteContext {
  params: { token: string };
}

export async function GET(
  req: NextRequest,
  { params }: RouteContext,
): Promise<NextResponse> {
  try {
    const token = params.token;
    if (!token) {
      return unauthorized();
    }

    // --- Token signature/format/expiry check -------------------------------
    const payload = verifyVendorBidToken(token);
    if (!payload) {
      console.warn(
        'LMBR.ai vendor-submit/print: token failed signature/format/expiry check.',
      );
      return unauthorized();
    }

    const admin = getSupabaseAdmin();

    // --- vendor_bids row ---------------------------------------------------
    const { data: vbData, error: vbError } = await admin
      .from('vendor_bids')
      .select('id, bid_id, vendor_id, company_id, status, due_by')
      .eq('id', payload.vendorBidId)
      .maybeSingle();
    if (vbError) {
      console.warn(
        `LMBR.ai vendor-submit/print: vendor_bids lookup failed: ${vbError.message}`,
      );
      return unauthorized();
    }
    const vendorBid = vbData as VendorBidRow | null;
    if (!vendorBid) {
      console.warn(
        `LMBR.ai vendor-submit/print: no vendor_bids row for id=${payload.vendorBidId}.`,
      );
      return unauthorized();
    }

    // --- Token payload ↔ row cross-check -----------------------------------
    try {
      assertTokenMatchesVendorBid(payload, {
        id: vendorBid.id,
        bid_id: vendorBid.bid_id,
        vendor_id: vendorBid.vendor_id,
        company_id: vendorBid.company_id,
      });
    } catch (err) {
      if (err instanceof VendorTokenMismatchError) {
        console.warn(`LMBR.ai vendor-submit/print: ${err.message}`);
        return unauthorized();
      }
      throw err;
    }

    // --- Reject closed statuses (symmetry with POST /api/vendor-submit) ---
    if (vendorBid.status === 'expired' || vendorBid.status === 'declined') {
      console.warn(
        `LMBR.ai vendor-submit/print: GET rejected because vendor_bids.status='${vendorBid.status}' (id=${vendorBid.id}).`,
      );
      return closed();
    }

    // --- Related rows (bid, vendor, company) in parallel -------------------
    const [{ data: bidRowRaw }, { data: vendorRowRaw }, { data: companyRowRaw }] =
      await Promise.all([
        admin
          .from('bids')
          .select(
            'id, company_id, customer_name, job_name, job_address, due_date, consolidation_mode',
          )
          .eq('id', vendorBid.bid_id)
          .maybeSingle(),
        admin
          .from('vendors')
          .select('id, name')
          .eq('id', vendorBid.vendor_id)
          .maybeSingle(),
        admin
          .from('companies')
          .select('id, name')
          .eq('id', vendorBid.company_id)
          .maybeSingle(),
      ]);

    const bid = bidRowRaw as BidRow | null;
    const vendor = vendorRowRaw as VendorRow | null;
    const company = companyRowRaw as CompanyRow | null;

    if (!bid || !vendor || !company) {
      console.warn(
        `LMBR.ai vendor-submit/print: missing related row (bid=${!!bid} vendor=${!!vendor} company=${!!company}).`,
      );
      return unauthorized();
    }

    // --- Vendor-visible line items ----------------------------------------
    const isConsolidated = vendorVisibleIsConsolidatedFlag(bid.consolidation_mode);
    const { data: linesRaw, error: linesError } = await admin
      .from('line_items')
      .select(
        'id, species, dimension, grade, length, quantity, unit, board_feet, sort_order',
      )
      .eq('bid_id', bid.id)
      .eq('company_id', bid.company_id)
      .eq('is_consolidated', isConsolidated)
      .order('sort_order', { ascending: true });
    if (linesError) {
      console.warn(
        `LMBR.ai vendor-submit/print: line_items lookup failed: ${linesError.message}`,
      );
      return serverError();
    }
    const lineRows = (linesRaw ?? []) as LineItemRow[];

    const lineItems: VendorTallyPdfLine[] = lineRows.map((r) => ({
      sortOrder: r.sort_order,
      species: r.species,
      dimension: r.dimension,
      grade: r.grade,
      length: r.length,
      quantity: toNumber(r.quantity),
      unit: r.unit,
      boardFeet: r.board_feet == null ? null : toNumber(r.board_feet),
    }));

    // --- Render PDF --------------------------------------------------------
    const submitUrl = buildSubmitUrl(req, token);
    const pdfBuffer = await renderVendorTallyPdf({
      companyName: company.name,
      vendorName: vendor.name,
      bidId: bid.id,
      customerName: bid.customer_name,
      jobName: bid.job_name,
      jobAddress: bid.job_address,
      dueBy: vendorBid.due_by ?? bid.due_date,
      lineItems,
      token,
      submitUrl,
      generatedAt: new Date().toISOString(),
    });

    // --- Response ----------------------------------------------------------
    const shortBid = bid.id.split('-')[0] ?? bid.id.slice(0, 8);
    const vendorSlug = vendorTallyFilenameSlug(vendor.name);
    const filename = `lmbr-bid-${shortBid}-${vendorSlug}.pdf`;

    // Recent @types/node made Buffer (and Uint8Array) generic over their
    // underlying ArrayBuffer (Uint8Array<ArrayBufferLike>), which the DOM
    // BlobPart / BodyInit unions (sourced from lib.dom.d.ts) no longer
    // accept directly in TS 5.9. `.slice()` on a Buffer's underlying buffer
    // returns a plain ArrayBuffer (non-generic) which IS a BlobPart. The
    // copy is small (a few hundred KB for a typical tally) and only pays
    // once per request; far simpler than piping Node streams into Web
    // ReadableStream.
    const pdfArrayBuffer = pdfBuffer.buffer.slice(
      pdfBuffer.byteOffset,
      pdfBuffer.byteOffset + pdfBuffer.byteLength,
    ) as ArrayBuffer;
    const pdfBody = new Blob([pdfArrayBuffer], { type: 'application/pdf' });

    return new NextResponse(pdfBody, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        // Do not cache — token-scoped, and bids can be re-dispatched.
        'Cache-Control': 'private, no-store, max-age=0',
      },
    });
  } catch (err) {
    console.warn(
      `LMBR.ai vendor-submit/print: unexpected error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return serverError();
  }
}
