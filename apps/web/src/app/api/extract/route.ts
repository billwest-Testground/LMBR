/**
 * POST /api/extract — Public vendor scan-back price extraction.
 *
 * Purpose:  Closes the paper workflow loop for vendors who printed the
 *           Task 4 tally PDF, hand-wrote prices, and scanned the sheet
 *           back. The token printed at the PDF footer is the only
 *           authentication — same token the sibling POST /api/vendor-submit
 *           accepts for the typed-form path. Both endpoints lead to the
 *           same vendor_bid_line_items upsert; they differ only in how
 *           the prices got there (form fields vs OCR + Haiku matcher).
 *
 *           Flow (on a valid token):
 *             1. Parse multipart/form-data. Validate file type + size.
 *             2. Verify token → fetch vendor_bids row → assert match.
 *             3. Reject closed statuses ('expired' | 'declined') with
 *                a generic 409; reject other failures with a generic 401.
 *                Same error-opacity discipline as /api/vendor-submit —
 *                never leak which token, vendor, bid, or company the
 *                probe touched.
 *             4. Load vendor-visible line_items (consolidated vs
 *                originals, per vendorVisibleIsConsolidatedFlag).
 *             5. OCR the uploaded file via Azure Document Intelligence.
 *             6. Call scanbackAgent (Haiku tool_use) with OCR text +
 *                expected lines — returns per-line matches, unmatched
 *                IDs, and extra rows.
 *             7. Upsert priced matches into vendor_bid_line_items with
 *                server-computed total_price; delete any prior priced
 *                row for a line_item_id that came back as unmatched
 *                (a re-upload with a cleared price removes the old one).
 *             8. Recompute pricedCount from the DB, reject if 0.
 *             9. Flip vendor_bids.status to 'submitted' (all lines) or
 *                'partial' (some), set submitted_at=now and
 *                submission_method='scan' so the vendor-status board
 *                shows the paper path was used.
 *            10. Fire-and-forget: record OCR + scanback-agent cost to
 *                extraction_costs so the manager dashboard shows the
 *                true cost of this RFQ.
 *
 *           Model policy: scanbackAgent pins Haiku per CLAUDE.md's
 *           Model Split. This route does not set any model explicitly.
 *
 *           File retention note: raw_response_url stays null. Object
 *           storage for scanned images is not in scope for Prompt 05;
 *           that lands alongside the Outlook integration work (Prompt 08).
 *
 * Inputs:   multipart/form-data { token: string, file: File }.
 * Outputs:  200 { success, status, pricedCount, expectedCount,
 *                 unmatchedLineItemIds[], extractionCostCents,
 *                 ocrConfidence }
 *           400 | 401 | 409 | 413 | 415 | 500 { error }
 * Agent/API: Azure Document Intelligence + @lmbr/agents scanbackAgent
 *            (Claude Haiku). Supabase service-role client for writes.
 * Imports:  @lmbr/lib, @lmbr/agents, next/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { scanbackAgent, type ScanbackExpectedLine } from '@lmbr/agents';
import {
  analyzeDocument,
  assertTokenMatchesVendorBid,
  getSupabaseAdmin,
  OcrError,
  recordExtraction,
  toNumber,
  vendorVisibleIsConsolidatedFlag,
  VendorTokenMismatchError,
  verifyVendorBidToken,
} from '@lmbr/lib';
import type { ConsolidationMode } from '@lmbr/types';

export const runtime = 'nodejs';
// Azure OCR poll + Haiku call can take 20-40s end to end on a photographed
// multi-page PDF. Bump maxDuration so we don't truncate mid-extraction.
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Same generic error vocabulary used by /api/vendor-submit. Identical
// strings on purpose — the two endpoints must not be distinguishable by
// their error bodies, or the scan-back route becomes an oracle for the
// form-path one.
const GENERIC_AUTH_ERROR = 'Submission link is invalid or has expired.';
const GENERIC_CLOSED_ERROR = 'This submission link is closed.';

// File validation. 25 MB cutoff matches typical phone-camera JPEG sizes
// and multi-page scanned PDFs; anything bigger is very likely a user
// mistake (raw DSLR photo, embedded RAW image).
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/jpg', // some browsers/cameras report this non-standard variant
  'image/webp',
  'application/pdf',
]);

// ---------------------------------------------------------------------------
// Row types (same shape as /api/vendor-submit)
// ---------------------------------------------------------------------------

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
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number | string;
  unit: string;
  sort_order: number;
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 401 });
}

function closedLink(): NextResponse {
  return NextResponse.json({ error: GENERIC_CLOSED_ERROR }, { status: 409 });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // --- Content type gate -------------------------------------------------
    const contentType = req.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return NextResponse.json(
        { error: 'Expected multipart/form-data.' },
        { status: 415 },
      );
    }

    // --- Parse form --------------------------------------------------------
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: 'Invalid form body.' }, { status: 400 });
    }

    const tokenRaw = form.get('token');
    if (typeof tokenRaw !== 'string' || tokenRaw.length === 0) {
      return NextResponse.json({ error: 'No token provided.' }, { status: 400 });
    }

    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: 'File is too large. Maximum size is 25 MB.' },
        { status: 413 },
      );
    }
    const mimeType = (file.type || '').toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return NextResponse.json(
        {
          error:
            'Unsupported file type. Upload a PNG, JPEG, WEBP image, or PDF.',
        },
        { status: 415 },
      );
    }

    // --- Token verify ------------------------------------------------------
    const payload = verifyVendorBidToken(tokenRaw);
    if (!payload) {
      console.warn('LMBR.ai extract: token failed signature/format/expiry check.');
      return unauthorized();
    }

    const admin = getSupabaseAdmin();

    // --- vendor_bids row lookup -------------------------------------------
    const { data: vbData, error: vbError } = await admin
      .from('vendor_bids')
      .select('id, bid_id, vendor_id, company_id, status')
      .eq('id', payload.vendorBidId)
      .maybeSingle();
    if (vbError) {
      console.warn(`LMBR.ai extract: vendor_bids lookup failed: ${vbError.message}`);
      return unauthorized();
    }
    const vendorBid = vbData as VendorBidRow | null;
    if (!vendorBid) {
      console.warn(
        `LMBR.ai extract: no vendor_bids row for id=${payload.vendorBidId}.`,
      );
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
        console.warn(`LMBR.ai extract: ${err.message}`);
        return unauthorized();
      }
      throw err;
    }

    // --- Closed-status gate ------------------------------------------------
    if (vendorBid.status === 'expired' || vendorBid.status === 'declined') {
      console.warn(
        `LMBR.ai extract: rejected because vendor_bids.status='${vendorBid.status}' (id=${vendorBid.id}).`,
      );
      return closedLink();
    }

    // --- Bid row (for consolidation_mode) ---------------------------------
    const { data: bidData, error: bidError } = await admin
      .from('bids')
      .select('id, company_id, consolidation_mode')
      .eq('id', vendorBid.bid_id)
      .maybeSingle();
    if (bidError || !bidData) {
      console.warn(
        `LMBR.ai extract: bid lookup failed for id=${vendorBid.bid_id}: ${bidError?.message ?? 'not found'}.`,
      );
      return unauthorized();
    }
    const bid = bidData as BidRow;

    // --- Vendor-visible line_items ----------------------------------------
    const isConsolidated = vendorVisibleIsConsolidatedFlag(bid.consolidation_mode);
    const { data: linesData, error: linesError } = await admin
      .from('line_items')
      .select(
        'id, species, dimension, grade, length, quantity, unit, sort_order',
      )
      .eq('bid_id', bid.id)
      .eq('company_id', vendorBid.company_id)
      .eq('is_consolidated', isConsolidated)
      .order('sort_order', { ascending: true });
    if (linesError) {
      console.warn(
        `LMBR.ai extract: line_items lookup failed: ${linesError.message}`,
      );
      return NextResponse.json(
        { error: 'Unable to load pricing request.' },
        { status: 500 },
      );
    }
    const lineRows = (linesData ?? []) as LineItemRow[];
    const expectedCount = lineRows.length;
    if (expectedCount === 0) {
      // Nothing to price. Same generic error shape as the form path.
      return NextResponse.json(
        { error: 'This submission has no priceable lines.' },
        { status: 400 },
      );
    }
    const quantityByLineId = new Map<string, number>(
      lineRows.map((r) => [r.id, toNumber(r.quantity)]),
    );

    // --- OCR the uploaded file --------------------------------------------
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    let ocrText = '';
    let ocrPages = 0;
    let ocrConfidence = 0;
    let ocrCostCents = 0;
    try {
      const ocr = await analyzeDocument(buffer, mimeType);
      ocrText = ocr.text;
      ocrPages = ocr.pages;
      ocrConfidence = ocr.confidence;
      ocrCostCents = ocr.costCents;
    } catch (err) {
      if (err instanceof OcrError) {
        console.warn(`LMBR.ai extract: OCR failed: ${err.message}`);
        return NextResponse.json(
          { error: 'Extraction failed.' },
          { status: 500 },
        );
      }
      throw err;
    }

    // --- Build expected lines for the agent -------------------------------
    const expectedLines: ScanbackExpectedLine[] = lineRows.map((r) => ({
      lineItemId: r.id,
      sortOrder: r.sort_order,
      species: r.species,
      dimension: r.dimension,
      grade: r.grade,
      length: r.length,
      quantity: toNumber(r.quantity),
      unit: r.unit,
    }));

    // --- Run the scan-back agent ------------------------------------------
    const scanResult = await scanbackAgent({
      ocrText,
      ocrConfidence,
      expectedLines,
      companyId: vendorBid.company_id,
    });

    // --- Partition matches: upsert priced, delete cleared -----------------
    const nowIso = new Date().toISOString();

    const toUpsert: Array<{
      company_id: string;
      vendor_bid_id: string;
      line_item_id: string;
      unit_price: number;
      total_price: number;
      notes: string | null;
    }> = [];
    const toDelete: string[] = [];

    for (const match of scanResult.matchedLines) {
      if (match.unitPrice == null) {
        // Line didn't get a confident price. If there's an old priced row
        // for this line from a prior scan/form submission, remove it so
        // the user isn't silently left with stale data.
        toDelete.push(match.lineItemId);
        continue;
      }
      const qty = quantityByLineId.get(match.lineItemId) ?? 0;
      const total = match.unitPrice * qty;
      toUpsert.push({
        company_id: vendorBid.company_id,
        vendor_bid_id: vendorBid.id,
        line_item_id: match.lineItemId,
        unit_price: match.unitPrice,
        total_price: Number(total.toFixed(2)),
        notes: match.notes,
      });
    }

    if (toUpsert.length > 0) {
      const { error: upsertError } = await admin
        .from('vendor_bid_line_items')
        .upsert(toUpsert, { onConflict: 'vendor_bid_id,line_item_id' });
      if (upsertError) {
        console.warn(
          `LMBR.ai extract: upsert failed: ${upsertError.message}`,
        );
        return NextResponse.json(
          { error: 'Unable to save pricing.' },
          { status: 500 },
        );
      }
    }

    if (toDelete.length > 0) {
      // Delete only priced rows — rows without a unit_price are
      // effectively untouched placeholders and don't need cleanup.
      const { error: delError } = await admin
        .from('vendor_bid_line_items')
        .delete()
        .eq('vendor_bid_id', vendorBid.id)
        .in('line_item_id', toDelete)
        .not('unit_price', 'is', null);
      if (delError) {
        console.warn(
          `LMBR.ai extract: cleanup delete failed: ${delError.message}`,
        );
        return NextResponse.json(
          { error: 'Unable to save pricing.' },
          { status: 500 },
        );
      }
    }

    // --- Re-read priced count authoritatively from the DB -----------------
    const { data: pricedData, error: pricedError } = await admin
      .from('vendor_bid_line_items')
      .select('line_item_id, unit_price')
      .eq('vendor_bid_id', vendorBid.id)
      .not('unit_price', 'is', null);
    if (pricedError) {
      console.warn(
        `LMBR.ai extract: priced count query failed: ${pricedError.message}`,
      );
      return NextResponse.json(
        { error: 'Unable to finalize submission.' },
        { status: 500 },
      );
    }
    const pricedCount = (pricedData ?? []).length;

    if (pricedCount === 0) {
      // Same rule as /api/vendor-submit: a submit that produced zero
      // priced rows is a data-quality lie. Leave the row untouched so
      // the vendor can re-upload a cleaner scan.
      return NextResponse.json(
        {
          error:
            'Scan-back produced no matched prices — please verify the image is legible or use the web form.',
        },
        { status: 400 },
      );
    }

    const status: 'submitted' | 'partial' =
      pricedCount >= expectedCount && expectedCount > 0 ? 'submitted' : 'partial';

    const { error: statusError } = await admin
      .from('vendor_bids')
      .update({
        status,
        submitted_at: nowIso,
        // Paper path — record the method for the vendor-status board and
        // for downstream analytics. raw_response_url stays null; file
        // retention lives in Prompt 08 integration.
        submission_method: 'scan',
      })
      .eq('id', vendorBid.id);
    if (statusError) {
      console.warn(
        `LMBR.ai extract: status update failed: ${statusError.message}`,
      );
      return NextResponse.json(
        { error: 'Unable to finalize submission.' },
        { status: 500 },
      );
    }

    // --- Fire-and-forget cost ledger --------------------------------------
    // Recorded as two rows so the manager dashboard can separate OCR spend
    // from AI spend. The agent's costCents is Haiku; OCR is the Azure layer
    // cost. Neither blocks the response — recordExtraction swallows errors.
    void recordExtraction({
      bidId: vendorBid.bid_id,
      companyId: vendorBid.company_id,
      method: 'ocr',
      costCents: ocrCostCents,
    });
    if (scanResult.costCents > 0) {
      void recordExtraction({
        bidId: vendorBid.bid_id,
        companyId: vendorBid.company_id,
        method: 'qa_llm',
        costCents: scanResult.costCents,
      });
    }

    const extractionCostCents =
      Math.round((ocrCostCents + scanResult.costCents) * 10000) / 10000;

    return NextResponse.json({
      success: true,
      status,
      pricedCount,
      expectedCount,
      unmatchedLineItemIds: scanResult.unmatchedExpectedIds,
      extractionCostCents,
      ocrConfidence,
      ocrPages,
    });
  } catch (err) {
    console.warn(
      `LMBR.ai extract: unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json(
      { error: 'Extraction failed.' },
      { status: 500 },
    );
  }
}
