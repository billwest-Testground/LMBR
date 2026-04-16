#!/usr/bin/env tsx
/**
 * LMBR.ai end-to-end smoke test — HTTP variant.
 *
 * Purpose:  Exercises the same 9-step bid lifecycle as scripts/smoke-e2e.ts
 *           (Option A), but drives every step through the real Next.js
 *           /api/* route handlers instead of calling helpers directly.
 *           Catches bugs Option A can't reach:
 *             - session cookie handling + middleware redirects
 *             - Zod request body validation drift
 *             - response shape drift between server and UI consumers
 *             - role-gate HTTP codes (401 / 403 / 409)
 *
 *           Pipeline exercised (all over HTTP):
 *             1. Ingest        — POST /api/ingest (multipart xlsx)
 *             2. Routing       — POST /api/route-bid
 *             3. Consolidation — POST /api/consolidate (HYBRID)
 *             4. Dispatch      — POST /api/vendors/dispatch
 *             5. Vendor submit — GET  /vendor-submit/[token]
 *                                POST /api/vendor-submit
 *             6. Comparison    — GET  /api/compare/[bidId]
 *             7. Margin        — POST /api/margin
 *             8. PDF preview   — POST /api/quote (action=preview)
 *             9. Quote release — POST /api/quote (action=release)
 *
 * Run:      pnpm tsx scripts/smoke-e2e-http.ts
 * Requires: - Dev server at NEXT_PUBLIC_APP_URL (default http://localhost:3000)
 *           - SESSION_COOKIE env var — raw "Cookie:" header value copied
 *             from DevTools on a logged-in Supabase session whose user has
 *             role buyer / trader_buyer / manager / owner.
 *           - .env.local with SUPABASE_SERVICE_ROLE_KEY for pre-test seed
 *             + post-test cleanup.
 *           - VENDOR_TOKEN_SECRET (auto-synthesized if missing).
 *
 * Side effects:
 *           - Temporarily sets the cookie user's company
 *             `approval_threshold_dollars` to $10,000 and restores the
 *             original value in cleanup.
 *           - Inserts one [SMOKE-TEST-HTTP]-prefixed vendor in the cookie
 *             user's company; removed in cleanup.
 *
 * Agent/API: none — this script is pure HTTP integration.
 * Imports:  dotenv, exceljs, pdf-parse, @supabase/supabase-js.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

import ExcelJS from 'exceljs';
import {
  createClient,
  type SupabaseClient,
} from '@supabase/supabase-js';

// Load .env.local explicitly — dotenv/config only reads .env. The service-
// role key we need for seed/cleanup lives there.
import dotenv from 'dotenv';
const envLocalPath = pathResolve(__dirname, '..', '.env.local');
try {
  const envLocal = readFileSync(envLocalPath, 'utf8');
  const parsed = dotenv.parse(envLocal);
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined || process.env[k] === '') {
      process.env[k] = v;
    }
  }
} catch {
  /* .env.local is optional */
}

// Match Option A's deterministic fallback so local runs don't require an
// operator to hand-edit the env file.
if (!process.env.VENDOR_TOKEN_SECRET) {
  process.env.VENDOR_TOKEN_SECRET =
    'smoke-e2e-vendor-token-secret-deterministic-0123456789abcdef';
}

// -----------------------------------------------------------------------------
// Constants + context
// -----------------------------------------------------------------------------

const SMOKE_PREFIX = '[SMOKE-TEST-HTTP]';
const TIMESTAMP = Date.now();
const API_URL = (
  process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
).replace(/\/+$/, '');
const COOKIE = process.env.SESSION_COOKIE ?? '';
const APPROVAL_THRESHOLD_FOR_TEST = 10_000;

interface SmokeContext {
  admin?: SupabaseClient;
  authUserId?: string;
  userId?: string;
  companyId?: string;
  companySlug?: string;
  originalApprovalThreshold?: number | null;
  vendorId?: string;
  bidId?: string;
  vendorBidId?: string;
  token?: string;
  submitUrl?: string;
  printUrl?: string;
  vendorBidLineItemIds: string[];
  quoteId?: string;
  quoteNumber?: string;
  storageObjectPath?: string;
  quoteStoragePath?: string;
}

function createContext(): SmokeContext {
  return { vendorBidLineItemIds: [] };
}

// -----------------------------------------------------------------------------
// Assertion + step helpers — identical shape to Option A so output reads the
// same and grep-for-pass/fail stays boring.
// -----------------------------------------------------------------------------

class StepError extends Error {
  step: string;
  constructor(step: string, message: string) {
    super(message);
    this.step = step;
    this.name = 'StepError';
  }
}

function assert(
  step: string,
  condition: unknown,
  message: string,
  actual?: unknown,
): asserts condition {
  if (!condition) {
    const detail =
      actual !== undefined ? ` (actual: ${JSON.stringify(actual)})` : '';
    throw new StepError(step, message + detail);
  }
}

async function runStep(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  const label = `▸ ${name}...`;
  process.stdout.write(label + ' ');
  const started = Date.now();
  try {
    await fn();
    process.stdout.write(`✓ (${Date.now() - started}ms)\n`);
  } catch (err) {
    process.stdout.write('\n');
    if (err instanceof StepError) {
      console.error(`  ✗ Assertion failed: ${err.message}`);
      throw err;
    }
    const wrapped = new StepError(
      name,
      err instanceof Error ? err.message : String(err),
    );
    console.error(`  ✗ ${wrapped.message}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    throw wrapped;
  }
}

// -----------------------------------------------------------------------------
// HTTP helpers
// -----------------------------------------------------------------------------

interface FetchJsonInit {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  withCookie?: boolean;
}

async function fetchJson<T = unknown>(
  step: string,
  path: string,
  init: FetchJsonInit = {},
): Promise<T> {
  const url = path.startsWith('http') ? path : `${API_URL}${path}`;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.withCookie !== false) headers['Cookie'] = COOKIE;
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body,
    redirect: 'manual',
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (res.status >= 400) {
    const body =
      typeof parsed === 'string' ? parsed : JSON.stringify(parsed ?? {});
    throw new StepError(
      step,
      `${init.method ?? 'GET'} ${path} returned ${res.status}\n  Body: ${body}`,
    );
  }
  return parsed as T;
}

// Raw fetch for byte-stream endpoints (e.g. PDF preview). Returns the
// Response so the caller can read arrayBuffer() and check headers.
async function fetchRaw(
  step: string,
  path: string,
  init: FetchJsonInit = {},
): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_URL}${path}`;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.withCookie !== false) headers['Cookie'] = COOKIE;
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body,
    redirect: 'manual',
  });
  if (res.status >= 400) {
    const text = await res.text().catch(() => '');
    throw new StepError(
      step,
      `${init.method ?? 'GET'} ${path} returned ${res.status}\n  Body: ${text.slice(0, 500)}`,
    );
  }
  return res;
}

// -----------------------------------------------------------------------------
// Excel fixture — same 10 lines / 3 buildings shape as Option A
// -----------------------------------------------------------------------------

interface FixtureRow {
  building: string;
  species: string;
  dimension: string;
  grade: string;
  length: string;
  qty: number;
  unit: string;
}

const FIXTURE_ROWS: FixtureRow[] = [
  { building: 'House 1', species: 'SPF', dimension: '2x4', grade: '#2', length: '8', qty: 500, unit: 'PCS' },
  { building: 'House 1', species: 'SPF', dimension: '2x6', grade: '#2', length: '12', qty: 300, unit: 'PCS' },
  { building: 'House 1', species: 'DF', dimension: '4x4', grade: '#2', length: '10', qty: 50, unit: 'PCS' },
  { building: 'House 2', species: 'SPF', dimension: '2x4', grade: '#2', length: '8', qty: 400, unit: 'PCS' },
  { building: 'House 2', species: 'SPF', dimension: '2x8', grade: '#2', length: '14', qty: 200, unit: 'PCS' },
  { building: 'House 2', species: 'OSB', dimension: '4x8', grade: '#2', length: '8', qty: 150, unit: 'PCS' },
  { building: 'House 3', species: 'SPF', dimension: '2x4', grade: '#2', length: '8', qty: 200, unit: 'PCS' },
  { building: 'House 3', species: 'SPF', dimension: '2x10', grade: '#2', length: '16', qty: 80, unit: 'PCS' },
  { building: 'House 3', species: 'DF', dimension: '4x6', grade: '#2', length: '12', qty: 30, unit: 'PCS' },
  { building: 'House 3', species: 'HF', dimension: '2x6', grade: '#2', length: '14', qty: 250, unit: 'PCS' },
];

async function buildFixtureXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LMBR.ai smoke-e2e-http';
  const sheet = wb.addWorksheet('Lumber List');
  sheet.addRow([
    'Building',
    'Species',
    'Dimension',
    'Grade',
    'Length',
    'Qty',
    'Unit',
  ]);
  for (const r of FIXTURE_ROWS) {
    sheet.addRow([r.building, r.species, r.dimension, r.grade, r.length, r.qty, r.unit]);
  }
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}

// Price dictionary for Step 5 — same cost basis as Option A so PDF
// invariants (no "$420") transfer unchanged.
function costUnitPriceFor(species: string, dimension: string): number {
  if (species === 'SPF' || species === 'HF') return 420;
  if (species === 'DF') return 680;
  if (species === 'OSB' || species === 'Plywood') return 38;
  // Fallback — any extra species the consolidation agent invents.
  void dimension;
  return 400;
}

// -----------------------------------------------------------------------------
// Preflight — verify cookie + resolve user/company from JWT
// -----------------------------------------------------------------------------

function assertServiceRoleEnv(step: string): void {
  assert(
    step,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    'NEXT_PUBLIC_SUPABASE_URL missing — set .env.local',
  );
  assert(
    step,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    'SUPABASE_SERVICE_ROLE_KEY missing — set .env.local',
  );
}

function getAdmin(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/**
 * Extract the user id from the SESSION_COOKIE.
 *
 * Supabase auth-helpers ship two cookie shapes: the legacy split
 * `sb-access-token=<jwt>; sb-refresh-token=<jwt>` and the modern single
 * `sb-<ref>-auth-token=<base64-or-json>`. We decode either one just far
 * enough to pull the JWT's `sub` claim — we never validate the signature
 * (the Next.js server will do that on every request; if the cookie is
 * garbage, preflight's GET /api/compare returns 401 and we bail).
 */
function extractUserIdFromCookie(step: string, cookie: string): string {
  const pairs = cookie
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  const byName = new Map<string, string>();
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    byName.set(name, value);
  }

  // Try the legacy split cookie first.
  const accessToken = byName.get('sb-access-token');
  if (accessToken) {
    const sub = decodeJwtSub(accessToken);
    if (sub) return sub;
  }

  // Fall back to the modern single cookie. Its value may be
  // URL-encoded JSON (e.g. `%5B%22eyJ...%22%2C...%5D`) containing an
  // array whose first element is the access token, or it may be raw
  // base64.
  for (const [name, value] of byName.entries()) {
    if (!name.startsWith('sb-') || !name.endsWith('-auth-token')) continue;
    const jwt = parseAuthTokenCookie(value);
    if (!jwt) continue;
    const sub = decodeJwtSub(jwt);
    if (sub) return sub;
  }

  throw new StepError(
    step,
    "Cookie doesn't look like a Supabase session — check DevTools → Application → Cookies for `sb-access-token` or `sb-<ref>-auth-token`",
  );
}

function parseAuthTokenCookie(raw: string): string | null {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* not URL-encoded */
  }
  // Strip the chunked-cookie `base64-` prefix the helpers sometimes use.
  if (decoded.startsWith('base64-')) decoded = decoded.slice('base64-'.length);
  // Tolerant JSON parse.
  try {
    const parsed = JSON.parse(decoded);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
      return parsed[0];
    }
    if (parsed && typeof parsed === 'object' && typeof (parsed as { access_token?: unknown }).access_token === 'string') {
      return (parsed as { access_token: string }).access_token;
    }
  } catch {
    /* not JSON — fall through */
  }
  // Last resort: treat the whole thing as a bare JWT.
  if (decoded.split('.').length === 3) return decoded;
  return null;
}

function decodeJwtSub(jwt: string): string | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadRaw = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadRaw) as { sub?: string };
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

async function preflight(ctx: SmokeContext): Promise<void> {
  const step = 'Preflight';
  assert(
    step,
    COOKIE && COOKIE.includes('sb-'),
    "SESSION_COOKIE missing or doesn't look like a Supabase session. See scripts/README.md for copy instructions.",
  );
  assertServiceRoleEnv(step);

  // Hit a cheap authenticated endpoint. 404 means cookie works (bid id
  // is fake); 401 means cookie is bad/expired; 403 is also acceptable
  // (role gate). Anything else → bail.
  const pingPath = '/api/compare/00000000-0000-0000-0000-000000000000';
  const res = await fetch(`${API_URL}${pingPath}`, {
    headers: { Cookie: COOKIE },
    redirect: 'manual',
  });
  assert(
    step,
    res.status !== 401,
    'Preflight got 401 — SESSION_COOKIE is expired or wrong domain. Re-copy from a logged-in browser.',
    res.status,
  );
  assert(
    step,
    [403, 404, 400].includes(res.status),
    `Preflight unexpected status from ${pingPath}: ${res.status}`,
  );

  // Resolve user + company via service role.
  ctx.admin = getAdmin();
  const userId = extractUserIdFromCookie(step, COOKIE);
  ctx.authUserId = userId;

  const { data: profile, error: profileErr } = await ctx.admin
    .from('users')
    .select('id, company_id')
    .eq('id', userId)
    .maybeSingle();
  assert(step, !profileErr, `users read failed: ${profileErr?.message}`);
  assert(
    step,
    profile?.company_id,
    'Cookie user has no users row or no company_id — finish onboarding as that user before running HTTP smoke test.',
  );
  ctx.userId = profile!.id as string;
  ctx.companyId = profile!.company_id as string;

  // Roles gate — dispatch + compare + margin all require buyer-aligned.
  const { data: rolesRows, error: rolesErr } = await ctx.admin
    .from('roles')
    .select('role_type')
    .eq('user_id', ctx.userId)
    .eq('company_id', ctx.companyId);
  assert(step, !rolesErr, `roles read failed: ${rolesErr?.message}`);
  const roles = (rolesRows ?? []).map((r) => r.role_type as string);
  const allowed = new Set(['buyer', 'trader_buyer', 'manager', 'owner']);
  assert(
    step,
    roles.some((r) => allowed.has(r)),
    `Cookie user roles [${roles.join(',')}] lack buyer / trader_buyer / manager / owner — HTTP smoke test needs one of these.`,
  );
  // Step 9 (release) also requires manager / owner. Warn if absent but
  // don't hard-fail — the test will error out at Step 9 with a useful
  // HTTP 403.
  const canRelease = roles.some((r) => r === 'manager' || r === 'owner');
  if (!canRelease) {
    console.warn(
      `  (note) cookie user has no manager/owner role; Step 9 (release) will fail with 403. Elevate the user to exercise the full 9 steps.`,
    );
  }

  // Company slug + original approval threshold.
  const { data: companyRow, error: companyErr } = await ctx.admin
    .from('companies')
    .select('id, slug, approval_threshold_dollars')
    .eq('id', ctx.companyId)
    .single();
  assert(step, !companyErr, `companies read failed: ${companyErr?.message}`);
  ctx.companySlug = companyRow!.slug as string;
  ctx.originalApprovalThreshold =
    companyRow!.approval_threshold_dollars == null
      ? null
      : Number(companyRow!.approval_threshold_dollars);
}

// -----------------------------------------------------------------------------
// Seed — vendor + approval threshold override
// -----------------------------------------------------------------------------

async function seed(ctx: SmokeContext): Promise<void> {
  const step = 'Seed';
  const admin = ctx.admin!;

  // Vendor — wildcard regions/commodities so dispatch + comparison are
  // trivially satisfied.
  const { data: vendor, error: vendorErr } = await admin
    .from('vendors')
    .insert({
      company_id: ctx.companyId,
      name: `${SMOKE_PREFIX} Mill Alpha ${TIMESTAMP}`,
      contact_name: 'A. HTTP Tester',
      email: `vendor-smoke-http-${TIMESTAMP}@example.com`,
      vendor_type: 'mill',
      commodities: ['Dimensional', 'Panels', 'Cedar'],
      regions: [],
      min_order_mbf: 0.5,
      active: true,
    })
    .select('id')
    .single();
  assert(step, !vendorErr, `vendors insert failed: ${vendorErr?.message}`);
  ctx.vendorId = vendor!.id as string;

  // Force approval threshold for deterministic Step 7 assertion.
  const { error: threshErr } = await admin
    .from('companies')
    .update({ approval_threshold_dollars: APPROVAL_THRESHOLD_FOR_TEST })
    .eq('id', ctx.companyId);
  assert(
    step,
    !threshErr,
    `companies.approval_threshold_dollars update failed: ${threshErr?.message}`,
  );
}

// -----------------------------------------------------------------------------
// STEP 1 — Ingest via POST /api/ingest (multipart)
// -----------------------------------------------------------------------------

interface IngestResponse {
  bid_id: string;
  extraction?: {
    totalLineItems?: number;
    extractionConfidence?: number;
  };
  extraction_report?: {
    method_used?: string;
    total_line_items?: number;
    overall_confidence?: number;
    qa_passed?: boolean;
  };
  status?: string;
}

async function step1_ingest(ctx: SmokeContext): Promise<void> {
  const step = 'Step 1 — Ingest';
  const admin = ctx.admin!;

  const xlsx = await buildFixtureXlsx();
  // Node 20 globals: FormData, File, Blob.
  const form = new FormData();
  // Recent @types/node widened Buffer.buffer to ArrayBufferLike which the
  // DOM BlobPart union refuses. Copy out a plain ArrayBuffer slice — cheap
  // (small fixture), and keeps the TS types honest.
  const xlsxAb = xlsx.buffer.slice(
    xlsx.byteOffset,
    xlsx.byteOffset + xlsx.byteLength,
  ) as ArrayBuffer;
  const file = new File([xlsxAb], 'test-clean-excel.xlsx', {
    type:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  form.append('file', file);
  // /api/ingest accepts these on the multipart body per FormMetaSchema.
  form.append('customerName', `${SMOKE_PREFIX} Acme Builders ${TIMESTAMP}`);
  form.append('customerEmail', 'smoke-acme-http@lmbr.ai');
  form.append('jobName', `${SMOKE_PREFIX} Valley Ridge HTTP`);
  form.append('jobAddress', '123 Valley Way, Valleyview, CA 92039');
  form.append('jobState', 'CA');

  const body = await fetchJson<IngestResponse>(step, '/api/ingest', {
    method: 'POST',
    // Do NOT set Content-Type — let fetch/FormData set the boundary.
    body: form,
  });
  assert(step, body.bid_id, 'ingest response missing bid_id', body);
  ctx.bidId = body.bid_id;

  // If queued, a realistic smoke test would poll — but our dev env runs
  // inline (REDIS_URL unset). Bail with a clear message if not.
  if (body.status === 'extracting') {
    throw new StepError(
      step,
      'ingest returned queued mode (status=extracting) — HTTP smoke needs REDIS_URL unset for inline processing',
    );
  }

  // Re-read line_items via service role — the inline response echoes
  // summary data, not full rows, and it's not worth standing up a
  // dedicated GET just for smoke.
  const { data: lineRows, error: liErr } = await admin
    .from('line_items')
    .select('id, extraction_method, extraction_confidence')
    .eq('bid_id', ctx.bidId)
    .eq('is_consolidated', false);
  assert(step, !liErr, `line_items read failed: ${liErr?.message}`);
  assert(
    step,
    (lineRows ?? []).length === 10,
    'line_items count must be 10',
    lineRows?.length,
  );
  for (const row of lineRows!) {
    assert(
      step,
      row.extraction_method === 'excel_parse',
      `every line must be excel_parse (got ${row.extraction_method})`,
    );
  }

  // No Claude Mode A / Mode B spend on clean Excel.
  const { data: costRows } = await admin
    .from('extraction_costs')
    .select('method, cost_cents')
    .eq('bid_id', ctx.bidId);
  const claudeSpend = (costRows ?? [])
    .filter((r) => r.method === 'claude_mode_a' || r.method === 'claude_mode_b')
    .reduce((s, r) => s + Number(r.cost_cents), 0);
  assert(
    step,
    claudeSpend === 0,
    'no Claude Mode A/B spend on clean Excel fixture',
    { claudeSpend, rows: costRows },
  );
}

// -----------------------------------------------------------------------------
// STEP 2 — Routing via POST /api/route-bid
// -----------------------------------------------------------------------------

interface RouteBidResponse {
  success?: boolean;
  routing_map?: Array<{
    buyer_user_id: string;
    line_count: number;
  }>;
  unrouted?: string[];
  strategy?: string;
}

async function step2_routing(ctx: SmokeContext): Promise<void> {
  const step = 'Step 2 — Routing';
  const admin = ctx.admin!;

  const body = await fetchJson<RouteBidResponse>(step, '/api/route-bid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bidId: ctx.bidId }),
  });
  assert(step, body.success === true, 'route-bid must succeed', body);
  assert(
    step,
    (body.routing_map ?? []).length >= 1,
    'routing_map must have at least one entry',
    body,
  );
  assert(
    step,
    (body.unrouted ?? []).length === 0,
    'unrouted must be empty on the clean fixture',
    body.unrouted,
  );

  // Persistence — bid_routings row exists.
  const { data: routings, error: rErr } = await admin
    .from('bid_routings')
    .select('id, buyer_user_id, line_item_ids')
    .eq('bid_id', ctx.bidId);
  assert(step, !rErr, `bid_routings read failed: ${rErr?.message}`);
  assert(
    step,
    (routings ?? []).length >= 1,
    'bid_routings must be persisted',
    routings,
  );
}

// -----------------------------------------------------------------------------
// STEP 3 — Consolidation (HYBRID) via POST /api/consolidate
// -----------------------------------------------------------------------------

interface ConsolidateResponse {
  success?: boolean;
  mode?: string;
  consolidated_items?: Array<{
    species: string;
    dimension: string;
    quantity: number;
    source_line_item_ids: string[];
  }>;
  original_count?: number;
  consolidated_count?: number;
}

async function step3_consolidation(ctx: SmokeContext): Promise<void> {
  const step = 'Step 3 — Consolidation';
  const admin = ctx.admin!;

  const body = await fetchJson<ConsolidateResponse>(step, '/api/consolidate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bidId: ctx.bidId, mode: 'hybrid' }),
  });
  assert(step, body.success === true, 'consolidate must succeed', body);
  assert(step, body.mode === 'hybrid', 'mode must be hybrid', body);
  assert(
    step,
    (body.consolidated_items ?? []).length > 0,
    'hybrid must yield consolidated items',
    body,
  );
  assert(
    step,
    (body.consolidated_items ?? []).length < 10,
    'hybrid must reduce below 10 lines',
    body.consolidated_items?.length,
  );

  // SPF 2x4 #2 8' merged across 3 buildings → qty 1100.
  const spf2x4 = (body.consolidated_items ?? []).find(
    (c) => c.species === 'SPF' && c.dimension === '2x4',
  );
  assert(step, !!spf2x4, 'expected a consolidated SPF 2x4 row', body);
  assert(
    step,
    spf2x4!.quantity === 1100,
    'SPF 2x4 must aggregate to qty=1100',
    spf2x4,
  );

  // Service-role sanity — consolidated rows persisted with source mapping.
  const { data: consolidatedRows } = await admin
    .from('line_items')
    .select('id, source_line_item_ids, is_consolidated')
    .eq('bid_id', ctx.bidId)
    .eq('is_consolidated', true);
  assert(
    step,
    (consolidatedRows ?? []).length > 0,
    'consolidated line_items rows must exist',
  );
  for (const row of consolidatedRows ?? []) {
    assert(
      step,
      Array.isArray(row.source_line_item_ids) &&
        (row.source_line_item_ids as unknown[]).length > 0,
      'source_line_item_ids must be populated',
      row,
    );
  }
}

// -----------------------------------------------------------------------------
// STEP 4 — Vendor dispatch via POST /api/vendors/dispatch
// -----------------------------------------------------------------------------

interface DispatchResponse {
  success?: boolean;
  dispatched?: Array<{
    vendorBidId: string;
    vendorId: string;
    token: string;
    submitUrl: string;
    printUrl: string;
  }>;
  skipped?: Array<{ vendorId: string; reason: string }>;
}

async function step4_dispatch(ctx: SmokeContext): Promise<void> {
  const step = 'Step 4 — Vendor dispatch';

  const dueBy = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const body = await fetchJson<DispatchResponse>(
    step,
    '/api/vendors/dispatch',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bidId: ctx.bidId,
        vendorIds: [ctx.vendorId],
        dueBy,
        submissionMethod: 'form',
      }),
    },
  );
  assert(step, body.success === true, 'dispatch must succeed', body);
  assert(
    step,
    (body.dispatched ?? []).length === 1,
    'exactly one dispatched vendor expected',
    body,
  );
  assert(
    step,
    (body.skipped ?? []).length === 0,
    'no skipped vendors expected',
    body.skipped,
  );

  const entry = body.dispatched![0]!;
  assert(step, entry.vendorId === ctx.vendorId, 'vendor mismatch', entry);
  assert(step, entry.token && entry.token.length > 0, 'token must be set');
  assert(step, entry.submitUrl.includes('/vendor-submit/'), 'submitUrl shape');
  assert(step, entry.printUrl.includes('/print'), 'printUrl shape');

  ctx.vendorBidId = entry.vendorBidId;
  ctx.token = entry.token;
  ctx.submitUrl = entry.submitUrl;
  ctx.printUrl = entry.printUrl;
}

// -----------------------------------------------------------------------------
// STEP 5 — Vendor pricing via GET /vendor-submit/[token] + POST /api/vendor-submit
// -----------------------------------------------------------------------------

interface VendorSubmitResponse {
  success?: boolean;
  status?: 'submitted' | 'partial' | 'declined';
  pricedCount?: number;
  expectedCount?: number;
}

async function step5_vendor_submit(ctx: SmokeContext): Promise<void> {
  const step = 'Step 5 — Vendor submit';
  const admin = ctx.admin!;

  // 1. GET the public form — proves the page renders without the session
  //    cookie. The token alone authenticates.
  const pageRes = await fetchRaw(step, ctx.submitUrl!, {
    withCookie: false,
  });
  assert(
    step,
    pageRes.status === 200,
    `GET ${ctx.submitUrl} expected 200, got ${pageRes.status}`,
  );

  // 2. Read the consolidated (vendor-visible) line_items set so we can
  //    build a price per line. HYBRID → vendor sees consolidated.
  const { data: vendorLines, error: vlErr } = await admin
    .from('line_items')
    .select('id, species, dimension, quantity')
    .eq('bid_id', ctx.bidId)
    .eq('is_consolidated', true);
  assert(step, !vlErr, `vendor line_items read failed: ${vlErr?.message}`);
  assert(
    step,
    (vendorLines ?? []).length > 0,
    'no vendor-visible line_items found',
  );

  const prices = (vendorLines ?? []).map((row) => ({
    lineItemId: row.id as string,
    unitPrice: costUnitPriceFor(
      row.species as string,
      row.dimension as string,
    ),
  }));

  // 3. POST /api/vendor-submit — NO cookie (token is the auth).
  const body = await fetchJson<VendorSubmitResponse>(
    step,
    '/api/vendor-submit',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: ctx.token,
        action: 'submit',
        prices,
      }),
      withCookie: false,
    },
  );
  assert(step, body.success === true, 'vendor-submit must succeed', body);
  assert(step, body.status === 'submitted', 'status must be "submitted"', body);
  assert(
    step,
    body.pricedCount === prices.length,
    'pricedCount mismatch',
    body,
  );

  // 4. DB sanity.
  const { data: vbli, error: vbliErr } = await admin
    .from('vendor_bid_line_items')
    .select('id, is_best_price, unit_price, line_item_id')
    .eq('vendor_bid_id', ctx.vendorBidId);
  assert(step, !vbliErr, `vendor_bid_line_items read failed: ${vbliErr?.message}`);
  assert(
    step,
    (vbli ?? []).length === prices.length,
    'vendor_bid_line_items count mismatch',
    { expected: prices.length, actual: vbli?.length },
  );
  for (const row of vbli ?? []) {
    assert(
      step,
      row.is_best_price === true,
      'single-vendor line must be best_price',
      row,
    );
  }
  ctx.vendorBidLineItemIds = (vbli ?? []).map((r) => r.id as string);

  // vendor_bids.status
  const { data: vb } = await admin
    .from('vendor_bids')
    .select('status')
    .eq('id', ctx.vendorBidId)
    .single();
  assert(step, vb!.status === 'submitted', 'vendor_bids.status must be submitted', vb);
}

// -----------------------------------------------------------------------------
// STEP 6 — Comparison via GET /api/compare/[bidId]
// -----------------------------------------------------------------------------

interface CompareResponse {
  success?: boolean;
  result?: {
    rows: Array<{
      lineItemId: string;
      bestVendorId: string | null;
      bestUnitPrice: number | null;
    }>;
    vendors: Array<{ vendorId: string; vendorName: string }>;
  };
}

async function step6_comparison(ctx: SmokeContext): Promise<void> {
  const step = 'Step 6 — Comparison';

  const body = await fetchJson<CompareResponse>(
    step,
    `/api/compare/${ctx.bidId}`,
  );
  assert(step, body.success === true, 'compare must succeed', body);
  assert(
    step,
    (body.result?.rows ?? []).length > 0,
    'comparison rows must be non-empty',
    body,
  );
  for (const row of body.result!.rows) {
    assert(
      step,
      row.bestVendorId === ctx.vendorId,
      `row bestVendorId mismatch — got ${row.bestVendorId}`,
    );
    assert(step, row.bestUnitPrice !== null, 'bestUnitPrice must be set', row);
  }
  const vendorName = body.result!.vendors[0]?.vendorName ?? '';
  assert(
    step,
    vendorName.includes(SMOKE_PREFIX),
    `vendor name should include ${SMOKE_PREFIX} in comparison output`,
    vendorName,
  );
}

// -----------------------------------------------------------------------------
// STEP 7 — Margin stack via POST /api/margin
// -----------------------------------------------------------------------------

interface MarginResponse {
  success?: boolean;
  quote?: {
    id: string;
    status: string;
    total: number;
  };
  pricing?: {
    totals: {
      grandTotal: number;
      lumberTax: number;
      salesTax: number;
    };
  };
  needsApproval?: boolean;
  belowMinimumMargin?: boolean;
}

async function step7_margin(ctx: SmokeContext): Promise<void> {
  const step = 'Step 7 — Margin stack';
  const admin = ctx.admin!;

  const { data: vendorLines } = await admin
    .from('line_items')
    .select('id')
    .eq('bid_id', ctx.bidId)
    .eq('is_consolidated', true);
  const { data: vbliRows } = await admin
    .from('vendor_bid_line_items')
    .select('id, line_item_id, unit_price, total_price')
    .eq('vendor_bid_id', ctx.vendorBidId);
  const byLine = new Map(
    (vbliRows ?? []).map((r) => [r.line_item_id as string, r]),
  );

  const selections = (vendorLines ?? []).map((row) => {
    const vbli = byLine.get(row.id as string);
    assert(step, vbli, `missing vbli for line ${row.id}`);
    return {
      lineItemId: row.id as string,
      vendorBidLineItemId: vbli!.id as string,
      vendorId: ctx.vendorId!,
      costUnitPrice: Number(vbli!.unit_price),
      costTotalPrice: Number(vbli!.total_price),
    };
  });

  const body = await fetchJson<MarginResponse>(step, '/api/margin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bidId: ctx.bidId,
      selections,
      marginInstructions: [
        {
          scope: 'commodity',
          targetId: 'Dimensional',
          marginType: 'percent',
          marginValue: 0.12,
        },
        {
          scope: 'commodity',
          targetId: 'Panels',
          marginType: 'percent',
          marginValue: 0.12,
        },
      ],
      action: 'submit_for_approval',
    }),
  });
  assert(step, body.success === true, 'margin must succeed', body);
  assert(step, body.quote?.id, 'quote.id must be set', body);
  ctx.quoteId = body.quote!.id;

  // Approval gate: CA job, consolidated qty large enough that grand total
  // with 12% markup clears $10k. If the company threshold override in
  // seed() didn't stick, surface that.
  assert(
    step,
    body.needsApproval === true,
    'needsApproval must be true — approval threshold override may not have applied',
    { total: body.pricing?.totals.grandTotal, threshold: APPROVAL_THRESHOLD_FOR_TEST },
  );
  assert(
    step,
    body.quote?.status === 'pending_approval',
    'quote status must be pending_approval',
    body.quote,
  );
  assert(
    step,
    (body.pricing?.totals.lumberTax ?? 0) > 0,
    'CA lumber tax must be > 0',
  );
  assert(
    step,
    (body.pricing?.totals.salesTax ?? 0) > 0,
    'CA sales tax must be > 0',
  );

  // Persistence sanity.
  const { data: quoteRow } = await admin
    .from('quotes')
    .select('id, status')
    .eq('id', ctx.quoteId)
    .single();
  assert(
    step,
    quoteRow!.status === 'pending_approval',
    'quotes.status must be pending_approval',
    quoteRow,
  );
}

// -----------------------------------------------------------------------------
// STEP 8 — PDF preview via POST /api/quote action=preview
// -----------------------------------------------------------------------------

async function step8_pdf_preview(ctx: SmokeContext): Promise<void> {
  const step = 'Step 8 — PDF preview';

  const res = await fetchRaw(step, '/api/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bidId: ctx.bidId, action: 'preview' }),
  });
  assert(
    step,
    res.status === 200,
    `preview expected 200, got ${res.status}`,
  );
  const contentType = res.headers.get('content-type') ?? '';
  assert(
    step,
    contentType.includes('application/pdf'),
    `preview content-type must be application/pdf (got ${contentType})`,
  );

  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  assert(
    step,
    buffer.length > 1024,
    `PDF buffer too small (${buffer.length} bytes)`,
  );

  // Same text-layer invariants as Option A.
  const { default: pdfParse } = (await import('pdf-parse')) as {
    default: (b: Buffer) => Promise<{ text: string }>;
  };
  const parsed = await pdfParse(buffer);
  const text = parsed.text;

  assert(
    step,
    !text.includes('Mill Alpha'),
    'PDF must not contain vendor name "Mill Alpha"',
  );
  assert(
    step,
    !text.includes(SMOKE_PREFIX),
    'PDF must not contain smoke prefix (no internal markers leaked)',
  );
  assert(
    step,
    !text.includes('cost_price'),
    'PDF must not contain "cost_price" field name',
  );
  assert(
    step,
    !text.includes('margin_percent'),
    'PDF must not contain "margin_percent" field name',
  );
  assert(
    step,
    !/\$420\b/.test(text),
    'PDF must not leak raw cost "$420"',
  );

  // Positive: job name + per-building breakdown.
  assert(step, text.includes('Valley Ridge HTTP'), 'job name must be on PDF', text.slice(0, 200));
  for (const building of ['House 1', 'House 2', 'House 3']) {
    assert(
      step,
      text.includes(building),
      `building "${building}" must be on PDF (hybrid → structured)`,
    );
  }
  const dollarMatches = text.match(/\$[\d,]+\.\d{2}/g) ?? [];
  const parsedDollars = dollarMatches.map((s) =>
    Number(s.replace(/[$,]/g, '')),
  );
  const maxDollar =
    parsedDollars.length > 0 ? Math.max(...parsedDollars) : 0;
  assert(
    step,
    maxDollar > 420,
    `expected at least one rendered $ value > $420, got max ${maxDollar}`,
  );
}

// -----------------------------------------------------------------------------
// STEP 9 — Release via POST /api/quote action=release
// -----------------------------------------------------------------------------

interface ReleaseResponse {
  success?: boolean;
  pdfUrl?: string;
  quoteNumber?: string;
  sequence?: number;
}

async function step9_release(ctx: SmokeContext): Promise<void> {
  const step = 'Step 9 — Quote release';
  const admin = ctx.admin!;

  const body = await fetchJson<ReleaseResponse>(step, '/api/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bidId: ctx.bidId, action: 'release' }),
  });
  assert(step, body.success === true, 'release must succeed', body);
  assert(step, typeof body.pdfUrl === 'string' && body.pdfUrl.length > 0, 'pdfUrl must be set', body);
  assert(
    step,
    typeof body.quoteNumber === 'string' && body.quoteNumber.length > 0,
    'quoteNumber must be set',
    body,
  );
  // Validate quoteNumber is URL-safe (passes new URL on pdfUrl too).
  new URL(body.pdfUrl!); // throws if malformed
  ctx.quoteNumber = body.quoteNumber!;

  // Expected shape: ${companySlug-upper-12}-${5-digit-zero-pad}
  const expectedPrefix =
    (ctx.companySlug ?? '').toUpperCase().slice(0, 12) || 'LMBR';
  assert(
    step,
    body.quoteNumber!.startsWith(expectedPrefix + '-'),
    `quoteNumber must start with "${expectedPrefix}-"`,
    body.quoteNumber,
  );

  // Persistence.
  const { data: quoteRow } = await admin
    .from('quotes')
    .select('status, pdf_url')
    .eq('id', ctx.quoteId)
    .single();
  assert(
    step,
    quoteRow!.status === 'approved',
    'quotes.status must be approved after release',
    quoteRow,
  );
  assert(
    step,
    typeof quoteRow!.pdf_url === 'string' &&
      (quoteRow!.pdf_url as string).length > 0,
    'quotes.pdf_url must be non-null after release',
    quoteRow,
  );

  // Remember the storage path so cleanup can drain it.
  ctx.quoteStoragePath = `${ctx.companyId}/${ctx.bidId}/${body.quoteNumber}.pdf`;
}

// -----------------------------------------------------------------------------
// Cleanup — scoped to the cookie user's company + SMOKE-TEST-HTTP prefix
// -----------------------------------------------------------------------------

async function cleanup(ctx: SmokeContext): Promise<void> {
  const admin = ctx.admin ?? (() => {
    try { return getAdmin(); } catch { return null; }
  })();
  if (!admin) {
    console.error('  Cleanup: no admin client available, skipping.');
    return;
  }
  if (!ctx.companyId) {
    console.log('  Cleanup: no companyId resolved, skipping.');
    return;
  }

  const counts: Record<string, number> = {};
  type DeleteRes = { data: unknown[] | null; error: { message: string } | null };

  // Drop per-bid rows for this SMOKE prefix. Most FK chains cascade from
  // bids, but we delete in safe order so a partial seed still cleans up.
  let bidIds: string[] = [];
  if (ctx.bidId) {
    bidIds = [ctx.bidId];
  } else {
    try {
      const res = (await admin
        .from('bids')
        .select('id')
        .eq('company_id', ctx.companyId)
        .like('customer_name', `${SMOKE_PREFIX}%`)) as unknown as {
        data: Array<{ id: string }> | null;
      };
      bidIds = (res.data ?? []).map((r) => r.id);
    } catch (e) {
      console.error(
        `  Cleanup: bids lookup — ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  async function delIn(
    table: string,
    column: string,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    try {
      const res = (await admin
        .from(table)
        .delete()
        .in(column, ids)
        .select('id')) as unknown as DeleteRes;
      if (res.error) {
        console.error(`  Cleanup: ${table} — ${res.error.message}`);
        return;
      }
      counts[table] = (counts[table] ?? 0) + (res.data ?? []).length;
    } catch (e) {
      console.error(
        `  Cleanup: ${table} — ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  if (bidIds.length > 0) {
    // quotes have FK to bids; grab their ids first for quote_line_items.
    try {
      const res = (await admin
        .from('quotes')
        .select('id')
        .in('bid_id', bidIds)) as unknown as {
        data: Array<{ id: string }> | null;
      };
      const quoteIds = (res.data ?? []).map((r) => r.id);
      await delIn('quote_line_items', 'quote_id', quoteIds);
      await delIn('quotes', 'id', quoteIds);
    } catch (e) {
      console.error(
        `  Cleanup: quotes — ${e instanceof Error ? e.message : e}`,
      );
    }

    // vendor_bids → their line items first.
    try {
      const res = (await admin
        .from('vendor_bids')
        .select('id')
        .in('bid_id', bidIds)) as unknown as {
        data: Array<{ id: string }> | null;
      };
      const vbIds = (res.data ?? []).map((r) => r.id);
      await delIn('vendor_bid_line_items', 'vendor_bid_id', vbIds);
      await delIn('vendor_bids', 'id', vbIds);
    } catch (e) {
      console.error(
        `  Cleanup: vendor_bids — ${e instanceof Error ? e.message : e}`,
      );
    }

    await delIn('bid_routings', 'bid_id', bidIds);
    await delIn('line_items', 'bid_id', bidIds);
    await delIn('extraction_costs', 'bid_id', bidIds);
    await delIn('bids', 'id', bidIds);
  }

  // Vendors — only ones this test created.
  try {
    const res = (await admin
      .from('vendors')
      .delete()
      .eq('company_id', ctx.companyId)
      .like('name', `${SMOKE_PREFIX}%`)
      .select('id')) as unknown as DeleteRes;
    if (res.error) {
      console.error(`  Cleanup: vendors — ${res.error.message}`);
    } else {
      counts['vendors'] = (res.data ?? []).length;
    }
  } catch (e) {
    console.error(
      `  Cleanup: vendors — ${e instanceof Error ? e.message : e}`,
    );
  }

  // Restore approval_threshold_dollars.
  if (ctx.originalApprovalThreshold !== undefined) {
    try {
      const { error } = await admin
        .from('companies')
        .update({
          approval_threshold_dollars: ctx.originalApprovalThreshold,
        })
        .eq('id', ctx.companyId);
      if (error) {
        console.error(
          `  Cleanup: companies.approval_threshold_dollars restore — ${error.message}`,
        );
      } else {
        counts['companies.approval_threshold'] = 1;
      }
    } catch (e) {
      console.error(
        `  Cleanup: companies.approval_threshold_dollars restore — ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // Storage: quote PDF from Step 9. The ingested xlsx is
  // application-scoped under bids-raw/${companyId}/${uuid}.xlsx — we don't
  // track its path here (the route handler doesn't echo it). Cascading
  // those files is Prompt 12 storage-GC territory; not worth a recursive
  // list for a smoke run.
  if (ctx.quoteStoragePath) {
    try {
      await admin.storage.from('quotes').remove([ctx.quoteStoragePath]);
    } catch {
      /* non-fatal */
    }
  }

  const touched = Object.keys(counts).filter((k) => (counts[k] ?? 0) > 0);
  if (touched.length > 0) {
    console.log(
      '  Cleanup summary: ' +
        touched.map((k) => `${k}=${counts[k]}`).join(', '),
    );
  } else {
    console.log('  Cleanup: nothing to remove (or already gone).');
  }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const started = Date.now();
  const ctx = createContext();
  let failed = false;

  if (!COOKIE) {
    console.error(
      '✗ SESSION_COOKIE is required.\n' +
        '  1. Start dev server (pnpm dev) and log in as a buyer/trader_buyer/manager/owner.\n' +
        '  2. DevTools → Application → Cookies → http://localhost:3000.\n' +
        '  3. Copy the whole Cookie: header value (sb-...-auth-token=...).\n' +
        '  4. export SESSION_COOKIE=\'<the whole string>\'\n' +
        '  See scripts/README.md for details.',
    );
    process.exitCode = 1;
    return;
  }

  try {
    console.log('LMBR.ai smoke-e2e-http starting at ' + new Date().toISOString());
    console.log(
      `  prefix=${SMOKE_PREFIX}  timestamp=${TIMESTAMP}  api=${API_URL}\n`,
    );

    await runStep('Preflight', () => preflight(ctx));
    await runStep('Seed', () => seed(ctx));
    await runStep('Step 1 — Ingest', () => step1_ingest(ctx));
    await runStep('Step 2 — Routing', () => step2_routing(ctx));
    await runStep('Step 3 — Consolidation', () => step3_consolidation(ctx));
    await runStep('Step 4 — Vendor dispatch', () => step4_dispatch(ctx));
    await runStep('Step 5 — Vendor submit', () => step5_vendor_submit(ctx));
    await runStep('Step 6 — Comparison', () => step6_comparison(ctx));
    await runStep('Step 7 — Margin stack', () => step7_margin(ctx));
    await runStep('Step 8 — PDF preview', () => step8_pdf_preview(ctx));
    await runStep('Step 9 — Quote release', () => step9_release(ctx));

    console.log(
      `\n✓ HTTP smoke test passed — ready for Prompt 08 (${Date.now() - started}ms total)`,
    );
  } catch (err) {
    failed = true;
    const stepName = err instanceof StepError ? err.step : '?';
    console.error(
      `\n✗ HTTP smoke test FAILED at ${stepName} — fix before proceeding`,
    );
    if (err instanceof Error) {
      console.error(err.message);
      if (err.stack) console.error(err.stack);
    }
    process.exitCode = 1;
  } finally {
    try {
      console.log('\nRunning cleanup...');
      await cleanup(ctx);
    } catch (e) {
      console.error('Cleanup error:', e);
    }
  }

  if (failed && process.exitCode === 0) process.exitCode = 1;
}

const invokedDirectly = (() => {
  try {
    if (typeof require !== 'undefined' && typeof module !== 'undefined') {
      return require.main === module;
    }
  } catch {
    /* fall through */
  }
  return true;
})();

if (invokedDirectly) {
  void main();
}

export { main, buildFixtureXlsx, FIXTURE_ROWS };
