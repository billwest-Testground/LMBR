/**
 * POST /api/ingest — Ingest a customer bid document (tiered pipeline).
 *
 * Purpose:  Entry point for every new bid. Accepts either a multipart
 *           file upload (PDF / XLSX / CSV / DOCX / PNG / JPG / TXT / EML /
 *           MSG) or a JSON body with pasted raw text (for forwarded
 *           emails). The flow mirrors the Session Prompt 04 design:
 *
 *             1. Validate session + resolve company_id.
 *             2. Upload the raw file (or synthesize a .txt blob from
 *                pasted raw text) into the private bids-raw bucket.
 *             3. Insert a public.bids row with status='extracting'.
 *             4. Hand the job to enqueueOrRun — inline mode runs the
 *                tiered processor synchronously, queued mode hands it
 *                off to a BullMQ worker and returns 202.
 *             5. On inline success, read the bid + line_items back and
 *                return 200 with the full extraction report.
 *
 *           The extraction pipeline itself lives in ./processor.ts so
 *           the same code path serves the HTTP handler (inline) and the
 *           dedicated Node worker (queued). Keeping them in one place
 *           is what prevents the two runtimes from drifting.
 *
 * Inputs:   multipart/form-data { file, customerName?, jobName?,
 *           customerEmail? } OR application/json { rawText, customerName?,
 *           jobName?, customerEmail? }.
 * Outputs:  202 { bid_id, status: 'extracting' } — queued path.
 *           200 { bid_id, extraction_report, raw_file_url } — inline path.
 *           4xx / 5xx with { error } on failure.
 * Agent/API: tiered ingest processor (analyzer → parser → Mode A/B →
 *            runQaAgent) + Supabase Postgres/Storage.
 * Imports:  @lmbr/lib (enqueueOrRun, supabase admin), @lmbr/types,
 *           ./processor, zod, next/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { getSupabaseAdmin } from '@lmbr/lib';
import { enqueueOrRun, type IngestJob } from '@lmbr/lib/queue';
import { routeBidToRegion } from '@lmbr/config';

import { getSupabaseRouteHandlerClient } from '../../../lib/supabase/server';
import { BIDS_BUCKET, processIngestJob } from './processor';

export const runtime = 'nodejs';
export const maxDuration = 60;

// -----------------------------------------------------------------------------
// Request schemas
// -----------------------------------------------------------------------------

const JsonBodySchema = z.object({
  rawText: z.string().min(1),
  customerName: z.string().trim().min(1).max(240).optional(),
  jobName: z.string().trim().max(240).optional(),
  customerEmail: z.string().email().optional(),
  jobAddress: z.string().trim().max(500).optional(),
  jobState: z.string().trim().max(40).optional(),
});

const FormMetaSchema = z.object({
  customerName: z.string().trim().min(1).max(240).optional(),
  jobName: z.string().trim().max(240).optional(),
  customerEmail: z.string().email().optional(),
  jobAddress: z.string().trim().max(500).optional(),
  jobState: z.string().trim().max(40).optional(),
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

    // ------- Parse the request body -------
    const contentType = req.headers.get('content-type') ?? '';
    let fileBytes: Uint8Array | undefined;
    let mimeType: string | undefined;
    let fileName: string | undefined;
    let rawText: string | undefined;
    let customerName: string | undefined;
    let jobName: string | undefined;
    let customerEmail: string | undefined;
    let jobAddress: string | undefined;
    let jobState: string | undefined;

    if (contentType.startsWith('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (file && file instanceof File) {
        fileBytes = new Uint8Array(await file.arrayBuffer());
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
        jobAddress: stringFrom(form.get('jobAddress')),
        jobState: stringFrom(form.get('jobState')),
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
      jobAddress = meta.data.jobAddress;
      jobState = meta.data.jobState;
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
      jobAddress = body.data.jobAddress;
      jobState = body.data.jobState;
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

    // ------- Upload the raw material to storage -------
    // Raw text gets synthesized into a .txt object so the downstream
    // pipeline sees one uniform "download from storage" contract.
    const uploadResult = await uploadIngestSource({
      companyId: profile.company_id,
      fileBytes,
      fileName,
      mimeType,
      rawText,
    });
    if (!uploadResult) {
      return NextResponse.json(
        { error: 'Failed to upload source document to storage.' },
        { status: 500 },
      );
    }

    // ------- Create the bid row in extracting state -------
    const admin = getSupabaseAdmin();
    const bidInsertName =
      customerName ?? deriveCustomerName(rawText, fileName) ?? 'New customer';

    // Auto-derive job_region from job_state when present.
    const jobRegion = jobState ? routeBidToRegion(jobState) : null;

    const { data: bid, error: bidError } = await admin
      .from('bids')
      .insert({
        company_id: profile.company_id,
        created_by: profile.id,
        assigned_trader_id: profile.id,
        customer_name: bidInsertName,
        customer_email: customerEmail ?? null,
        job_name: jobName ?? null,
        job_address: jobAddress ?? null,
        job_state: jobState ?? null,
        job_region: jobRegion,
        status: 'extracting',
        consolidation_mode: 'structured',
        raw_file_url: uploadResult.signedUrl,
      })
      .select('id')
      .single();

    if (bidError || !bid) {
      return NextResponse.json(
        { error: bidError?.message ?? 'Failed to create bid' },
        { status: 500 },
      );
    }

    // ------- Hand the job to the tiered pipeline -------
    const job: IngestJob = {
      bidId: bid.id,
      companyId: profile.company_id,
      filePath: uploadResult.objectPath,
      mimeType: uploadResult.effectiveMimeType,
      filename: uploadResult.effectiveFilename,
    };

    // Don't pre-declare with an unparameterized type — let TS infer the
    // inlineResult generic from processIngestJob's return type.
    let result;
    try {
      result = await enqueueOrRun(job, processIngestJob);
    } catch (err) {
      // Inline failure — mark the bid so the trader sees it and knows to
      // re-upload. The bid already exists at this point, so we can't
      // return a clean "nothing happened" shape.
      const message = err instanceof Error ? err.message : 'Ingest failed';
      await admin
        .from('bids')
        .update({
          status: 'received',
          notes: `ingest failed: ${message}`,
        })
        .eq('id', bid.id);
      return NextResponse.json(
        { error: message, bid_id: bid.id },
        { status: 500 },
      );
    }

    // ------- Queued: client polls via bids row -------
    if (result.mode === 'queued') {
      return NextResponse.json(
        {
          bid_id: bid.id,
          status: 'extracting',
          queued_job_id: result.jobId ?? null,
        },
        { status: 202 },
      );
    }

    // ------- Inline: use the processor's return value directly -------
    const inline = result.inlineResult;
    if (!inline) {
      // Defensive — inline mode must produce a result.
      return NextResponse.json(
        { error: 'Inline processing returned no result.' },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        bid_id: bid.id,
        raw_file_url: uploadResult.signedUrl,
        extraction: inline.extraction,
        qa_report: inline.qaReport,
        extraction_report: {
          method_used: inline.methodUsed,
          total_cost_cents: inline.totalCostCents,
          total_line_items: inline.extraction.totalLineItems,
          overall_confidence: inline.extraction.extractionConfidence,
          qa_passed: inline.qaReport.pass,
        },
      },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ingest failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// -----------------------------------------------------------------------------
// Upload helpers
// -----------------------------------------------------------------------------

interface UploadResult {
  objectPath: string;
  signedUrl: string | null;
  effectiveMimeType: string;
  effectiveFilename: string;
}

async function uploadIngestSource(args: {
  companyId: string;
  fileBytes?: Uint8Array;
  fileName?: string;
  mimeType?: string;
  rawText?: string;
}): Promise<UploadResult | null> {
  const admin = getSupabaseAdmin();

  // Ensure the bucket exists. createBucket 409s if already present, so
  // we check first and swallow.
  try {
    const { data: existing } = await admin.storage.getBucket(BIDS_BUCKET);
    if (!existing) {
      await admin.storage.createBucket(BIDS_BUCKET, {
        public: false,
        fileSizeLimit: 52428800, // 50 MB
      });
    }
  } catch {
    /* non-fatal */
  }

  let payload: Uint8Array;
  let effectiveMime: string;
  let effectiveName: string;

  if (args.fileBytes && args.fileName) {
    payload = args.fileBytes;
    effectiveMime = args.mimeType ?? 'application/octet-stream';
    effectiveName = args.fileName;
  } else if (args.rawText) {
    payload = new TextEncoder().encode(args.rawText);
    effectiveMime = 'text/plain';
    effectiveName = 'pasted.txt';
  } else {
    return null;
  }

  const ext = extractExt(effectiveName);
  const objectPath = `${args.companyId}/${randomUUID()}${ext}`;

  const { error: uploadError } = await admin.storage
    .from(BIDS_BUCKET)
    .upload(objectPath, payload, {
      contentType: effectiveMime,
      upsert: false,
    });
  if (uploadError) {
    console.error('[ingest] storage upload failed', uploadError.message);
    return null;
  }

  // Signed URL for the review UI — 7 days is long enough for a trader
  // to finish reviewing an older bid.
  const { data: signed } = await admin.storage
    .from(BIDS_BUCKET)
    .createSignedUrl(objectPath, 60 * 60 * 24 * 7);

  return {
    objectPath,
    signedUrl: signed?.signedUrl ?? null,
    effectiveMimeType: effectiveMime,
    effectiveFilename: effectiveName,
  };
}

// -----------------------------------------------------------------------------
// Small helpers
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
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.docx'))
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.tiff') || lower.endsWith('.tif')) return 'image/tiff';
  if (lower.endsWith('.bmp')) return 'image/bmp';
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

function extractExt(name: string): string {
  const match = name.match(/\.[^.]+$/);
  return match ? match[0] : '';
}
