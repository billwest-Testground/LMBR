/**
 * POST + GET /api/webhook/outlook — Microsoft Graph change-notification webhook.
 *
 * Purpose:  The magic moment. A customer emails bids@company.com; Graph
 *           fires a change notification at this endpoint; LMBR creates a
 *           bid per attachment (or per body-only email), enqueues tiered
 *           extraction, and auto-replies to the sender from the watched
 *           mailbox — all before the trader does anything. CLAUDE.md
 *           Prompt 08 calls this the "highest priority — the demo magic
 *           moment" for good reason.
 *
 *           The endpoint is public by necessity (Graph calls it from the
 *           internet, not from an authenticated session). clientState
 *           verification is the auth: every inbound notification carries
 *           the secret we minted at subscription time, and we compare it
 *           to the stored value via timingSafeEqual. Non-matches, unknown
 *           subscriptions, and malformed payloads all collapse to the
 *           same generic "silent 202" response so the webhook cannot be
 *           used to probe subscription state from the outside.
 *
 *           Graph retries on anything outside 200-299. To avoid
 *           amplification and to keep Graph from queueing behind our own
 *           processing latency, we return 202 after validation but
 *           BEFORE fetching messages, uploading attachments, creating
 *           bids, or sending auto-replies. The rest runs in the
 *           background via a fire-and-forget Promise; on a long-running
 *           Node host this completes reliably. On Vercel serverless,
 *           wrap with `waitUntil` from `@vercel/functions` — flagged as
 *           a follow-up below; does not affect correctness in dev.
 *
 *           Idempotency: Graph can redeliver the same notification. We
 *           key each bid by `{messageId}` (body-only) or
 *           `{messageId}:{attachmentId}` (per-attachment). Migration 021
 *           enforces the uniqueness.
 *
 * Inputs:   GET/POST: ?validationToken=...  → echo as text/plain.
 *           POST: Graph change-notification JSON body
 *             { value: [{ subscriptionId, clientState, resource,
 *                         resourceData: { id }, ... }] }.
 * Outputs:  200 text/plain body (validation handshake only).
 *           202 JSON { ok: true } (every other case — Graph is told
 *             "accepted" regardless of whether any individual
 *             notification made it through validation).
 * Agent/API: @lmbr/lib (outlook primitives, supabase admin, queue),
 *            ../../ingest/processor (BIDS_BUCKET + processIngestJob).
 * Imports:  next/server, node:crypto, @lmbr/lib, ../../ingest/processor.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';

import {
  enqueueOrRun,
  fetchMessageAttachments,
  getGraphClient,
  getSupabaseAdmin,
  sendMail,
  verifyOutlookClientState,
  type IngestJob,
} from '@lmbr/lib';

import { BIDS_BUCKET, processIngestJob } from '../../ingest/processor';

export const runtime = 'nodejs';
// Attachment fetch + upload + bid insert can run 5-15s for multi-attachment
// emails. The 202 returns quickly, but `waitUntil` (when available) needs
// headroom so the background completes before the sandbox is reaped.
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** MIME types the webhook will actually create bids for. */
const SUPPORTED_MIME_TYPES = new Set<string>([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/tiff',
  'image/bmp',
  'text/plain',
]);

/** Max attachment size we accept (50 MB, matches BIDS_BUCKET fileSizeLimit). */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// GET: validation handshake (only used for some Graph resource types)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const token = url.searchParams.get('validationToken');
  if (token) {
    return validationResponse(token);
  }
  // No token → nothing to do. Return 202 rather than 4xx so an accidental
  // curl doesn't leak "this endpoint expects a validationToken" details.
  return NextResponse.json({ ok: true }, { status: 202 });
}

// ---------------------------------------------------------------------------
// POST: validation + change notifications
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const validationToken = url.searchParams.get('validationToken');
  if (validationToken) {
    // Validation handshake takes priority over any notification body.
    // Never log the token itself — it's a shared secret with Graph.
    return validationResponse(validationToken);
  }

  // --- Parse body ---------------------------------------------------------
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    // Malformed body → 202 anyway. Graph should not retry this.
    console.warn('LMBR.ai outlook webhook: unparseable JSON body.');
    return acceptedResponse();
  }

  const notifications = extractNotifications(body);
  if (notifications.length === 0) {
    return acceptedResponse();
  }

  // --- Validate clientState + look up subscription rows ------------------
  // Valid notifications include enough context (companyId, userId) for the
  // background processor to act without re-hitting the DB for the same row.
  const valid = await authenticateNotifications(notifications);

  if (valid.length > 0) {
    scheduleBackground(processAllNotifications(valid));
  }

  return acceptedResponse();
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function validationResponse(token: string): NextResponse {
  return new NextResponse(token, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}

function acceptedResponse(): NextResponse {
  return NextResponse.json({ ok: true }, { status: 202 });
}

// ---------------------------------------------------------------------------
// Notification shapes
// ---------------------------------------------------------------------------

interface InboundNotification {
  subscriptionId: string;
  clientState: string;
  resource: string;
  messageId: string;
  /** Opaque — included for diagnostics only. */
  changeType?: string;
}

interface AuthenticatedNotification extends InboundNotification {
  companyId: string;
  userId: string;
  mailboxEmail: string;
}

function extractNotifications(body: unknown): InboundNotification[] {
  if (!body || typeof body !== 'object') return [];
  const obj = body as Record<string, unknown>;
  const value = Array.isArray(obj.value) ? obj.value : [];
  const out: InboundNotification[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const subscriptionId = typeof e.subscriptionId === 'string' ? e.subscriptionId : null;
    const clientState = typeof e.clientState === 'string' ? e.clientState : null;
    const resource = typeof e.resource === 'string' ? e.resource : null;
    if (!subscriptionId || !clientState || !resource) continue;

    // Extract the Graph message id. Two shapes in the wild:
    //   1. `resource` string like `users/{email}/messages/{messageId}`
    //   2. `resourceData.id` — authoritative per Graph docs
    let messageId: string | null = null;
    const rd = e.resourceData as { id?: unknown } | undefined;
    if (rd && typeof rd.id === 'string') {
      messageId = rd.id;
    } else {
      const match = /messages\/([^/?]+)$/i.exec(resource);
      if (match && match[1]) messageId = match[1];
    }
    if (!messageId) continue;

    const changeType = typeof e.changeType === 'string' ? e.changeType : undefined;
    const parsed: InboundNotification = {
      subscriptionId,
      clientState,
      resource,
      messageId,
    };
    if (changeType !== undefined) {
      parsed.changeType = changeType;
    }
    out.push(parsed);
  }
  return out;
}

async function authenticateNotifications(
  notifications: InboundNotification[],
): Promise<AuthenticatedNotification[]> {
  const admin = getSupabaseAdmin();
  const uniqueSubIds = [...new Set(notifications.map((n) => n.subscriptionId))];

  const { data, error } = await admin
    .from('outlook_subscriptions')
    .select('subscription_id, company_id, user_id, resource, client_state, status')
    .in('subscription_id', uniqueSubIds);

  if (error) {
    console.warn(
      `LMBR.ai outlook webhook: subscription lookup failed: ${error.message}.`,
    );
    return [];
  }

  const bySubId = new Map<
    string,
    {
      company_id: string;
      user_id: string;
      resource: string;
      client_state: string;
      status: string;
    }
  >();
  for (const row of data ?? []) {
    bySubId.set(row.subscription_id as string, {
      company_id: row.company_id as string,
      user_id: row.user_id as string,
      resource: row.resource as string,
      client_state: row.client_state as string,
      status: row.status as string,
    });
  }

  const out: AuthenticatedNotification[] = [];
  for (const n of notifications) {
    const row = bySubId.get(n.subscriptionId);
    if (!row) {
      // Unknown subscription. Do NOT 404 — Graph will retry and flood us.
      console.warn(
        `LMBR.ai outlook webhook: unknown subscriptionId=${n.subscriptionId} (skipped).`,
      );
      continue;
    }
    if (row.status !== 'active') {
      console.warn(
        `LMBR.ai outlook webhook: subscriptionId=${n.subscriptionId} status=${row.status} (skipped).`,
      );
      continue;
    }
    if (!verifyOutlookClientState(n.clientState, row.client_state)) {
      // Never log the clientState value itself. Log only the sub id so ops
      // can see which subscription is being targeted.
      console.warn(
        `LMBR.ai outlook webhook: clientState mismatch for subscriptionId=${n.subscriptionId}.`,
      );
      continue;
    }
    const mailboxEmail = parseMailboxFromResource(row.resource);
    if (!mailboxEmail) {
      console.warn(
        `LMBR.ai outlook webhook: could not parse mailbox from resource='${row.resource}' (sub=${n.subscriptionId}).`,
      );
      continue;
    }
    out.push({
      ...n,
      companyId: row.company_id,
      userId: row.user_id,
      mailboxEmail,
    });
  }

  return out;
}

function parseMailboxFromResource(resource: string): string | null {
  const match = /^users\/([^/]+)\/messages$/i.exec(resource);
  return match && match[1] ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Background scheduling
// ---------------------------------------------------------------------------

/**
 * Fire the background work without awaiting. On a persistent Node host
 * this completes after the 202 is returned. On Vercel serverless, wrap
 * the promise with `waitUntil` from `@vercel/functions`:
 *
 *   const { waitUntil } = await import('@vercel/functions');
 *   waitUntil(promise);
 *
 * Not added today to avoid a new dep; document in the header so the
 * deploy-time config can add it.
 */
function scheduleBackground(promise: Promise<unknown>): void {
  promise.catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`LMBR.ai outlook webhook background: ${message}`);
  });
}

// ---------------------------------------------------------------------------
// Per-notification processing
// ---------------------------------------------------------------------------

async function processAllNotifications(
  notifications: AuthenticatedNotification[],
): Promise<void> {
  for (const n of notifications) {
    try {
      await processOneNotification(n);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `LMBR.ai outlook webhook: processing subscriptionId=${n.subscriptionId} messageId=${n.messageId} failed: ${message}.`,
      );
    }
  }
}

interface MessageSender {
  address: string;
  name: string | null;
}

interface FetchedMessage {
  id: string;
  subject: string;
  from: MessageSender | null;
  bodyText: string;
  hasAttachments: boolean;
}

async function processOneNotification(n: AuthenticatedNotification): Promise<void> {
  const client = await getGraphClient(n.userId, n.companyId);

  // --- Fetch message body + metadata via the mailbox-owner's Graph client ---
  // Prefer plain-text bodies so the body-only path can pass straight into
  // the extraction pipeline without an HTML-strip hop.
  interface GraphMessage {
    id?: string;
    subject?: string;
    from?: {
      emailAddress?: { address?: string; name?: string };
    };
    body?: { contentType?: string; content?: string };
    bodyPreview?: string;
    hasAttachments?: boolean;
    internetMessageId?: string;
  }

  let message: GraphMessage;
  try {
    message = (await client
      .api(`/users/${n.mailboxEmail}/messages/${n.messageId}`)
      .header('Prefer', 'outlook.body-content-type="text"')
      .select(
        'id,subject,from,body,bodyPreview,hasAttachments,internetMessageId',
      )
      .get()) as GraphMessage;
  } catch (err) {
    const message404 = err instanceof Error && /404|NotFound/i.test(err.message);
    if (message404) {
      // Message was deleted before we got to it. Not an error, not a retry.
      console.warn(
        `LMBR.ai outlook webhook: message ${n.messageId} gone (sub=${n.subscriptionId}).`,
      );
      return;
    }
    throw err;
  }

  const fetched: FetchedMessage = {
    id: message.id ?? n.messageId,
    subject: message.subject?.trim().length ? message.subject.trim() : 'Untitled bid',
    from: extractSender(message),
    bodyText: extractBodyText(message),
    hasAttachments: Boolean(message.hasAttachments),
  };

  // --- Fetch attachments (filtered to supported MIME + size caps) --------
  let attachments: Array<{
    name: string;
    contentType: string;
    bytes: Uint8Array;
    attachmentId: string;
  }> = [];
  if (fetched.hasAttachments) {
    attachments = await fetchSupportedAttachments(n, fetched.id);
  }

  // --- No content at all → skip silently -------------------------------
  const hasBody = fetched.bodyText.trim().length > 0;
  if (attachments.length === 0 && !hasBody) {
    console.log(
      `[outlook] messageId=${fetched.id} has no attachments and no body; skipping.`,
    );
    return;
  }

  // --- Create one bid per attachment; or one bid from body if no atts ---
  const createdBidIds: string[] = [];
  if (attachments.length > 0) {
    for (const att of attachments) {
      const key = `${fetched.id}:${att.attachmentId}`;
      const bidId = await createBidFromAttachment({
        idempotencyKey: key,
        notification: n,
        fetched,
        attachment: att,
      });
      if (bidId) createdBidIds.push(bidId);
    }
  } else if (hasBody) {
    const bidId = await createBidFromBody({
      idempotencyKey: fetched.id,
      notification: n,
      fetched,
    });
    if (bidId) createdBidIds.push(bidId);
  }

  // --- Auto-reply from the mailbox-owner's account ----------------------
  if (createdBidIds.length > 0 && fetched.from?.address) {
    await sendAutoReply({
      notification: n,
      toAddress: fetched.from.address,
      toName: fetched.from.name,
      originalSubject: fetched.subject,
      bidIds: createdBidIds,
    });
  }
}

function extractSender(message: {
  from?: { emailAddress?: { address?: string; name?: string } };
}): MessageSender | null {
  const addr = message.from?.emailAddress?.address;
  if (!addr || typeof addr !== 'string' || addr.length === 0) return null;
  const name = message.from?.emailAddress?.name;
  return {
    address: addr,
    name: typeof name === 'string' && name.length > 0 ? name : null,
  };
}

function extractBodyText(message: {
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
}): string {
  const content = message.body?.content;
  const type = message.body?.contentType?.toLowerCase() ?? 'text';
  if (typeof content === 'string' && content.length > 0) {
    if (type === 'html') return stripHtml(content);
    return content;
  }
  return typeof message.bodyPreview === 'string' ? message.bodyPreview : '';
}

function stripHtml(html: string): string {
  // Intentional minimal strip — the Prefer header should have returned
  // text/plain in the first place. This is only a safety net.
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

// ---------------------------------------------------------------------------
// Attachment fetch
// ---------------------------------------------------------------------------

async function fetchSupportedAttachments(
  n: AuthenticatedNotification,
  messageId: string,
): Promise<
  Array<{
    name: string;
    contentType: string;
    bytes: Uint8Array;
    attachmentId: string;
  }>
> {
  const client = await getGraphClient(n.userId, n.companyId);

  interface GraphAttachment {
    id?: string;
    '@odata.type'?: string;
    name?: string;
    contentType?: string;
    contentBytes?: string;
    isInline?: boolean;
    size?: number;
  }
  interface AttachmentsResponse {
    value?: GraphAttachment[];
  }

  let response: AttachmentsResponse;
  try {
    response = (await client
      .api(`/users/${n.mailboxEmail}/messages/${messageId}/attachments`)
      .get()) as AttachmentsResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `LMBR.ai outlook webhook: attachment list failed for ${messageId}: ${msg}.`,
    );
    return [];
  }

  const out: Array<{
    name: string;
    contentType: string;
    bytes: Uint8Array;
    attachmentId: string;
  }> = [];

  for (const a of response.value ?? []) {
    if (a['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;
    if (a.isInline === true) continue;
    if (!a.id || !a.name || !a.contentBytes) continue;
    const contentType = (a.contentType ?? 'application/octet-stream').toLowerCase();
    if (!SUPPORTED_MIME_TYPES.has(contentType)) {
      console.log(
        `[outlook] skipping attachment '${a.name}' with unsupported type=${contentType}.`,
      );
      continue;
    }
    const buffer = Buffer.from(a.contentBytes, 'base64');
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      console.warn(
        `[outlook] attachment '${a.name}' exceeds max size (${buffer.length} > ${MAX_ATTACHMENT_BYTES}); skipping.`,
      );
      continue;
    }
    out.push({
      name: a.name,
      contentType,
      bytes: new Uint8Array(buffer),
      attachmentId: a.id,
    });
  }

  // Explicit no-op so lint/type tools see `fetchMessageAttachments` is
  // intentionally not used here — we need per-attachment ids, not just
  // blobs. Kept in the import to keep the surface discoverable.
  void fetchMessageAttachments;

  return out;
}

// ---------------------------------------------------------------------------
// Bid creation
// ---------------------------------------------------------------------------

interface CreateBidFromAttachmentArgs {
  idempotencyKey: string;
  notification: AuthenticatedNotification;
  fetched: FetchedMessage;
  attachment: {
    name: string;
    contentType: string;
    bytes: Uint8Array;
    attachmentId: string;
  };
}

async function createBidFromAttachment(
  args: CreateBidFromAttachmentArgs,
): Promise<string | null> {
  if (await bidAlreadyExists(args.notification.companyId, args.idempotencyKey)) {
    console.log(
      `[outlook] duplicate ignored: company=${args.notification.companyId} message=${args.idempotencyKey}.`,
    );
    return null;
  }

  const objectPath = await uploadToBidsBucket({
    companyId: args.notification.companyId,
    filename: args.attachment.name,
    mimeType: args.attachment.contentType,
    bytes: args.attachment.bytes,
  });
  if (!objectPath) return null;

  const bidId = await insertBid({
    companyId: args.notification.companyId,
    createdByUserId: args.notification.userId,
    customer: args.fetched.from,
    subject: args.fetched.subject,
    filename: args.attachment.name,
    messageId: args.idempotencyKey,
    objectPath,
  });
  if (!bidId) return null;

  // Hand off to the tiered extraction pipeline.
  const job: IngestJob = {
    bidId,
    companyId: args.notification.companyId,
    filePath: objectPath,
    mimeType: args.attachment.contentType,
    filename: args.attachment.name,
  };
  await enqueueOrRun(job, processIngestJob).catch((err) => {
    console.warn(
      `LMBR.ai outlook webhook: enqueueOrRun failed for bid=${bidId}: ${err instanceof Error ? err.message : String(err)}.`,
    );
  });

  return bidId;
}

interface CreateBidFromBodyArgs {
  idempotencyKey: string;
  notification: AuthenticatedNotification;
  fetched: FetchedMessage;
}

async function createBidFromBody(
  args: CreateBidFromBodyArgs,
): Promise<string | null> {
  if (await bidAlreadyExists(args.notification.companyId, args.idempotencyKey)) {
    console.log(
      `[outlook] duplicate ignored: company=${args.notification.companyId} message=${args.idempotencyKey}.`,
    );
    return null;
  }

  const bytes = new TextEncoder().encode(args.fetched.bodyText);
  const filename = `email-body-${args.fetched.id}.txt`;
  const objectPath = await uploadToBidsBucket({
    companyId: args.notification.companyId,
    filename,
    mimeType: 'text/plain',
    bytes,
  });
  if (!objectPath) return null;

  const bidId = await insertBid({
    companyId: args.notification.companyId,
    createdByUserId: args.notification.userId,
    customer: args.fetched.from,
    subject: args.fetched.subject,
    filename,
    messageId: args.idempotencyKey,
    objectPath,
  });
  if (!bidId) return null;

  const job: IngestJob = {
    bidId,
    companyId: args.notification.companyId,
    filePath: objectPath,
    mimeType: 'text/plain',
    filename,
  };
  await enqueueOrRun(job, processIngestJob).catch((err) => {
    console.warn(
      `LMBR.ai outlook webhook: enqueueOrRun failed for bid=${bidId}: ${err instanceof Error ? err.message : String(err)}.`,
    );
  });

  return bidId;
}

async function bidAlreadyExists(
  companyId: string,
  messageId: string,
): Promise<boolean> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('bids')
    .select('id')
    .eq('company_id', companyId)
    .eq('message_id', messageId)
    .maybeSingle();
  if (error) {
    // Log and assume "does not exist" so we don't silently drop bids on
    // transient DB hiccups. The unique index is the final guardrail.
    console.warn(`[outlook] idempotency check failed: ${error.message}.`);
    return false;
  }
  return data !== null;
}

async function uploadToBidsBucket(args: {
  companyId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<string | null> {
  const admin = getSupabaseAdmin();

  // Ensure bucket exists (mirrors /api/ingest behavior).
  try {
    const { data: existing } = await admin.storage.getBucket(BIDS_BUCKET);
    if (!existing) {
      await admin.storage.createBucket(BIDS_BUCKET, {
        public: false,
        fileSizeLimit: MAX_ATTACHMENT_BYTES,
      });
    }
  } catch {
    /* non-fatal */
  }

  const ext = extFromFilename(args.filename);
  const objectPath = `${args.companyId}/${randomUUID()}${ext}`;

  const { error } = await admin.storage
    .from(BIDS_BUCKET)
    .upload(objectPath, args.bytes, {
      contentType: args.mimeType,
      upsert: false,
    });
  if (error) {
    console.warn(`[outlook] bucket upload failed for '${args.filename}': ${error.message}.`);
    return null;
  }
  return objectPath;
}

function extFromFilename(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  const ext = name.slice(dot).toLowerCase();
  // Reject anything that could let a path traversal or weirdness sneak in.
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) return '';
  return ext;
}

interface InsertBidArgs {
  companyId: string;
  createdByUserId: string;
  customer: MessageSender | null;
  subject: string;
  filename: string;
  messageId: string;
  objectPath: string;
}

async function insertBid(args: InsertBidArgs): Promise<string | null> {
  const admin = getSupabaseAdmin();

  // Signed URL for the review UI — mirrors the 7-day window used by
  // /api/ingest so the trader has the same time window to open the
  // source file from the bid row.
  const { data: signed } = await admin.storage
    .from(BIDS_BUCKET)
    .createSignedUrl(args.objectPath, 60 * 60 * 24 * 7);

  const customerName = args.customer?.name ?? args.customer?.address ?? 'New customer';
  const customerEmail = args.customer?.address ?? null;
  const jobName = deriveJobNameFromSubject(args.subject, args.customer, args.filename);

  const { data, error } = await admin
    .from('bids')
    .insert({
      company_id: args.companyId,
      created_by: args.createdByUserId,
      assigned_trader_id: args.createdByUserId,
      customer_name: customerName,
      customer_email: customerEmail,
      job_name: jobName,
      status: 'extracting',
      consolidation_mode: 'structured',
      raw_file_url: signed?.signedUrl ?? null,
      message_id: args.messageId,
    })
    .select('id')
    .single();

  if (error) {
    // Race with a concurrent delivery of the same notification can trip
    // the unique index — that's expected and safe, we just picked the
    // wrong winner. Treat unique violations as "already created".
    if (/duplicate key value|unique/i.test(error.message)) {
      console.log(
        `[outlook] insert lost unique race for message=${args.messageId}; already created by a sibling.`,
      );
      return null;
    }
    console.warn(`[outlook] bid insert failed for message=${args.messageId}: ${error.message}.`);
    return null;
  }
  return (data?.id as string) ?? null;
}

function deriveJobNameFromSubject(
  subject: string,
  customer: MessageSender | null,
  filename: string,
): string {
  const cleaned = subject
    .replace(/^(re|fw|fwd|aw|sv|odp|rv):\s*/gi, '')
    .trim();
  if (cleaned.length > 0 && cleaned.toLowerCase() !== 'untitled bid') {
    return cleaned.slice(0, 240);
  }
  const senderLabel = customer?.name ?? customer?.address ?? 'unknown sender';
  const today = new Date().toISOString().slice(0, 10);
  const base = `Bid from ${senderLabel} ${today}`;
  return filename ? `${base} (${filename})`.slice(0, 240) : base.slice(0, 240);
}

// ---------------------------------------------------------------------------
// Auto-reply
// ---------------------------------------------------------------------------

async function sendAutoReply(args: {
  notification: AuthenticatedNotification;
  toAddress: string;
  toName: string | null;
  originalSubject: string;
  bidIds: string[];
}): Promise<void> {
  const subjectPrefix = /^re:\s*/i.test(args.originalSubject) ? '' : 'Re: ';
  const subject = `${subjectPrefix}${args.originalSubject}`.slice(0, 240);

  const bidLabel =
    args.bidIds.length === 1
      ? `Bid reference: <code>${args.bidIds[0]}</code>`
      : `Bid references: ${args.bidIds.map((id) => `<code>${id}</code>`).join(', ')}`;

  const greeting = args.toName
    ? `Hi ${escapeHtml(args.toName)},`
    : 'Hi,';

  const body =
    `<p>${greeting}</p>` +
    `<p>Your bid request has been received and is being processed by LMBR.ai.</p>` +
    `<p>${bidLabel}</p>` +
    `<p>You will receive a quote response in this email thread.</p>` +
    `<p>Thank you.</p>`;

  const result = await sendMail(
    args.notification.userId,
    args.notification.companyId,
    {
      to: args.toAddress,
      subject,
      body,
      html: true,
    },
  );
  if (!result.success) {
    console.warn(
      `LMBR.ai outlook webhook: auto-reply failed for subscriptionId=${args.notification.subscriptionId}: ${result.error ?? 'unknown'}.`,
    );
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
