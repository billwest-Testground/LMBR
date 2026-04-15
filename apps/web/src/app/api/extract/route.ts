/**
 * POST /api/extract — Vendor scan-back price extraction.
 *
 * Purpose:  Vendor side of the tiered ingest engine. When a vendor
 *           responds by printing the fillable bid sheet, writing prices
 *           on it, and faxing or photographing it back, this route
 *           turns the image back into structured prices. It is NOT a
 *           full list extractor — the line item schema is already known
 *           from the vendor_bid_line_items rows we created when the
 *           buyer dispatched the bid. All we need is to read the unit
 *           price next to each line.
 *
 *           Pipeline:
 *             1. Auth + parse multipart { vendor_bid_id, file }.
 *             2. Look up the vendor_bid_line_items for this vendor_bid
 *                so we know exactly which line_items Claude is matching
 *                prices against.
 *             3. OCR the uploaded file via Azure Document Intelligence.
 *             4. Ask Claude Haiku (cheap model — the schema is already
 *                fixed, so this is narrow matching work, not extraction)
 *                to match each known line item to a price in the OCR
 *                text. Claude returns per-line { unit_price, notes }
 *                or null if it can't find a confident match.
 *             5. Update vendor_bid_line_items.unit_price for each
 *                matched line. The is_best_price trigger will recompute
 *                the cheapest-per-line flag automatically.
 *             6. Return a per-line report so the buyer UI can highlight
 *                which lines were matched and which need manual entry.
 *
 *           Model is Haiku because matching known line items to prices
 *           in OCR text is structurally easier than cold extraction —
 *           no normalization, no building groups, no building headers
 *           to preserve. Sonnet is overkill and 3× the cost per call.
 *
 * Inputs:   multipart/form-data { vendor_bid_id: uuid, file: File }.
 * Outputs:  200 { vendor_bid_id, matches[], ocr_pages, total_cost_cents,
 *           applied_count }.
 *           4xx / 5xx { error }.
 * Agent/API: Azure Document Intelligence (OCR) + Claude Haiku.
 * Imports:  @lmbr/lib (analyzeDocument, getAnthropic, getSupabaseAdmin,
 *           recordExtraction, OcrError), zod, next/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  analyzeDocument,
  getAnthropic,
  getSupabaseAdmin,
  OcrError,
  recordExtraction,
} from '@lmbr/lib';

import { getSupabaseRouteHandlerClient } from '../../../lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

const VendorBidIdSchema = z.string().uuid();

const QA_EXTRACT_MODEL = 'claude-haiku-4-5-20251001';

/** Same pricing constants the QA-agent Haiku pass uses. */
const HAIKU_INPUT_CENTS_PER_MTOK = 100; // $1 / Mtok
const HAIKU_OUTPUT_CENTS_PER_MTOK = 500; // $5 / Mtok

// -----------------------------------------------------------------------------
// Route handler
// -----------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const supabase = getSupabaseRouteHandlerClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('id, company_id')
      .eq('id', session.user.id)
      .maybeSingle();
    if (profileError) {
      return NextResponse.json({ error: profileError.message }, { status: 500 });
    }
    if (!profile?.company_id) {
      return NextResponse.json(
        { error: 'Finish onboarding before extracting prices.' },
        { status: 400 },
      );
    }

    const contentType = req.headers.get('content-type') ?? '';
    if (!contentType.startsWith('multipart/form-data')) {
      return NextResponse.json(
        { error: 'Expected multipart/form-data.' },
        { status: 415 },
      );
    }

    const form = await req.formData();
    const vendorBidIdRaw = form.get('vendor_bid_id');
    if (typeof vendorBidIdRaw !== 'string') {
      return NextResponse.json(
        { error: 'vendor_bid_id is required.' },
        { status: 400 },
      );
    }
    const vendorBidIdParse = VendorBidIdSchema.safeParse(vendorBidIdRaw);
    if (!vendorBidIdParse.success) {
      return NextResponse.json(
        { error: 'vendor_bid_id must be a UUID.' },
        { status: 400 },
      );
    }
    const vendorBidId = vendorBidIdParse.data;

    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'file is required.' },
        { status: 400 },
      );
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || 'application/octet-stream';

    // Pull the vendor bid + its line items so we know the schema Claude
    // is matching against. Use the session-scoped client so RLS applies.
    const { data: vendorBid, error: vbError } = await supabase
      .from('vendor_bids')
      .select('id, company_id, bid_id, vendor_id')
      .eq('id', vendorBidId)
      .maybeSingle();
    if (vbError || !vendorBid) {
      return NextResponse.json(
        { error: vbError?.message ?? 'vendor_bid not found' },
        { status: 404 },
      );
    }
    if (vendorBid.company_id !== profile.company_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { data: vbli, error: vbliError } = await supabase
      .from('vendor_bid_line_items')
      .select(
        'id, line_item_id, line_items(species, dimension, grade, length, quantity, unit)',
      )
      .eq('vendor_bid_id', vendorBidId);
    if (vbliError) {
      return NextResponse.json({ error: vbliError.message }, { status: 500 });
    }
    const rows = vbli ?? [];
    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'This vendor bid has no line items to match against.' },
        { status: 400 },
      );
    }

    // ------- OCR the file -------
    let ocrText: string;
    let ocrPages: number;
    let ocrCostCents: number;
    try {
      const ocr = await analyzeDocument(buffer, mimeType);
      ocrText = ocr.text;
      ocrPages = ocr.pages;
      ocrCostCents = ocr.costCents;
    } catch (err) {
      if (err instanceof OcrError) {
        return NextResponse.json(
          { error: `OCR failed: ${err.message}` },
          { status: 502 },
        );
      }
      throw err;
    }

    // ------- Haiku price matcher -------
    const matchResult = await matchPricesWithHaiku({
      ocrText,
      rows: rows.map((row) => ({
        vbli_id: row.id as string,
        line: row.line_items as unknown as {
          species?: string;
          dimension?: string;
          grade?: string | null;
          length?: string | null;
          quantity?: number;
          unit?: string;
        },
      })),
    });

    // ------- Persist matched prices -------
    // Service-role client because the RLS write policy on
    // vendor_bid_line_items gates trader access; the orchestrator acts
    // on behalf of the authenticated buyer.
    const admin = getSupabaseAdmin();
    const applied: Array<{ vbli_id: string; unit_price: number }> = [];
    for (const match of matchResult.matches) {
      if (match.unit_price == null) continue;
      const { error: updateError } = await admin
        .from('vendor_bid_line_items')
        .update({
          unit_price: match.unit_price,
          notes: match.note ?? null,
        })
        .eq('id', match.vbli_id)
        .eq('vendor_bid_id', vendorBidId);
      if (!updateError) {
        applied.push({ vbli_id: match.vbli_id, unit_price: match.unit_price });
      }
    }

    // Fire-and-forget ledger rows. Group scan-back spend with the parent
    // bid so the manager dashboard shows the full cost of ingesting +
    // pricing a single RFQ in one place.
    const totalCost = ocrCostCents + matchResult.haikuCostCents;
    await recordExtraction({
      bidId: vendorBid.bid_id as string,
      companyId: profile.company_id,
      method: 'ocr',
      costCents: ocrCostCents,
    });
    if (matchResult.haikuCostCents > 0) {
      await recordExtraction({
        bidId: vendorBid.bid_id as string,
        companyId: profile.company_id,
        method: 'qa_llm',
        costCents: matchResult.haikuCostCents,
      });
    }

    return NextResponse.json(
      {
        vendor_bid_id: vendorBidId,
        ocr_pages: ocrPages,
        total_cost_cents: round4(totalCost),
        matches: matchResult.matches,
        applied_count: applied.length,
      },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Extract failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// -----------------------------------------------------------------------------
// Haiku price matcher
// -----------------------------------------------------------------------------

interface MatcherInput {
  ocrText: string;
  rows: Array<{
    vbli_id: string;
    line: {
      species?: string;
      dimension?: string;
      grade?: string | null;
      length?: string | null;
      quantity?: number;
      unit?: string;
    };
  }>;
}

interface MatcherMatch {
  vbli_id: string;
  unit_price: number | null;
  note: string | null;
}

interface MatcherResult {
  matches: MatcherMatch[];
  haikuCostCents: number;
}

const PRICE_TOOL = {
  name: 'match_vendor_prices',
  description:
    'Emit one result per known line item. unit_price is null when no confident match was found.',
  input_schema: {
    type: 'object' as const,
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            vbli_id: { type: 'string' },
            unit_price: { type: ['number', 'null'] },
            note: { type: ['string', 'null'] },
          },
          required: ['vbli_id', 'unit_price', 'note'],
        },
      },
    },
    required: ['matches'],
  },
};

const PRICE_SYSTEM_PROMPT = `You are a vendor price-sheet matcher. You will receive:
- A list of line items (with vbli_id, species, dimension, grade, length, quantity, unit) that a buyer sent to a vendor.
- The OCR text of the vendor's filled-out / scanned price sheet.

Your job: for each line item, find the unit price the vendor wrote next to it on their sheet. Return one match object per line item. Use null for unit_price if you can't find a confident match — do NOT guess. Include a short note ONLY when you have a useful caveat (e.g. "ambiguous — two possible prices", "annotated 'per MBF'"), otherwise return null.

Output only via the match_vendor_prices tool, one call, with matches.length equal to the number of line items supplied.`;

async function matchPricesWithHaiku(input: MatcherInput): Promise<MatcherResult> {
  if (input.rows.length === 0) {
    return { matches: [], haikuCostCents: 0 };
  }

  const anthropic = getAnthropic();

  const rowLines = input.rows.map((row, idx) => {
    const line = row.line;
    return `  ${idx + 1}. vbli_id=${row.vbli_id} — ${line.quantity ?? '?'} ${line.unit ?? ''} ${line.dimension ?? ''} ${line.species ?? ''} ${line.grade ?? ''} ${line.length ?? ''}`
      .replace(/\s+/g, ' ')
      .trim();
  });

  const userText = [
    'Line items to price (in the order you must return them):',
    ...rowLines,
    '',
    '--- vendor OCR text ---',
    input.ocrText.slice(0, 8_000),
    '--- end OCR text ---',
  ].join('\n');

  const response = await anthropic.messages.create({
    model: QA_EXTRACT_MODEL,
    max_tokens: 1024,
    system: PRICE_SYSTEM_PROMPT,
    tools: [PRICE_TOOL] as never,
    tool_choice: { type: 'tool', name: PRICE_TOOL.name } as never,
    messages: [{ role: 'user', content: userText }],
  });

  const usage = response.usage;
  const haikuCostCents = usage
    ? (usage.input_tokens / 1_000_000) * HAIKU_INPUT_CENTS_PER_MTOK +
      (usage.output_tokens / 1_000_000) * HAIKU_OUTPUT_CENTS_PER_MTOK
    : 0;

  type ResponseBlock =
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'text'; text: string }
    | { type: string; [key: string]: unknown };

  const blocks = (response.content ?? []) as ResponseBlock[];
  const toolUse = blocks.find(
    (b): b is Extract<ResponseBlock, { type: 'tool_use' }> =>
      b.type === 'tool_use' && b.name === PRICE_TOOL.name,
  );

  if (!toolUse) {
    return {
      matches: input.rows.map((row) => ({
        vbli_id: row.vbli_id,
        unit_price: null,
        note: null,
      })),
      haikuCostCents,
    };
  }

  interface RawMatch {
    vbli_id: string;
    unit_price: number | null;
    note: string | null;
  }
  const parsed = toolUse.input as { matches?: RawMatch[] };
  const rawMatches = Array.isArray(parsed.matches) ? parsed.matches : [];

  // Re-align to the request order so the UI can zip strictly by index.
  const byId = new Map<string, RawMatch>();
  for (const m of rawMatches) {
    if (m && typeof m.vbli_id === 'string') byId.set(m.vbli_id, m);
  }

  const matches: MatcherMatch[] = input.rows.map((row) => {
    const m = byId.get(row.vbli_id);
    if (!m) return { vbli_id: row.vbli_id, unit_price: null, note: null };
    const unitPrice =
      typeof m.unit_price === 'number' && Number.isFinite(m.unit_price)
        ? m.unit_price
        : null;
    const note =
      typeof m.note === 'string' && m.note.trim().length > 0 ? m.note : null;
    return { vbli_id: row.vbli_id, unit_price: unitPrice, note };
  });

  return { matches, haikuCostCents };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
