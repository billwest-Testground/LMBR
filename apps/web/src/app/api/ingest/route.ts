/**
 * POST /api/ingest — Ingest a customer bid document.
 *
 * Purpose:  Entry point for every new bid. Accepts either a multipart
 *           file upload (PDF / XLSX / PNG / JPG / TXT / EML / MSG) or a
 *           JSON body with pasted raw text (for forwarded emails). The
 *           flow:
 *
 *             1. Validate the Supabase session + resolve the caller's
 *                company_id and lmbr.users.id from public.users.
 *             2. Upload the raw file (if present) into the private
 *                bids-raw storage bucket under company_id/{uuid}.{ext}.
 *             3. Call ingestAgent → extraction → QA.
 *             4. Insert a public.bids row with status='received' and
 *                consolidation_mode='structured' (default until the
 *                trader changes it in the consolidation step).
 *             5. Bulk insert public.line_items rows preserving building
 *                groups and sort_order. All writes go through the
 *                authenticated SSR client so RLS applies — the caller
 *                must own the tenant.
 *             6. Return { bid_id, extraction, qa_report, raw_file_url }.
 *
 * Inputs:   multipart/form-data { file, customerName?, jobName? } OR
 *           application/json { rawText, customerName?, jobName? }.
 * Outputs:  200 { bid_id, extraction, qa_report, raw_file_url }.
 * Agent/API: ingestAgent (@lmbr/agents) → Anthropic Claude.
 *           Supabase Postgres + Storage.
 * Imports:  @lmbr/agents, @lmbr/lib, @lmbr/types, zod, next/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { ingestAgent } from '@lmbr/agents';
import { getSupabaseAdmin } from '@lmbr/lib';
import type { ExtractedLineItem, ExtractionOutput } from '@lmbr/types';

import { getSupabaseRouteHandlerClient } from '../../../lib/supabase/server';

export const runtime = 'nodejs';
// xlsx + Claude PDF base64 can push large payloads; default 4MB body
// limit on route handlers is enough for ~3MB files. We accept up to
// ~15MB by streaming formData(), which Next handles out of the box.
export const maxDuration = 60;

const BIDS_BUCKET = 'bids-raw';

// -----------------------------------------------------------------------------
// Request schemas
// -----------------------------------------------------------------------------

const JsonBodySchema = z.object({
  rawText: z.string().min(1),
  customerName: z.string().trim().min(1).max(240).optional(),
  jobName: z.string().trim().max(240).optional(),
  customerEmail: z.string().email().optional(),
});

const FormMetaSchema = z.object({
  customerName: z.string().trim().min(1).max(240).optional(),
  jobName: z.string().trim().max(240).optional(),
  customerEmail: z.string().email().optional(),
});

// -----------------------------------------------------------------------------
// Handler
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
        { error: 'Finish onboarding before ingesting a bid.' },
        { status: 400 },
      );
    }

    const contentType = req.headers.get('content-type') ?? '';

    let fileBytes: Uint8Array | undefined;
    let mimeType: string | undefined;
    let fileName: string | undefined;
    let rawText: string | undefined;
    let customerName: string | undefined;
    let jobName: string | undefined;
    let customerEmail: string | undefined;

    if (contentType.startsWith('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (file && file instanceof File) {
        const buffer = new Uint8Array(await file.arrayBuffer());
        fileBytes = buffer;
        mimeType = file.type || guessMimeFromName(file.name);
        fileName = file.name;
      }
      const textField = form.get('rawText');
      if (typeof textField === 'string' && textField.trim().length > 0) {
        rawText = textField;
      }
      const meta = FormMetaSchema.safeParse({
        customerName: stringFrom(form.get('customerName')),
        jobName: stringFrom(form.get('jobName')),
        customerEmail: stringFrom(form.get('customerEmail')),
      });
      if (!meta.success) {
        return NextResponse.json(
          { error: meta.error.errors[0]?.message ?? 'Invalid form fields' },
          { status: 400 },
        );
      }
      customerName = meta.data.customerName;
      jobName = meta.data.jobName;
      customerEmail = meta.data.customerEmail;
    } else if (contentType.startsWith('application/json')) {
      const body = JsonBodySchema.safeParse(await req.json());
      if (!body.success) {
        return NextResponse.json(
          { error: body.error.errors[0]?.message ?? 'Invalid body' },
          { status: 400 },
        );
      }
      rawText = body.data.rawText;
      customerName = body.data.customerName;
      jobName = body.data.jobName;
      customerEmail = body.data.customerEmail;
    } else {
      return NextResponse.json(
        { error: 'Unsupported Content-Type' },
        { status: 415 },
      );
    }

    if (!fileBytes && !rawText) {
      return NextResponse.json(
        { error: 'Upload a file or paste the lumber list text.' },
        { status: 400 },
      );
    }

    // ------- Run the extract / QA pipeline -------
    const ingestResult = await ingestAgent({
      fileBytes,
      mimeType,
      rawText,
      fileName,
    });

    // ------- Persist raw file to storage (best-effort) -------
    let rawFileUrl: string | null = null;
    if (fileBytes && fileName) {
      rawFileUrl = await uploadRawFile({
        companyId: profile.company_id,
        fileBytes,
        fileName,
        mimeType,
      });
    }

    // ------- Insert bid row -------
    const bidInsertName =
      customerName ?? deriveCustomerName(rawText, fileName) ?? 'New customer';

    const { data: bid, error: bidError } = await supabase
      .from('bids')
      .insert({
        company_id: profile.company_id,
        created_by: profile.id,
        assigned_trader_id: profile.id,
        customer_name: bidInsertName,
        customer_email: customerEmail ?? null,
        job_name: jobName ?? null,
        status: 'reviewing',
        consolidation_mode: 'structured',
        raw_file_url: rawFileUrl,
      })
      .select('id')
      .single();

    if (bidError || !bid) {
      return NextResponse.json(
        { error: bidError?.message ?? 'Failed to create bid' },
        { status: 500 },
      );
    }

    // ------- Flatten building groups into line_items rows -------
    const lineItemRows = flattenLineItemsForInsert({
      bidId: bid.id,
      companyId: profile.company_id,
      extraction: ingestResult.extraction,
    });

    if (lineItemRows.length > 0) {
      const { error: liError } = await supabase
        .from('line_items')
        .insert(lineItemRows);
      if (liError) {
        // Roll back the bid so we don't leave dangling placeholder rows.
        await supabase.from('bids').delete().eq('id', bid.id);
        return NextResponse.json({ error: liError.message }, { status: 500 });
      }
    }

    return NextResponse.json(
      {
        bid_id: bid.id,
        extraction: ingestResult.extraction,
        qa_report: ingestResult.qaReport,
        raw_file_url: rawFileUrl,
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ingest failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function stringFrom(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function guessMimeFromName(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.xlsx'))
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.eml')) return 'message/rfc822';
  if (lower.endsWith('.msg')) return 'application/vnd.ms-outlook';
  return undefined;
}

function deriveCustomerName(
  rawText: string | undefined,
  fileName: string | undefined,
): string | undefined {
  if (rawText) {
    const firstLine = rawText.split('\n').map((l) => l.trim()).find(Boolean);
    if (firstLine && firstLine.length < 120) return firstLine;
  }
  if (fileName) {
    return fileName.replace(/\.[^.]+$/, '').slice(0, 120);
  }
  return undefined;
}

async function uploadRawFile(args: {
  companyId: string;
  fileBytes: Uint8Array;
  fileName: string;
  mimeType?: string;
}): Promise<string | null> {
  const admin = getSupabaseAdmin();
  try {
    // Ensure the private bucket exists. createBucket is idempotent-ish —
    // it 409s when it already exists, so we swallow that case.
    const { data: existing } = await admin.storage.getBucket(BIDS_BUCKET);
    if (!existing) {
      await admin.storage.createBucket(BIDS_BUCKET, {
        public: false,
        fileSizeLimit: 52428800, // 50 MB
      });
    }

    const ext = extractExt(args.fileName);
    const objectPath = `${args.companyId}/${randomUUID()}${ext}`;
    const { error: uploadError } = await admin.storage
      .from(BIDS_BUCKET)
      .upload(objectPath, args.fileBytes, {
        contentType: args.mimeType ?? 'application/octet-stream',
        upsert: false,
      });

    if (uploadError) {
      // Non-fatal — the extraction succeeded; log and continue.
      console.error('[ingest] storage upload failed', uploadError.message);
      return null;
    }

    // Return a signed URL valid for 7 days so the trader can pull the
    // original back up from the bid detail screen.
    const { data: signed } = await admin.storage
      .from(BIDS_BUCKET)
      .createSignedUrl(objectPath, 60 * 60 * 24 * 7);
    return signed?.signedUrl ?? null;
  } catch (err) {
    console.error('[ingest] upload failed', err);
    return null;
  }
}

function extractExt(name: string): string {
  const match = name.match(/\.[^.]+$/);
  return match ? match[0] : '';
}

function flattenLineItemsForInsert(args: {
  bidId: string;
  companyId: string;
  extraction: ExtractionOutput;
}): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  let sort = 0;
  for (const group of args.extraction.buildingGroups) {
    for (const item of group.lineItems) {
      rows.push(toLineItemRow(args, group.buildingTag, group.phaseNumber, item, sort++));
    }
  }
  return rows;
}

function toLineItemRow(
  args: { bidId: string; companyId: string },
  buildingTag: string,
  phaseNumber: number | null,
  item: ExtractedLineItem,
  sortOrder: number,
): Record<string, unknown> {
  // Preserve flags + confidence + original_text as a JSON-ish blob in
  // `notes` so the UI can render the yellow / red badges without adding
  // extra columns to line_items. A follow-up prompt can promote these
  // to proper columns if the product needs to query on them.
  const metaBlob = JSON.stringify({
    confidence: item.confidence,
    flags: item.flags,
    original_text: item.originalText,
  });
  return {
    bid_id: args.bidId,
    company_id: args.companyId,
    building_tag: buildingTag || null,
    phase_number: phaseNumber,
    species: item.species,
    dimension: item.dimension,
    grade: item.grade || null,
    length: item.length || null,
    quantity: item.quantity,
    unit: item.unit,
    board_feet: item.boardFeet,
    notes: metaBlob,
    is_consolidated: false,
    original_line_item_id: null,
    sort_order: sortOrder,
  };
}
