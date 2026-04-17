/**
 * Microsoft Graph / Outlook integration.
 *
 * Purpose:  All server-side Outlook plumbing for LMBR.ai:
 *             1. OAuth delegated-flow auth (per-user refresh-token storage).
 *             2. Authenticated Graph client per (userId, companyId).
 *             3. Typed sendMail + template wrappers (dispatch, nudge,
 *                quote delivery, manager approvals).
 *             4. Graph change-notification subscription lifecycle
 *                (create / renew / bulk-renew-expiring-soon).
 *
 *           Emails always originate from the connected user's own Outlook
 *           account — never from a generic LMBR address. See CLAUDE.md
 *           non-negotiable rule #5. The design encodes that by requiring
 *           (userId, companyId) on every send: there is no "system" sender.
 *
 *           Token storage: access_token + refresh_token are AES-256-GCM
 *           encrypted (packages/lib/src/crypto.ts) before write to
 *           public.outlook_connections (migration 019). The DB holds only
 *           ciphertext; the OUTLOOK_TOKEN_ENCRYPTION_KEY lives in env so
 *           compromise of one layer (DB OR secret store) is insufficient.
 *
 *           Subscription storage: Graph subscriptions expire after ~3 days.
 *           public.outlook_subscriptions (migration 020) tracks the Graph
 *           subscription id, resource path, expiration, and clientState
 *           HMAC secret used to validate inbound webhook payloads.
 *           renewAllExpiringSoon() is the function a cron (Prompt 11) will
 *           call to keep subscriptions alive.
 *
 *           State parameter for OAuth: signed with HMAC-SHA256 using
 *           OUTLOOK_CLIENT_STATE_SECRET. Payload carries companyId, userId,
 *           a random nonce, and issuedAt. Verified on the callback via
 *           timingSafeEqual — same pattern as vendor-token.ts.
 *
 * Inputs:   MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET,
 *           MICROSOFT_TENANT_ID, MICROSOFT_REDIRECT_URI,
 *           OUTLOOK_TOKEN_ENCRYPTION_KEY, OUTLOOK_CLIENT_STATE_SECRET,
 *           NEXT_PUBLIC_APP_URL.
 * Outputs:  getAuthUrl, handleAuthCallback, getGraphClient, sendMail,
 *           sendDispatchToVendor, sendVendorNudge, sendQuoteToCustomer,
 *           sendApprovalNotification, sendApprovalResult,
 *           createSubscription, renewSubscription, renewAllExpiringSoon,
 *           verifyOutlookClientState, OutlookMailResult, OutlookConnection.
 * Agent/API: Microsoft Graph API (delegated).
 * Imports:  @azure/msal-node, @microsoft/microsoft-graph-client,
 *           node:crypto, ./crypto, ./supabase.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import {
  ConfidentialClientApplication,
  type AuthenticationResult,
  type Configuration as MsalConfiguration,
} from '@azure/msal-node';
import { Client as GraphClient } from '@microsoft/microsoft-graph-client';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { decrypt, encrypt } from './crypto';
import { getSupabaseAdmin } from './supabase';

// ---------------------------------------------------------------------------
// Config + singletons
// ---------------------------------------------------------------------------

/**
 * Delegated-flow scopes. `offline_access` is what mints the refresh_token
 * we later cache. `User.Read` is required to resolve the authenticated
 * mailbox identity (email + displayName) shown in the settings UI.
 */
export const OUTLOOK_SCOPES = [
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'offline_access',
  'User.Read',
];

/** State-param TTL — OAuth round trips complete in seconds, not minutes. */
const STATE_TTL_MS = 10 * 60 * 1000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(
      `LMBR.ai Outlook: missing ${name} environment variable. ` +
        `Populate it in apps/web/.env.local before invoking the Outlook flow.`,
    );
  }
  return value;
}

let msalSingleton: ConfidentialClientApplication | null = null;

export function getMsalApp(): ConfidentialClientApplication {
  if (msalSingleton) return msalSingleton;
  const config: MsalConfiguration = {
    auth: {
      clientId: requireEnv('MICROSOFT_CLIENT_ID'),
      clientSecret: requireEnv('MICROSOFT_CLIENT_SECRET'),
      authority: `https://login.microsoftonline.com/${requireEnv('MICROSOFT_TENANT_ID')}`,
    },
  };
  msalSingleton = new ConfidentialClientApplication(config);
  return msalSingleton;
}

function getRedirectUri(): string {
  return requireEnv('MICROSOFT_REDIRECT_URI');
}

// ---------------------------------------------------------------------------
// State parameter (CSRF defense on OAuth callback)
// ---------------------------------------------------------------------------

interface OutlookStatePayload {
  companyId: string;
  userId: string;
  nonce: string;
  issuedAt: number;
}

function stateSecret(): string {
  return requireEnv('OUTLOOK_CLIENT_STATE_SECRET');
}

function signState(payload: OutlookStatePayload): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const sig = createHmac('sha256', stateSecret()).update(payloadB64).digest();
  return payloadB64 + '.' + sig.toString('base64url');
}

/**
 * Verify and decode a signed state parameter. Returns null on any failure
 * — bad format, bad signature, expired, missing secret. Callers must
 * collapse all null cases into a generic auth error and never surface
 * which specific check failed.
 */
export function verifyOutlookState(state: string): OutlookStatePayload | null {
  if (typeof state !== 'string' || state.length === 0) return null;
  let secret: string;
  try {
    secret = stateSecret();
  } catch {
    return null;
  }
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  const presented = Buffer.from(sigB64, 'base64url');
  const expected = createHmac('sha256', secret).update(payloadB64).digest();
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== 'object') return null;
  const obj = decoded as Record<string, unknown>;
  const { companyId, userId, nonce, issuedAt } = obj;
  if (
    typeof companyId !== 'string' ||
    typeof userId !== 'string' ||
    typeof nonce !== 'string' ||
    typeof issuedAt !== 'number' ||
    !Number.isFinite(issuedAt)
  ) {
    return null;
  }
  if (Date.now() - issuedAt > STATE_TTL_MS || Date.now() < issuedAt) return null;
  return { companyId, userId, nonce, issuedAt };
}

/**
 * Subscription clientState validation — same primitive, different secret.
 * Graph echoes the clientState back on every change notification; we HMAC
 * it against the subscription row to defeat webhook spoofing.
 */
export function verifyOutlookClientState(
  presented: string,
  storedClientState: string,
): boolean {
  if (typeof presented !== 'string' || typeof storedClientState !== 'string') {
    return false;
  }
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(storedClientState, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Connection row shape
// ---------------------------------------------------------------------------

export interface OutlookConnection {
  id: string;
  userId: string;
  companyId: string;
  email: string;
  displayName: string | null;
  connectedAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  status: 'active' | 'expired' | 'revoked';
}

interface OutlookConnectionRow {
  id: string;
  user_id: string;
  company_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  email: string;
  display_name: string | null;
  connected_at: string;
  last_used_at: string | null;
  status: 'active' | 'expired' | 'revoked';
}

function rowToConnection(row: OutlookConnectionRow): OutlookConnection {
  return {
    id: row.id,
    userId: row.user_id,
    companyId: row.company_id,
    email: row.email,
    displayName: row.display_name,
    connectedAt: row.connected_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

async function loadConnectionRow(
  userId: string,
  companyId: string,
): Promise<OutlookConnectionRow | null> {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('outlook_connections')
    .select(
      'id, user_id, company_id, access_token, refresh_token, expires_at, email, display_name, connected_at, last_used_at, status',
    )
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) {
    throw new Error(`outlook: failed to load connection: ${error.message}`);
  }
  return (data as OutlookConnectionRow | null) ?? null;
}

/**
 * Public read — returns the metadata safe to render in the settings UI.
 * Never returns the encrypted tokens, by construction.
 */
export async function getOutlookConnection(
  userId: string,
  companyId: string,
): Promise<OutlookConnection | null> {
  const row = await loadConnectionRow(userId, companyId);
  return row ? rowToConnection(row) : null;
}

// ---------------------------------------------------------------------------
// OAuth: URL generation + callback exchange
// ---------------------------------------------------------------------------

export async function getAuthUrl(
  companyId: string,
  userId: string,
): Promise<string> {
  if (!companyId || !userId) {
    throw new Error('outlook.getAuthUrl: companyId and userId are required.');
  }
  const state = signState({
    companyId,
    userId,
    nonce: randomUUID(),
    issuedAt: Date.now(),
  });
  const app = getMsalApp();
  return app.getAuthCodeUrl({
    scopes: OUTLOOK_SCOPES,
    redirectUri: getRedirectUri(),
    state,
    prompt: 'select_account',
  });
}

export interface OutlookCallbackResult {
  success: true;
  email: string;
  displayName: string | null;
  userId: string;
  companyId: string;
}

/**
 * Completes the OAuth delegated-flow handshake.
 * Validates the state HMAC, exchanges the code for tokens, pulls the
 * mailbox identity from /me, encrypts the tokens, and upserts the
 * outlook_connections row. Throws on any validation failure — the caller
 * (settings callback route) must catch and render a generic error.
 */
export async function handleAuthCallback(
  code: string,
  state: string,
): Promise<OutlookCallbackResult> {
  if (!code || code.length === 0) {
    throw new Error('outlook.handleAuthCallback: missing authorization code.');
  }
  const payload = verifyOutlookState(state);
  if (!payload) {
    throw new Error('outlook.handleAuthCallback: invalid or expired state.');
  }
  const { companyId, userId } = payload;

  const app = getMsalApp();
  const auth = await app.acquireTokenByCode({
    code,
    scopes: OUTLOOK_SCOPES,
    redirectUri: getRedirectUri(),
  });
  if (!auth || !auth.accessToken) {
    throw new Error('outlook.handleAuthCallback: token exchange returned no access token.');
  }
  if (!auth.account) {
    throw new Error('outlook.handleAuthCallback: token exchange returned no account.');
  }

  const refreshToken = extractRefreshTokenFromCache(app, auth.account.homeAccountId);
  if (!refreshToken) {
    throw new Error(
      'outlook.handleAuthCallback: no refresh_token in MSAL cache — confirm ' +
        '`offline_access` scope is present and the Azure AD app has refresh ' +
        'tokens enabled.',
    );
  }

  // Resolve mailbox identity via /me using the just-minted access token.
  const client = graphClientFromAccessToken(auth.accessToken);
  interface MeResponse {
    mail?: string | null;
    userPrincipalName?: string | null;
    displayName?: string | null;
  }
  const me = (await client.api('/me').get()) as MeResponse;
  const email = me?.mail ?? me?.userPrincipalName ?? auth.account.username;
  const displayName = me?.displayName ?? auth.account.name ?? null;

  if (!email) {
    throw new Error('outlook.handleAuthCallback: could not resolve mailbox email.');
  }

  const expiresAt =
    auth.expiresOn instanceof Date
      ? auth.expiresOn.toISOString()
      : new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const admin = getSupabaseAdmin();
  const { error } = await admin.from('outlook_connections').upsert(
    {
      user_id: userId,
      company_id: companyId,
      access_token: encrypt(auth.accessToken),
      refresh_token: encrypt(refreshToken),
      expires_at: expiresAt,
      email,
      display_name: displayName,
      connected_at: new Date().toISOString(),
      last_used_at: null,
      status: 'active' as const,
    },
    { onConflict: 'user_id,company_id' },
  );
  if (error) {
    throw new Error(`outlook.handleAuthCallback: upsert failed: ${error.message}`);
  }

  return { success: true, email, displayName, userId, companyId };
}

/**
 * MSAL Node v2 does not expose the refresh_token on AuthenticationResult.
 * It lives in the token cache; the documented extraction path is to
 * serialize the cache and pull the RefreshToken entry whose key matches
 * the account's homeAccountId. This is stable across MSAL Node v2 minor
 * versions but sits on an internal cache shape — if MSAL changes the
 * format in a major bump, this helper is the one place to patch.
 */
function extractRefreshTokenFromCache(
  app: ConfidentialClientApplication,
  homeAccountId: string,
): string | null {
  let serialized: string;
  try {
    serialized = app.getTokenCache().serialize();
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const cache = parsed as { RefreshToken?: Record<string, { secret?: string }> };
  const rt = cache.RefreshToken;
  if (!rt || typeof rt !== 'object') return null;
  for (const [key, value] of Object.entries(rt)) {
    if (key.startsWith(homeAccountId) && value && typeof value.secret === 'string') {
      return value.secret;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Access token refresh + GraphClient factory
// ---------------------------------------------------------------------------

/** Refresh if the stored access_token expires within this window. */
const REFRESH_SKEW_MS = 60 * 1000;

function graphClientFromAccessToken(accessToken: string): GraphClient {
  return GraphClient.init({
    authProvider: (done) => done(null, accessToken),
    defaultVersion: 'v1.0',
  });
}

async function refreshAccessToken(
  row: OutlookConnectionRow,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: string }> {
  const app = getMsalApp();
  const decryptedRefresh = decrypt(row.refresh_token);
  const auth: AuthenticationResult | null = await app.acquireTokenByRefreshToken({
    refreshToken: decryptedRefresh,
    scopes: OUTLOOK_SCOPES,
  });
  if (!auth || !auth.accessToken) {
    throw new Error('outlook: refresh_token exchange returned no access token.');
  }

  // Graph may or may not rotate the refresh_token; if it does, the new one
  // lands in the MSAL cache. Pull it back out so we persist whichever is
  // current and never end up running off a revoked one.
  let newRefresh = decryptedRefresh;
  if (auth.account) {
    const fromCache = extractRefreshTokenFromCache(app, auth.account.homeAccountId);
    if (fromCache) newRefresh = fromCache;
  }

  const expiresAt =
    auth.expiresOn instanceof Date
      ? auth.expiresOn.toISOString()
      : new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from('outlook_connections')
    .update({
      access_token: encrypt(auth.accessToken),
      refresh_token: encrypt(newRefresh),
      expires_at: expiresAt,
      status: 'active' as const,
      last_used_at: new Date().toISOString(),
    })
    .eq('id', row.id);
  if (error) {
    throw new Error(`outlook: refresh write failed: ${error.message}`);
  }

  return { accessToken: auth.accessToken, refreshToken: newRefresh, expiresAt };
}

/**
 * Hydrate a Graph client authenticated as the given (userId, companyId).
 * If the stored access_token is within REFRESH_SKEW_MS of expiry (or past
 * it) the refresh_token is used to mint a new one; the new access token
 * and any rotated refresh_token are persisted before the client is
 * returned. Throws if no connection exists, the row is revoked/expired,
 * or the refresh exchange fails — callers must surface a "reconnect
 * required" UX rather than silently dropping mail.
 */
export async function getGraphClient(
  userId: string,
  companyId: string,
): Promise<GraphClient> {
  const row = await loadConnectionRow(userId, companyId);
  if (!row) {
    throw new Error(
      `outlook.getGraphClient: no connection for user=${userId} company=${companyId} — user must connect via /settings/integrations first.`,
    );
  }
  if (row.status !== 'active') {
    throw new Error(
      `outlook.getGraphClient: connection status is '${row.status}' — user must reconnect.`,
    );
  }

  const expiresMs = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresMs) || expiresMs - Date.now() < REFRESH_SKEW_MS) {
    const refreshed = await refreshAccessToken(row);
    return graphClientFromAccessToken(refreshed.accessToken);
  }

  // Fire-and-forget last_used_at stamp — not fatal on failure.
  void getSupabaseAdmin()
    .from('outlook_connections')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', row.id);

  return graphClientFromAccessToken(decrypt(row.access_token));
}

// ---------------------------------------------------------------------------
// sendMail + template wrappers
// ---------------------------------------------------------------------------

export interface OutlookAttachment {
  name: string;
  contentType: string;
  bytes: Buffer;
}

export interface OutlookMailParams {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  body: string;
  /** Treat `body` as HTML if true (default), plain text if false. */
  html?: boolean;
  attachments?: OutlookAttachment[];
}

/**
 * Stable short-code error classification for sendMail failures. Callers
 * (dispatch, nudge, quote send) branch on these to decide whether to
 * surface "connect your Outlook" UX vs a generic retry banner, without
 * pattern-matching the free-text message. Unknown failures return
 * `send_failed` with the underlying message in `error` for diagnostics.
 */
export type OutlookMailErrorCode =
  | 'outlook_not_connected'
  | 'outlook_needs_reauth'
  | 'send_failed';

export interface OutlookMailResult {
  success: boolean;
  /** Stable short code; callers should switch on this, not on `error`. */
  errorCode?: OutlookMailErrorCode;
  /** Human-readable detail for ops logs. Never contains tokens or secrets. */
  error?: string;
}

function toRecipients(
  value: string | string[] | undefined,
): Array<{ emailAddress: { address: string } }> {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter((s) => typeof s === 'string' && s.length > 0)
    .map((address) => ({ emailAddress: { address } }));
}

/**
 * Send a mail from the connected user's own mailbox. Never throws to the
 * caller — all failures are returned as { success: false, error }. This
 * lets callers (e.g. the buyer dispatch route) degrade gracefully when
 * the user hasn't connected Outlook yet, without aborting the wider flow.
 */
export async function sendMail(
  userId: string,
  companyId: string,
  params: OutlookMailParams,
): Promise<OutlookMailResult> {
  try {
    const client = await getGraphClient(userId, companyId);

    const attachments = (params.attachments ?? []).map((a) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.name,
      contentType: a.contentType,
      contentBytes: a.bytes.toString('base64'),
    }));

    const body = {
      message: {
        subject: params.subject,
        body: {
          contentType: params.html === false ? 'Text' : 'HTML',
          content: params.body,
        },
        toRecipients: toRecipients(params.to),
        ccRecipients: toRecipients(params.cc),
        attachments: attachments.length > 0 ? attachments : undefined,
      },
      saveToSentItems: true,
    };

    await client.api('/me/sendMail').post(body);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Intentionally terse — never echo tokens or request bodies.
    console.warn(`LMBR.ai outlook.sendMail failed: ${message}`);
    return {
      success: false,
      errorCode: classifyMailError(message),
      error: message,
    };
  }
}

function classifyMailError(message: string): OutlookMailErrorCode {
  // getGraphClient throws a stable message when no connection row exists.
  if (/no connection for user=/.test(message)) {
    return 'outlook_not_connected';
  }
  // Same for 'expired' or 'revoked' connection rows — the user must go
  // re-consent through /settings/integrations.
  if (/connection status is '(expired|revoked)'/.test(message)) {
    return 'outlook_needs_reauth';
  }
  // Graph itself returned 401 — refresh_token revoked upstream.
  if (/InvalidAuthenticationToken|401/.test(message)) {
    return 'outlook_needs_reauth';
  }
  return 'send_failed';
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDueByForEmail(dueByIso: string): string {
  const d = new Date(dueByIso);
  if (Number.isNaN(d.getTime())) return dueByIso;
  // Server-side format; the richer companies.timezone-aware formatter lives
  // in apps/web/src/lib/format-datetime and threads through PDFs. Prompt 08
  // hand-off note covers threading timezone through the mail template too.
  return d.toUTCString().replace(' GMT', ' UTC');
}

// --- Dispatch ---------------------------------------------------------------

export interface SendDispatchToVendorParams {
  vendor: { name: string; email: string };
  bid: {
    jobName: string | null;
    customerName: string | null;
    jobLocation?: string | null;
    dueByIso: string;
  };
  lineItemCount: number;
  formUrl: string;
  pdfBuffer?: Buffer;
  pdfFilename?: string;
  /**
   * Per-company subject override from companies.dispatch_email_subject
   * (migration 023). When provided, wins over the default subject line
   * built from job/dueby. No placeholder interpolation today.
   */
  subjectOverride?: string | null;
}

export async function sendDispatchToVendor(
  userId: string,
  companyId: string,
  params: SendDispatchToVendorParams,
): Promise<OutlookMailResult> {
  const job = params.bid.jobName ?? params.bid.customerName ?? 'RFQ';
  const dueLabel = formatDueByForEmail(params.bid.dueByIso);
  const defaultSubject = `Lumber bid request — ${job} — due ${dueLabel}`;
  const subject =
    params.subjectOverride && params.subjectOverride.trim().length > 0
      ? params.subjectOverride
      : defaultSubject;

  const lines: string[] = [
    `<p>Hi ${escapeHtml(params.vendor.name)},</p>`,
    `<p>Pricing requested for <strong>${escapeHtml(job)}</strong>` +
      (params.bid.jobLocation
        ? ` (${escapeHtml(params.bid.jobLocation)})`
        : '') +
      `.</p>`,
    `<p>${params.lineItemCount} line item${params.lineItemCount === 1 ? '' : 's'} — please submit pricing by <strong>${escapeHtml(dueLabel)}</strong>.</p>`,
    `<p><a href="${params.formUrl}">Submit pricing</a></p>`,
  ];
  if (params.pdfBuffer) {
    lines.push(
      `<p>A printable tally sheet is attached for hand-written pricing. ` +
        `Scan the marked-up sheet and reply to this email — we'll OCR it ` +
        `back into the bid.</p>`,
    );
  }
  lines.push(`<p>Thank you.</p>`);

  const mailParams: OutlookMailParams = {
    to: params.vendor.email,
    subject,
    body: lines.join(''),
    html: true,
  };
  if (params.pdfBuffer && params.pdfFilename) {
    mailParams.attachments = [
      {
        name: params.pdfFilename,
        contentType: 'application/pdf',
        bytes: params.pdfBuffer,
      },
    ];
  }
  return sendMail(userId, companyId, mailParams);
}

// --- Nudge ------------------------------------------------------------------

export interface SendVendorNudgeParams {
  vendor: { name: string; email: string };
  bid: { jobName: string | null; customerName: string | null; dueByIso: string };
  hoursRemaining: number;
  formUrl: string;
  /** Override from companies.nudge_email_subject. Null = default. */
  subjectOverride?: string | null;
}

export async function sendVendorNudge(
  userId: string,
  companyId: string,
  params: SendVendorNudgeParams,
): Promise<OutlookMailResult> {
  const job = params.bid.jobName ?? params.bid.customerName ?? 'RFQ';
  const hrs = Math.max(0, Math.round(params.hoursRemaining));
  const defaultSubject = `Following up — ${job} bid due in ${hrs} hour${hrs === 1 ? '' : 's'}`;
  const subject =
    params.subjectOverride && params.subjectOverride.trim().length > 0
      ? params.subjectOverride
      : defaultSubject;
  const body =
    `<p>Hi ${escapeHtml(params.vendor.name)},</p>` +
    `<p>Checking in on the <strong>${escapeHtml(job)}</strong> bid — we're looking to close pricing in ${hrs} hour${hrs === 1 ? '' : 's'}.</p>` +
    `<p>If the submission link below still works, a quick reply with pricing would be appreciated:</p>` +
    `<p><a href="${params.formUrl}">Submit pricing</a></p>` +
    `<p>Thanks.</p>`;
  return sendMail(userId, companyId, {
    to: params.vendor.email,
    subject,
    body,
    html: true,
  });
}

// --- Quote delivery ---------------------------------------------------------

export interface SendQuoteToCustomerParams {
  customer: { name: string | null; email: string };
  quote: {
    jobName: string | null;
    quoteNumber: string | number;
    validUntilIso?: string | null;
  };
  pdfBuffer: Buffer;
  pdfFilename: string;
  ccCurrentUser?: boolean;
  ccEmail?: string;
  /** Override from companies.quote_email_subject. Null = default. */
  subjectOverride?: string | null;
}

export async function sendQuoteToCustomer(
  userId: string,
  companyId: string,
  params: SendQuoteToCustomerParams,
): Promise<OutlookMailResult> {
  const job = params.quote.jobName ?? 'your project';
  const validThrough = params.quote.validUntilIso
    ? ` — valid until ${formatDueByForEmail(params.quote.validUntilIso)}`
    : '';
  const defaultSubject = `Quote for ${job}${validThrough}`;
  const subject =
    params.subjectOverride && params.subjectOverride.trim().length > 0
      ? params.subjectOverride
      : defaultSubject;
  const body =
    `<p>Hi${params.customer.name ? ` ${escapeHtml(params.customer.name)}` : ''},</p>` +
    `<p>Attached is quote <strong>#${escapeHtml(String(params.quote.quoteNumber))}</strong> for <strong>${escapeHtml(job)}</strong>.</p>` +
    (params.quote.validUntilIso
      ? `<p>Pricing valid through <strong>${escapeHtml(formatDueByForEmail(params.quote.validUntilIso))}</strong>.</p>`
      : '') +
    `<p>Let me know if you'd like to discuss any of the line items.</p>` +
    `<p>Thank you.</p>`;

  const mailParams: OutlookMailParams = {
    to: params.customer.email,
    subject,
    body,
    html: true,
    attachments: [
      {
        name: params.pdfFilename,
        contentType: 'application/pdf',
        bytes: params.pdfBuffer,
      },
    ],
  };
  if (params.ccEmail) {
    mailParams.cc = params.ccEmail;
  }
  return sendMail(userId, companyId, mailParams);
}

// --- Approval notifications -------------------------------------------------

export interface SendApprovalNotificationParams {
  manager: { name: string | null; email: string };
  quote: {
    jobName: string | null;
    customerName: string | null;
    total: number;
    blendedMarginPercent: number;
    approvalUrl: string;
  };
  submittedBy: string;
}

export async function sendApprovalNotification(
  userId: string,
  companyId: string,
  params: SendApprovalNotificationParams,
): Promise<OutlookMailResult> {
  const job = params.quote.jobName ?? params.quote.customerName ?? 'Quote';
  const subject = `Approval requested — ${job} — $${params.quote.total.toFixed(2)}`;
  const body =
    `<p>Hi${params.manager.name ? ` ${escapeHtml(params.manager.name)}` : ''},</p>` +
    `<p><strong>${escapeHtml(params.submittedBy)}</strong> has submitted a quote for approval.</p>` +
    `<ul>` +
    `<li>Job: ${escapeHtml(job)}</li>` +
    `<li>Total: $${params.quote.total.toFixed(2)}</li>` +
    `<li>Blended margin: ${params.quote.blendedMarginPercent.toFixed(2)}%</li>` +
    `</ul>` +
    `<p><a href="${params.quote.approvalUrl}">Review and approve</a></p>`;
  return sendMail(userId, companyId, {
    to: params.manager.email,
    subject,
    body,
    html: true,
  });
}

export interface SendApprovalResultParams {
  trader: { name: string | null; email: string };
  quote: {
    jobName: string | null;
    quoteNumber: string | number;
    action: 'approve' | 'request_changes' | 'reject';
    notes?: string | null;
    quoteUrl: string;
  };
}

export async function sendApprovalResult(
  userId: string,
  companyId: string,
  params: SendApprovalResultParams,
): Promise<OutlookMailResult> {
  const action = params.quote.action;
  const verb =
    action === 'approve'
      ? 'approved'
      : action === 'request_changes'
        ? 'returned with changes requested'
        : 'declined';
  const job = params.quote.jobName ?? `quote #${params.quote.quoteNumber}`;
  const subject = `Quote ${verb} — ${job}`;
  const body =
    `<p>Hi${params.trader.name ? ` ${escapeHtml(params.trader.name)}` : ''},</p>` +
    `<p>Your quote for <strong>${escapeHtml(job)}</strong> has been <strong>${verb}</strong>.</p>` +
    (params.quote.notes
      ? `<p>Notes: ${escapeHtml(params.quote.notes)}</p>`
      : '') +
    `<p><a href="${params.quote.quoteUrl}">Open the quote</a></p>`;
  return sendMail(userId, companyId, {
    to: params.trader.email,
    subject,
    body,
    html: true,
  });
}

// ---------------------------------------------------------------------------
// Subscription lifecycle
// ---------------------------------------------------------------------------

/** Graph subscriptions for messages max out at ~4230 min (≈3 days). */
const SUBSCRIPTION_TTL_MS = 3 * 24 * 60 * 60 * 1000 - 5 * 60 * 1000;

/** When a subscription is within this of expiry, renewAllExpiringSoon will renew it. */
const RENEWAL_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface CreateSubscriptionResult {
  subscriptionId: string;
  resource: string;
  expirationDateTime: string;
  clientState: string;
}

interface GraphSubscriptionResponse {
  id: string;
  resource: string;
  changeType: string;
  clientState?: string;
  notificationUrl?: string;
  expirationDateTime: string;
}

function notificationUrl(): string {
  const base = requireEnv('NEXT_PUBLIC_APP_URL').replace(/\/+$/, '');
  return `${base}/api/webhook/outlook`;
}

function mintClientState(): string {
  // Pure random bytes — not HMAC of anything — so the secret value is only
  // ever known to Graph and the subscription row. We compare it verbatim
  // on inbound webhooks via verifyOutlookClientState (constant-time).
  return Buffer.concat([
    Buffer.from(randomUUID(), 'utf8'),
    Buffer.from(randomUUID(), 'utf8'),
  ])
    .toString('base64url')
    .slice(0, 128);
}

/**
 * Create a Graph change-notification subscription on `users/{email}/messages`
 * for the connected user, and persist the subscription row. The clientState
 * is stored server-side; every inbound webhook must present it.
 */
export async function createSubscription(
  userId: string,
  companyId: string,
  mailboxEmail: string,
): Promise<CreateSubscriptionResult> {
  if (!mailboxEmail || mailboxEmail.length === 0) {
    throw new Error('outlook.createSubscription: mailboxEmail required.');
  }
  const client = await getGraphClient(userId, companyId);
  const clientState = mintClientState();
  const resource = `users/${mailboxEmail}/messages`;
  const expirationIso = new Date(Date.now() + SUBSCRIPTION_TTL_MS).toISOString();

  const created = (await client.api('/subscriptions').post({
    changeType: 'created',
    notificationUrl: notificationUrl(),
    resource,
    expirationDateTime: expirationIso,
    clientState,
  })) as GraphSubscriptionResponse;

  const admin = getSupabaseAdmin();
  const { error } = await admin.from('outlook_subscriptions').insert({
    company_id: companyId,
    user_id: userId,
    subscription_id: created.id,
    resource: created.resource ?? resource,
    expiration_datetime: created.expirationDateTime ?? expirationIso,
    client_state: clientState,
    last_renewed_at: new Date().toISOString(),
    status: 'active' as const,
  });
  if (error) {
    // Best-effort tear-down — we leaked a subscription at Graph but didn't
    // persist it, so the renewal job can't touch it. Manual cleanup:
    // DELETE /subscriptions/{id}. Surfacing the error so ops sees it.
    console.warn(
      `outlook.createSubscription: row insert failed after Graph create — subscription ${created.id} leaked; ${error.message}`,
    );
    throw new Error(`outlook.createSubscription: ${error.message}`);
  }

  return {
    subscriptionId: created.id,
    resource: created.resource ?? resource,
    expirationDateTime: created.expirationDateTime ?? expirationIso,
    clientState,
  };
}

export interface RenewSubscriptionResult {
  subscriptionId: string;
  expirationDateTime: string;
  recreated: boolean;
}

/**
 * PATCH the subscription expiration on Graph and bump our row. If Graph
 * returns 404 (subscription deleted server-side, usually because it
 * expired before we got here), we recreate it from scratch so the
 * change-notification stream resumes instead of silently going dead.
 */
export async function renewSubscription(
  subscriptionId: string,
): Promise<RenewSubscriptionResult> {
  const admin = getSupabaseAdmin();
  const { data: row, error: loadError } = await admin
    .from('outlook_subscriptions')
    .select('id, company_id, user_id, subscription_id, resource, client_state, status')
    .eq('subscription_id', subscriptionId)
    .maybeSingle();
  if (loadError) {
    throw new Error(`outlook.renewSubscription: load failed: ${loadError.message}`);
  }
  if (!row) {
    throw new Error(`outlook.renewSubscription: no row for subscriptionId=${subscriptionId}.`);
  }

  const subRow = row as {
    id: string;
    company_id: string;
    user_id: string;
    subscription_id: string;
    resource: string;
    client_state: string;
    status: 'active' | 'degraded' | 'expired';
  };

  const client = await getGraphClient(subRow.user_id, subRow.company_id);
  const newExpiration = new Date(Date.now() + SUBSCRIPTION_TTL_MS).toISOString();

  try {
    const updated = (await client.api(`/subscriptions/${subscriptionId}`).patch({
      expirationDateTime: newExpiration,
    })) as GraphSubscriptionResponse;

    await admin
      .from('outlook_subscriptions')
      .update({
        expiration_datetime: updated.expirationDateTime ?? newExpiration,
        last_renewed_at: new Date().toISOString(),
        status: 'active' as const,
      })
      .eq('id', subRow.id);

    return {
      subscriptionId,
      expirationDateTime: updated.expirationDateTime ?? newExpiration,
      recreated: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/404|Not[- ]?Found|NotFound|The specified object was not found/i.test(message)) {
      // Graph dropped it — recreate so the mailbox doesn't silently stop
      // receiving notifications. Extract the email from the resource path
      // `users/{email}/messages`.
      const emailMatch = /^users\/([^/]+)\/messages$/.exec(subRow.resource);
      const mailboxEmail = emailMatch ? emailMatch[1] : null;
      if (!mailboxEmail) {
        await admin
          .from('outlook_subscriptions')
          .update({ status: 'expired' as const })
          .eq('id', subRow.id);
        throw new Error(
          `outlook.renewSubscription: subscription gone and cannot parse mailbox from resource='${subRow.resource}'.`,
        );
      }
      // Delete the old row first so the unique(subscription_id) index
      // doesn't block the recreate's insert.
      await admin.from('outlook_subscriptions').delete().eq('id', subRow.id);
      const recreated = await createSubscription(
        subRow.user_id,
        subRow.company_id,
        mailboxEmail,
      );
      return {
        subscriptionId: recreated.subscriptionId,
        expirationDateTime: recreated.expirationDateTime,
        recreated: true,
      };
    }

    await admin
      .from('outlook_subscriptions')
      .update({ status: 'degraded' as const })
      .eq('id', subRow.id);
    throw new Error(`outlook.renewSubscription: ${message}`);
  }
}

export interface RenewAllResult {
  scanned: number;
  renewed: number;
  recreated: number;
  failed: Array<{ subscriptionId: string; error: string }>;
}

/**
 * Bulk-renew every active subscription whose expiration falls within the
 * renewal window (next 48h). Returns per-row outcomes so a cron job can
 * log + alert on partial failures. Never throws to the caller — every
 * failure is captured in the `failed[]` array.
 */
export async function renewAllExpiringSoon(): Promise<RenewAllResult> {
  const admin = getSupabaseAdmin();
  const horizonIso = new Date(Date.now() + RENEWAL_WINDOW_MS).toISOString();

  const { data, error } = await admin
    .from('outlook_subscriptions')
    .select('subscription_id')
    .eq('status', 'active')
    .lt('expiration_datetime', horizonIso);
  if (error) {
    return {
      scanned: 0,
      renewed: 0,
      recreated: 0,
      failed: [{ subscriptionId: '*', error: error.message }],
    };
  }
  const rows = (data ?? []) as Array<{ subscription_id: string }>;

  const result: RenewAllResult = {
    scanned: rows.length,
    renewed: 0,
    recreated: 0,
    failed: [],
  };

  for (const r of rows) {
    try {
      const outcome = await renewSubscription(r.subscription_id);
      if (outcome.recreated) result.recreated += 1;
      else result.renewed += 1;
    } catch (err) {
      result.failed.push({
        subscriptionId: r.subscription_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Legacy shim — kept to avoid breaking callers that predate this rewrite
// ---------------------------------------------------------------------------

/**
 * Fetch a message's attachments by id. Requires the caller to also supply
 * (userId, companyId) so we know which mailbox to pull from. Left here so
 * the webhook handler (Prompt 08 step 2) has a drop-in. Kept async + typed.
 */
export async function fetchMessageAttachments(
  userId: string,
  companyId: string,
  messageId: string,
): Promise<Array<{ name: string; contentType: string; bytes: Uint8Array }>> {
  const client = await getGraphClient(userId, companyId);
  interface AttachmentsResponse {
    value?: Array<{
      '@odata.type'?: string;
      name?: string;
      contentType?: string;
      contentBytes?: string;
    }>;
  }
  const res = (await client
    .api(`/me/messages/${messageId}/attachments`)
    .get()) as AttachmentsResponse;

  const out: Array<{ name: string; contentType: string; bytes: Uint8Array }> = [];
  for (const a of res.value ?? []) {
    if (a['@odata.type'] !== '#microsoft.graph.fileAttachment') continue;
    if (!a.contentBytes || !a.name) continue;
    out.push({
      name: a.name,
      contentType: a.contentType ?? 'application/octet-stream',
      bytes: Buffer.from(a.contentBytes, 'base64'),
    });
  }
  return out;
}
