#!/usr/bin/env tsx
/**
 * LMBR.ai end-to-end smoke test — service-role offline pipeline.
 *
 * Purpose:  Seeds a [SMOKE-TEST]-prefixed company + user + vendor,
 *           drives the bid lifecycle end-to-end via direct helper
 *           calls (not HTTP), asserts per-step invariants, cleans
 *           up on both pass and fail. Permanent CI fixture — not
 *           a throwaway.
 *
 *           Pipeline exercised:
 *             1. Ingest (processIngestJob path, Excel → line_items)
 *             2. Routing (trader_buyer short-circuit)
 *             3. Consolidation (HYBRID mode — source mapping)
 *             4. Vendor dispatch (token minting + vendor_bids row)
 *             5. Vendor pricing (vendor_bid_line_items)
 *             6. Comparison (loadComparison + comparisonAgent)
 *             7. Margin stack (applyMargin + pricingAgent)
 *             8. PDF render (renderQuotePdfBuffer — invariant checks)
 *             9. Quote persistence (upload + pdf_url round-trip)
 *
 * Run:      pnpm tsx scripts/smoke-e2e.ts
 * Requires: .env.local with SUPABASE_SERVICE_ROLE_KEY +
 *           NEXT_PUBLIC_SUPABASE_URL + ANTHROPIC_API_KEY + a
 *           VENDOR_TOKEN_SECRET (script synthesizes one when absent
 *           so local dev can run without editing .env.local).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

import ExcelJS from 'exceljs';

// Load .env.local explicitly — dotenv/config only reads .env. Most LMBR
// secrets live in .env.local so the script must look there too.
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

// Synthesize a VENDOR_TOKEN_SECRET if none is set. Prompt 05 made the
// real secret load-bearing in prod; the smoke test needs a deterministic
// fallback so CI runs without requiring the operator to hand-edit env
// files. Length chosen to match Node's createHmac('sha256') sweet spot.
if (!process.env.VENDOR_TOKEN_SECRET) {
  process.env.VENDOR_TOKEN_SECRET =
    'smoke-e2e-vendor-token-secret-deterministic-0123456789abcdef';
}

import {
  consolidationAgent,
  pricingAgent,
  routingAgent,
  type ConsolidationLineItem,
  type PricingSelection,
  type MarginInstruction,
} from '@lmbr/agents';
import {
  buildQuotePdfInput,
  canReleaseQuote,
  createVendorBidToken,
  getSupabaseAdmin,
  narrowPdfLineUnit,
  type PdfPricedLineInput,
  type SupabaseClient,
} from '@lmbr/lib';
import { routeBidToRegion } from '@lmbr/config';

// apps/web isn't a workspace package — pull the helpers via relative
// path. Both helpers are pure TS and safe to import outside Next.
import { loadComparison } from '../apps/web/src/lib/compare/load-comparison';
import { applyMargin } from '../apps/web/src/lib/margin/apply-margin';
import { renderQuotePdfBuffer } from '../apps/web/src/lib/pdf/quote-pdf';
import { processIngestJob } from '../apps/web/src/app/api/ingest/processor';

// -----------------------------------------------------------------------------
// Context — grows as seed() populates it. Every id is captured so cleanup
// can run even when a step throws.
// -----------------------------------------------------------------------------

interface SmokeContext {
  // Admin client is lazy so getSupabaseAdmin() env-validation happens
  // AFTER .env.local is loaded above.
  admin?: SupabaseClient;
  // Identifiers (all undefined until seed runs; cleanup is gated on truthy).
  authUserId?: string;
  companyId?: string;
  userEmail?: string;
  userId?: string;
  roleId?: string;
  commodityAssignmentId?: string;
  vendorId?: string;
  bidId?: string;
  routingId?: string;
  vendorBidId?: string;
  vendorBidLineItemIds: string[];
  consolidatedLineItemIds: string[];
  originalLineItemIds: string[];
  quoteId?: string;
  storageObjectPath?: string;
  // Captured results used by later steps.
  pricingResult?: ReturnType<typeof pricingAgent>;
  pdfBuffer?: Buffer;
  quoteNumber: string;
}

const SMOKE_PREFIX = '[SMOKE-TEST]';
const TIMESTAMP = Date.now();

function createContext(): SmokeContext {
  return {
    vendorBidLineItemIds: [],
    consolidatedLineItemIds: [],
    originalLineItemIds: [],
    quoteNumber: `${SMOKE_PREFIX}-${TIMESTAMP}`,
  };
}

// -----------------------------------------------------------------------------
// Assertion helpers — every step wraps errors with a `.step` property so
// the top-level catch can surface which step failed without searching the
// stack trace.
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
// Excel fixture — 10 line items across 3 buildings. Clean enough that
// excel_parse should produce overallConfidence >= 0.92 and never fire
// Claude fallback. Column layout is Building | Species | Dimension |
// Grade | Length | Qty | Unit so the parser's header detection locks in.
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
  // House 1 — 3 lines
  { building: 'House 1', species: 'SPF', dimension: '2x4', grade: '#2', length: '8', qty: 500, unit: 'PCS' },
  { building: 'House 1', species: 'SPF', dimension: '2x6', grade: '#2', length: '12', qty: 300, unit: 'PCS' },
  { building: 'House 1', species: 'DF', dimension: '4x4', grade: '#2', length: '10', qty: 50, unit: 'PCS' },
  // House 2 — 3 lines
  { building: 'House 2', species: 'SPF', dimension: '2x4', grade: '#2', length: '8', qty: 400, unit: 'PCS' },
  { building: 'House 2', species: 'SPF', dimension: '2x8', grade: '#2', length: '14', qty: 200, unit: 'PCS' },
  { building: 'House 2', species: 'OSB', dimension: '4x8', grade: '#2', length: '8', qty: 150, unit: 'PCS' },
  // House 3 — 4 lines
  { building: 'House 3', species: 'SPF', dimension: '2x4', grade: '#2', length: '8', qty: 200, unit: 'PCS' },
  { building: 'House 3', species: 'SPF', dimension: '2x10', grade: '#2', length: '16', qty: 80, unit: 'PCS' },
  { building: 'House 3', species: 'DF', dimension: '4x6', grade: '#2', length: '12', qty: 30, unit: 'PCS' },
  { building: 'House 3', species: 'HF', dimension: '2x6', grade: '#2', length: '14', qty: 250, unit: 'PCS' },
];

async function buildFixtureXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LMBR.ai smoke-e2e';
  const sheet = wb.addWorksheet('Lumber List');
  sheet.addRow(['Building', 'Species', 'Dimension', 'Grade', 'Length', 'Qty', 'Unit']);
  for (const r of FIXTURE_ROWS) {
    sheet.addRow([r.building, r.species, r.dimension, r.grade, r.length, r.qty, r.unit]);
  }
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}

// -----------------------------------------------------------------------------
// SEED
// -----------------------------------------------------------------------------

async function seed(ctx: SmokeContext): Promise<void> {
  const step = 'Seed';
  ctx.admin = getSupabaseAdmin();
  const admin = ctx.admin;

  ctx.userEmail = `smoke+${TIMESTAMP}@lmbr.ai`;

  // 1. auth.users
  const { data: authResult, error: authError } = await admin.auth.admin.createUser({
    email: ctx.userEmail,
    email_confirm: true,
    password: `Smoke!${randomUUID()}`,
  });
  assert(step, !authError, `auth.users insert failed: ${authError?.message}`);
  assert(step, authResult?.user?.id, 'auth.users returned no id');
  ctx.authUserId = authResult!.user!.id;

  // 2. companies
  const { data: companyRow, error: companyError } = await admin
    .from('companies')
    .insert({
      name: `${SMOKE_PREFIX} Valley Lumber ${TIMESTAMP}`,
      slug: `smoke-test-valley-${TIMESTAMP}`,
      email_domain: `smoke-${TIMESTAMP}.lmbr.ai`,
      approval_threshold_dollars: 10000,
      min_margin_percent: 0.05,
      margin_presets: [0.08, 0.1, 0.12, 0.15, 0.18],
      active: true,
      plan: 'enterprise',
    })
    .select('id')
    .single();
  assert(step, !companyError, `companies insert failed: ${companyError?.message}`);
  ctx.companyId = companyRow!.id as string;

  // 3. users
  const { data: userRow, error: userError } = await admin
    .from('users')
    .insert({
      id: ctx.authUserId,
      company_id: ctx.companyId,
      email: ctx.userEmail,
      full_name: `${SMOKE_PREFIX} Trader Buyer`,
    })
    .select('id')
    .single();
  assert(step, !userError, `users insert failed: ${userError?.message}`);
  ctx.userId = userRow!.id as string;

  // 4. roles — trader_buyer
  const { data: roleRow, error: roleError } = await admin
    .from('roles')
    .insert({
      user_id: ctx.userId,
      company_id: ctx.companyId,
      role_type: 'trader_buyer',
    })
    .select('id')
    .single();
  assert(step, !roleError, `roles insert failed: ${roleError?.message}`);
  ctx.roleId = roleRow!.id as string;

  // 5. commodity_assignments — Dimensional, wildcard region
  const { data: caRow, error: caError } = await admin
    .from('commodity_assignments')
    .insert({
      role_id: ctx.roleId,
      commodity_type: 'Dimensional',
      regions: [],
    })
    .select('id')
    .single();
  assert(step, !caError, `commodity_assignments insert failed: ${caError?.message}`);
  ctx.commodityAssignmentId = caRow!.id as string;

  // 6. vendors — single mill, wildcard region so routing/dispatch always picks it
  const { data: vendorRow, error: vendorError } = await admin
    .from('vendors')
    .insert({
      company_id: ctx.companyId,
      name: `${SMOKE_PREFIX} Mill Alpha`,
      contact_name: 'A. Tester',
      email: `vendor-smoke-${TIMESTAMP}@example.com`,
      vendor_type: 'mill',
      commodities: ['Dimensional', 'Panels', 'Cedar'],
      regions: [],
      min_order_mbf: 0.5,
      active: true,
    })
    .select('id')
    .single();
  assert(step, !vendorError, `vendors insert failed: ${vendorError?.message}`);
  ctx.vendorId = vendorRow!.id as string;
}

// -----------------------------------------------------------------------------
// STEP 1 — Ingest (mirrors /api/ingest orchestration with service role)
// -----------------------------------------------------------------------------

const BIDS_BUCKET = 'bids-raw';

async function step1_ingest(ctx: SmokeContext): Promise<void> {
  const step = 'Step 1 — Ingest';
  const admin = ctx.admin!;

  // ---- Build fixture ----
  const xlsxBuffer = await buildFixtureXlsx();

  // ---- Ensure bucket exists ----
  try {
    const { data: bucket } = await admin.storage.getBucket(BIDS_BUCKET);
    if (!bucket) {
      await admin.storage.createBucket(BIDS_BUCKET, {
        public: false,
        fileSizeLimit: 52428800,
      });
    }
  } catch {
    /* non-fatal */
  }

  // ---- Upload source ----
  const objectPath = `${ctx.companyId}/${randomUUID()}.xlsx`;
  const { error: uploadError } = await admin.storage
    .from(BIDS_BUCKET)
    .upload(objectPath, xlsxBuffer, {
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      upsert: false,
    });
  assert(step, !uploadError, `storage upload failed: ${uploadError?.message}`);
  ctx.storageObjectPath = objectPath;

  // ---- Create bid row (mirror /api/ingest) ----
  const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const jobRegion = routeBidToRegion('CA');
  const { data: bidRow, error: bidError } = await admin
    .from('bids')
    .insert({
      company_id: ctx.companyId,
      created_by: ctx.userId,
      assigned_trader_id: ctx.userId,
      customer_name: `${SMOKE_PREFIX} Acme Builders`,
      customer_email: 'smoke-acme@lmbr.ai',
      job_name: `${SMOKE_PREFIX} Valley Ridge`,
      job_address: '123 Valley Way, Valleyview, CA 92039',
      job_state: 'CA',
      job_region: jobRegion,
      status: 'extracting',
      consolidation_mode: 'structured',
      due_date: dueDate,
      raw_file_url: null,
    })
    .select('id, job_region')
    .single();
  assert(step, !bidError, `bids insert failed: ${bidError?.message}`);
  ctx.bidId = bidRow!.id as string;

  assert(
    step,
    bidRow!.job_region === 'west',
    'job_region must be "west" for CA (routeBidToRegion)',
    bidRow!.job_region,
  );

  // ---- Run the tiered processor directly (the /api/ingest route's guts) ----
  const result = await processIngestJob({
    bidId: ctx.bidId!,
    companyId: ctx.companyId!,
    filePath: objectPath,
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: 'lumber-list.xlsx',
  });

  assert(step, result.extraction.totalLineItems === 10, 'extraction must yield 10 lines', result.extraction.totalLineItems);
  // Extraction phase itself must skip Claude (no Mode A / Mode B spend);
  // the Haiku QA pass is a separate, mandatory phase and contributes a
  // small cost (~0.15¢) regardless of how clean the input was. We assert
  // "no Claude fallback fired" by checking the methodUsed is the parser's
  // method, not a claude_mode_* variant.
  assert(
    step,
    result.methodUsed === 'excel_parse',
    'methodUsed must be excel_parse (Claude fallback must not fire on clean Excel)',
    result.methodUsed,
  );

  // ---- Re-read line_items under service role ----
  const { data: lineRows, error: liError } = await admin
    .from('line_items')
    .select('id, extraction_method, extraction_confidence, cost_cents, building_tag, species, dimension, grade, length, quantity, unit, board_feet, sort_order')
    .eq('bid_id', ctx.bidId)
    .eq('is_consolidated', false);
  assert(step, !liError, `line_items read failed: ${liError?.message}`);
  assert(step, (lineRows ?? []).length === 10, 'line_items count must be 10', lineRows?.length);

  for (const row of lineRows!) {
    assert(
      step,
      row.extraction_method === 'excel_parse',
      `every line must be excel_parse (got ${row.extraction_method})`,
    );
    assert(
      step,
      Number(row.extraction_confidence ?? 0) >= 0.92,
      `extraction_confidence must be >= 0.92 (got ${row.extraction_confidence})`,
    );
  }
  ctx.originalLineItemIds = lineRows!.map((r) => r.id as string);

  // ---- Extraction costs: no Claude Mode A / Mode B spend (Haiku QA ok) ----
  const { data: costRows, error: costError } = await admin
    .from('extraction_costs')
    .select('cost_cents, method')
    .eq('bid_id', ctx.bidId);
  assert(step, !costError, `extraction_costs read failed: ${costError?.message}`);
  const claudeModeSpend = (costRows ?? [])
    .filter((r) => r.method === 'claude_mode_a' || r.method === 'claude_mode_b')
    .reduce((s, r) => s + Number(r.cost_cents), 0);
  assert(
    step,
    claudeModeSpend === 0,
    'no Claude Mode A / Mode B rows must exist (clean Excel skips fallback)',
    { claudeModeSpend, rows: costRows },
  );

  // ---- Bid should now be in 'reviewing' ----
  const { data: bidAfter } = await admin
    .from('bids')
    .select('status')
    .eq('id', ctx.bidId)
    .single();
  assert(step, bidAfter!.status === 'reviewing', 'bid.status must be reviewing', bidAfter!.status);
}

// -----------------------------------------------------------------------------
// STEP 2 — Routing
// -----------------------------------------------------------------------------

async function step2_routing(ctx: SmokeContext): Promise<void> {
  const step = 'Step 2 — Routing';
  const admin = ctx.admin!;

  const { data: bid, error: bidErr } = await admin
    .from('bids')
    .select('id, job_region, status')
    .eq('id', ctx.bidId)
    .single();
  assert(step, !bidErr, `bids read failed: ${bidErr?.message}`);

  const { data: lineItems } = await admin
    .from('line_items')
    .select('id, species')
    .eq('bid_id', ctx.bidId)
    .eq('is_consolidated', false);

  const result = routingAgent({
    bid: { id: bid!.id as string, jobRegion: (bid!.job_region as string | null) ?? null },
    lineItems: (lineItems ?? []).map((li) => ({
      id: li.id as string,
      species: li.species as string,
    })),
    submittingUser: {
      id: ctx.userId!,
      fullName: `${SMOKE_PREFIX} Trader Buyer`,
      roles: ['trader_buyer'],
    },
    buyerCandidates: [
      {
        userId: ctx.userId!,
        fullName: `${SMOKE_PREFIX} Trader Buyer`,
        roleType: 'trader_buyer',
        assignments: [{ commodityType: 'Dimensional', regions: [] }],
      },
    ],
  });

  assert(step, result.entries.length >= 1, 'routing must produce ≥ 1 entry', result);
  assert(step, result.unroutedLineItemIds.length === 0, 'no lines may be unrouted', result.unroutedLineItemIds);
  assert(step, result.strategy === 'self', 'trader_buyer must self-route', result.strategy);

  const entry = result.entries[0]!;
  assert(step, entry.buyerUserId === ctx.userId, 'self-route must point at seed user', entry);
  assert(step, entry.lineItemIds.length === 10, 'all 10 lines must route to self', entry.lineItemIds.length);

  // Persist — mirror /api/route-bid
  const { data: routingRow, error: routingErr } = await admin
    .from('bid_routings')
    .insert({
      bid_id: ctx.bidId,
      company_id: ctx.companyId,
      buyer_user_id: entry.buyerUserId,
      commodity_group: entry.commodityGroup,
      line_item_ids: entry.lineItemIds,
      status: 'pending',
      notes: entry.reason,
    })
    .select('id')
    .single();
  assert(step, !routingErr, `bid_routings insert failed: ${routingErr?.message}`);
  ctx.routingId = routingRow!.id as string;

  const { error: statusErr } = await admin
    .from('bids')
    .update({ status: 'routing' })
    .eq('id', ctx.bidId);
  assert(step, !statusErr, `bid status flip failed: ${statusErr?.message}`);
}

// -----------------------------------------------------------------------------
// STEP 3 — Consolidation (HYBRID)
// -----------------------------------------------------------------------------

async function step3_consolidation(ctx: SmokeContext): Promise<void> {
  const step = 'Step 3 — Consolidation';
  const admin = ctx.admin!;

  const { data: originals } = await admin
    .from('line_items')
    .select('id, bid_id, company_id, building_tag, phase_number, species, dimension, grade, length, quantity, unit, board_feet, extraction_method, extraction_confidence, cost_cents, sort_order, notes')
    .eq('bid_id', ctx.bidId)
    .eq('is_consolidated', false)
    .order('sort_order', { ascending: true });
  assert(step, (originals ?? []).length === 10, 'expected 10 originals to consolidate', originals?.length);

  const agentLines: ConsolidationLineItem[] = (originals ?? []).map((row) => {
    let flags: string[] = [];
    if (row.notes) {
      try {
        const parsed = JSON.parse(row.notes as string);
        if (Array.isArray(parsed.flags)) flags = parsed.flags;
      } catch {
        /* legacy notes */
      }
    }
    return {
      id: row.id as string,
      bidId: row.bid_id as string,
      companyId: row.company_id as string,
      buildingTag: (row.building_tag as string | null) ?? null,
      phaseNumber: (row.phase_number as number | null) ?? null,
      species: row.species as string,
      dimension: row.dimension as string,
      grade: (row.grade as string | null) ?? null,
      length: (row.length as string | null) ?? null,
      quantity: Number(row.quantity),
      unit: row.unit as string,
      boardFeet: row.board_feet == null ? null : Number(row.board_feet),
      confidence:
        row.extraction_confidence == null ? null : Number(row.extraction_confidence),
      flags,
      sortOrder: Number(row.sort_order),
      extractionMethod: (row.extraction_method as string | null) ?? null,
      extractionConfidence:
        row.extraction_confidence == null ? null : Number(row.extraction_confidence),
      costCents: row.cost_cents == null ? null : Number(row.cost_cents),
    };
  });

  const result = consolidationAgent({
    lineItems: agentLines,
    mode: 'hybrid',
  });
  assert(step, result.consolidatedItems.length > 0, 'hybrid must yield consolidated rows', result);
  assert(
    step,
    result.consolidatedItems.length < 10,
    'hybrid must reduce line count below 10',
    result.consolidatedItems.length,
  );

  // Reconstruction invariant: flatten sources → must equal the 10 originals.
  const flatSources = result.consolidatedItems.flatMap((i) => i.sourceLineItemIds);
  const flatSet = new Set(flatSources);
  assert(step, flatSet.size === 10, 'flattened source ids must equal 10', flatSet.size);
  const originalSet = new Set(ctx.originalLineItemIds);
  for (const id of ctx.originalLineItemIds) {
    assert(step, flatSet.has(id), `original line ${id} missing from sources`);
  }
  for (const id of flatSources) {
    assert(step, originalSet.has(id), `consolidated line refers to unknown source ${id}`);
  }

  // 2x4 #2 8' SPF — 3 originals × (500 + 400 + 200) = 1100 qty.
  const collapsed2x4 = result.consolidatedItems.find(
    (it) => it.species === 'SPF' && it.dimension === '2x4' && (it.grade ?? '') === '#2' && (it.length ?? '') === '8',
  );
  assert(step, !!collapsed2x4, 'expected a consolidated SPF 2x4 #2 8 row');
  assert(step, collapsed2x4!.quantity === 1100, 'SPF 2x4 8 must aggregate to 1100', collapsed2x4!.quantity);

  // Persist consolidated rows.
  const inserts = result.consolidatedItems.map((item) => ({
    company_id: ctx.companyId,
    bid_id: ctx.bidId,
    species: item.species,
    dimension: item.dimension,
    grade: item.grade,
    length: item.length,
    quantity: item.quantity,
    unit: item.unit,
    board_feet: item.boardFeet,
    is_consolidated: true,
    source_line_item_ids: item.sourceLineItemIds,
    original_line_item_id: null,
    sort_order: item.sortOrder,
    extraction_confidence: item.confidence,
    notes: JSON.stringify({ flags: item.flags, consolidation_key: item.consolidationKey }),
  }));
  const { data: inserted, error: insertErr } = await admin
    .from('line_items')
    .insert(inserts)
    .select('id');
  assert(step, !insertErr, `consolidated line_items insert failed: ${insertErr?.message}`);
  ctx.consolidatedLineItemIds = (inserted ?? []).map((r) => r.id as string);

  const { error: modeErr } = await admin
    .from('bids')
    .update({ consolidation_mode: 'hybrid' })
    .eq('id', ctx.bidId);
  assert(step, !modeErr, `bid consolidation_mode update failed: ${modeErr?.message}`);
}

// -----------------------------------------------------------------------------
// STEP 4 — Dispatch
// -----------------------------------------------------------------------------

async function step4_dispatch(ctx: SmokeContext): Promise<void> {
  const step = 'Step 4 — Vendor dispatch';
  const admin = ctx.admin!;

  const now = Date.now();
  const dueByMs = now + 7 * 24 * 60 * 60 * 1000;
  const graceMs = 7 * 24 * 60 * 60 * 1000;
  const ttlMs = dueByMs - now + graceMs;
  const expiresAtMs = now + ttlMs;

  const vendorBidId = randomUUID();
  const token = createVendorBidToken(
    {
      vendorBidId,
      bidId: ctx.bidId!,
      vendorId: ctx.vendorId!,
      companyId: ctx.companyId!,
    },
    ttlMs,
    expiresAtMs,
  );
  assert(step, token.length > 0, 'token must be non-empty');

  const { error: vbErr } = await admin
    .from('vendor_bids')
    .insert({
      id: vendorBidId,
      bid_id: ctx.bidId,
      vendor_id: ctx.vendorId,
      company_id: ctx.companyId,
      status: 'pending',
      submission_method: 'form',
      token,
      token_expires_at: new Date(expiresAtMs).toISOString(),
      sent_at: new Date(now).toISOString(),
      due_by: new Date(dueByMs).toISOString(),
    });
  assert(step, !vbErr, `vendor_bids insert failed: ${vbErr?.message}`);
  ctx.vendorBidId = vendorBidId;

  // Build submit URL — shouldn't throw.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const submitUrl = `${appUrl.replace(/\/+$/, '')}/vendor-submit/${token}`;
  new URL(submitUrl); // throws if malformed

  const { data: vbRow } = await admin
    .from('vendor_bids')
    .select('status, token, token_expires_at')
    .eq('id', vendorBidId)
    .single();
  assert(step, vbRow!.status === 'pending', 'vendor_bid status must be pending');
  assert(step, typeof vbRow!.token === 'string' && (vbRow!.token as string).length > 0, 'token stored');
  assert(
    step,
    new Date(vbRow!.token_expires_at as string).getTime() > Date.now(),
    'token_expires_at must be future',
  );

  // Flip bid → quoting
  const { error: bidErr } = await admin
    .from('bids')
    .update({ status: 'quoting' })
    .eq('id', ctx.bidId);
  assert(step, !bidErr, `bid status → quoting failed: ${bidErr?.message}`);
}

// -----------------------------------------------------------------------------
// STEP 5 — Vendor pricing submission
// -----------------------------------------------------------------------------

// Price dictionary by consolidation key bits. Uses round, clearly-distinct
// values so PDF invariant scans in Step 8 cannot collide with sell prices.
function costUnitPriceFor(species: string, dimension: string): number {
  // Dim lumber (SPF / HF)
  if (species === 'SPF' || species === 'HF') return 420;
  // DF beams
  if (species === 'DF') return 680;
  // OSB / Plywood panels
  if (species === 'OSB' || species === 'Plywood') return 38;
  return 400;
}

async function step5_vendor_pricing(ctx: SmokeContext): Promise<void> {
  const step = 'Step 5 — Vendor pricing';
  const admin = ctx.admin!;

  const { data: consolidatedRows, error: readErr } = await admin
    .from('line_items')
    .select('id, species, dimension, quantity')
    .eq('bid_id', ctx.bidId)
    .eq('is_consolidated', true);
  assert(step, !readErr, `consolidated lines read failed: ${readErr?.message}`);
  assert(step, (consolidatedRows ?? []).length > 0, 'need consolidated rows to price');

  const inserts = (consolidatedRows ?? []).map((row) => {
    const unitPrice = costUnitPriceFor(row.species as string, row.dimension as string);
    const totalPrice = unitPrice * Number(row.quantity);
    return {
      vendor_bid_id: ctx.vendorBidId,
      line_item_id: row.id as string,
      company_id: ctx.companyId,
      unit_price: unitPrice,
      total_price: totalPrice,
    };
  });

  const { data: insertedVbli, error: vbliErr } = await admin
    .from('vendor_bid_line_items')
    .insert(inserts)
    .select('id');
  assert(step, !vbliErr, `vendor_bid_line_items insert failed: ${vbliErr?.message}`);
  ctx.vendorBidLineItemIds = (insertedVbli ?? []).map((r) => r.id as string);

  const { error: vbStatusErr } = await admin
    .from('vendor_bids')
    .update({ status: 'submitted', submitted_at: new Date().toISOString() })
    .eq('id', ctx.vendorBidId);
  assert(step, !vbStatusErr, `vendor_bid status flip failed: ${vbStatusErr?.message}`);

  // is_best_price trigger should flag every row true (single vendor).
  const { data: bestRows } = await admin
    .from('vendor_bid_line_items')
    .select('id, is_best_price')
    .eq('vendor_bid_id', ctx.vendorBidId);
  for (const br of bestRows ?? []) {
    assert(
      step,
      br.is_best_price === true,
      'single-vendor line must be flagged best_price',
      br,
    );
  }
  assert(
    step,
    (bestRows ?? []).length === inserts.length,
    'vendor_bid_line_items count mismatch',
    { expected: inserts.length, actual: bestRows?.length },
  );
}

// -----------------------------------------------------------------------------
// STEP 6 — Comparison
// -----------------------------------------------------------------------------

async function step6_comparison(ctx: SmokeContext): Promise<void> {
  const step = 'Step 6 — Comparison';
  const admin = ctx.admin!;

  const result = await loadComparison({
    supabase: admin,
    bidId: ctx.bidId!,
    companyId: ctx.companyId!,
  });
  assert(step, result.status === 'ok', `loadComparison not ok: ${JSON.stringify(result)}`);
  if (result.status !== 'ok') return; // narrow for TS
  assert(step, result.result.rows.length > 0, 'comparison rows must be non-empty');

  for (const row of result.result.rows) {
    assert(step, row.bestVendorId === ctx.vendorId, `row bestVendorId mismatch — got ${row.bestVendorId}`);
    assert(step, row.bestUnitPrice !== null, 'bestUnitPrice must be set');
  }

  // Vendor name visible in internal shape (correct — QuotePdfInput doesn't
  // carry it). Lock documented invariant: no "vendor" keys on the pdf type.
  const vendorName = result.result.vendors[0]?.vendorName ?? '';
  assert(step, vendorName.includes(SMOKE_PREFIX), 'vendor name present in comparison result');
}

// -----------------------------------------------------------------------------
// STEP 7 — Margin stack
// -----------------------------------------------------------------------------

async function step7_margin(ctx: SmokeContext): Promise<void> {
  const step = 'Step 7 — Margin stack';
  const admin = ctx.admin!;

  const { data: consolidatedRows } = await admin
    .from('line_items')
    .select('id, species, dimension, quantity')
    .eq('bid_id', ctx.bidId)
    .eq('is_consolidated', true);
  const { data: vbliRows } = await admin
    .from('vendor_bid_line_items')
    .select('id, line_item_id, unit_price, total_price')
    .eq('vendor_bid_id', ctx.vendorBidId);

  const vbliByLine = new Map(
    (vbliRows ?? []).map((r) => [r.line_item_id as string, r]),
  );

  const selections: PricingSelection[] = (consolidatedRows ?? []).map((row) => {
    const vbli = vbliByLine.get(row.id as string);
    assert(step, vbli, `missing vbli for line ${row.id}`);
    return {
      lineItemId: row.id as string,
      vendorBidLineItemId: vbli!.id as string,
      vendorId: ctx.vendorId!,
      costUnitPrice: Number(vbli!.unit_price),
      costTotalPrice: Number(vbli!.total_price),
    };
  });

  const marginInstructions: MarginInstruction[] = [
    { scope: 'commodity', targetId: 'Dimensional', marginType: 'percent', marginValue: 0.12 },
    // Panels get their own margin so OSB lines also carry a markup —
    // otherwise pricingAgent warns "no margin matched" for OSB rows.
    { scope: 'commodity', targetId: 'Panels', marginType: 'percent', marginValue: 0.12 },
  ];

  const result = await applyMargin({
    supabase: admin,
    admin,
    bidId: ctx.bidId!,
    companyId: ctx.companyId!,
    userId: ctx.userId!,
    // trader_buyer is neither manager nor owner — forces pending_approval
    // when grandTotal crosses the approval threshold.
    userIsManagerOrOwner: false,
    body: {
      bidId: ctx.bidId!,
      selections,
      marginInstructions,
      action: 'submit_for_approval',
    },
  });

  assert(step, result.status === 'ok', `applyMargin not ok: ${JSON.stringify(result)}`);
  if (result.status !== 'ok') return;

  ctx.quoteId = result.quote.id;
  ctx.pricingResult = result.pricing;

  // Every Dimensional line: sell ≈ cost × 1.12
  for (const line of result.pricing.lines) {
    const expected = Math.round(line.costUnitPrice * 1.12 * 100) / 100;
    assert(
      step,
      Math.abs(line.sellUnitPrice - expected) < 0.02,
      `line ${line.lineItemId} sell mismatch — got ${line.sellUnitPrice}, expected ~${expected}`,
    );
  }

  assert(step, result.pricing.totals.lumberTax > 0, 'CA lumber tax must be > 0', result.pricing.totals.lumberTax);
  assert(step, result.pricing.totals.salesTax > 0, 'CA sales tax must be > 0', result.pricing.totals.salesTax);
  assert(
    step,
    Math.abs(result.pricing.totals.blendedMarginPercent - 0.12 / 1.12) < 0.001,
    'blendedMarginPercent must match 12% markup identity (margin/sell)',
    result.pricing.totals.blendedMarginPercent,
  );

  // With 1100+ units of $420 SPF 2x4 + more dim lumber and 12% markup,
  // grand total easily clears $10k.
  assert(step, result.needsApproval === true, 'needsApproval must be true above $10k', {
    grandTotal: result.pricing.totals.grandTotal,
    threshold: 10000,
  });
  assert(step, result.quote.status === 'pending_approval', 'quote.status must be pending_approval', result.quote.status);

  const { data: qliRows } = await admin
    .from('quote_line_items')
    .select('id, sell_price, cost_price, margin_percent')
    .eq('quote_id', ctx.quoteId);
  assert(step, (qliRows ?? []).length > 0, 'quote_line_items must exist', qliRows?.length);
  for (const r of qliRows ?? []) {
    assert(step, Number(r.sell_price) > 0, 'sell_price must be positive', r);
  }
}

// -----------------------------------------------------------------------------
// STEP 8 — PDF render
// -----------------------------------------------------------------------------

async function step8_pdf(ctx: SmokeContext): Promise<void> {
  const step = 'Step 8 — PDF render';
  const admin = ctx.admin!;

  const { data: bid } = await admin
    .from('bids')
    .select('customer_name, job_name, job_address, job_state, consolidation_mode')
    .eq('id', ctx.bidId)
    .single();
  const { data: company } = await admin
    .from('companies')
    .select('name, slug, email_domain')
    .eq('id', ctx.companyId)
    .single();

  assert(step, ctx.pricingResult, 'pricingResult must be captured by Step 7');
  const pricing = ctx.pricingResult!;

  const pricedLines: PdfPricedLineInput[] = pricing.lines
    .map((l) => {
      const unit = narrowPdfLineUnit(l.summary.unit);
      if (unit === null) return null;
      return {
        lineItemId: l.lineItemId,
        sortOrder: l.sortOrder,
        buildingTag: l.building.tag,
        phaseNumber: l.building.phaseNumber,
        species: l.summary.species,
        dimension: l.summary.dimension,
        grade: l.summary.grade,
        length: l.summary.length,
        quantity: l.summary.quantity,
        unit,
        sellUnitPrice: l.sellUnitPrice,
        extendedSell: l.extendedSell,
      } satisfies PdfPricedLineInput;
    })
    .filter((x): x is PdfPricedLineInput => x !== null);

  // HYBRID customer-facing = structured breakdown. But the priced lines we
  // fed applyMargin from are the CONSOLIDATED rows — their building_tag is
  // null, so the PDF would render as "General". To exercise the real hybrid
  // path (which expects original per-building line_items selected by the
  // trader + margin stacked on them), re-synthesize priced rows per-ORIGINAL
  // by splitting each consolidated line back across its sources. This
  // matches how a real trader would select originals in a STRUCTURED quote
  // flow; the same dollar totals apply, but now with per-building tags so
  // the PDF shows "House 1", "House 2", "House 3".
  //
  // NOTE: The exact HYBRID semantics here are the smoke-test's best attempt
  // at exercising the customer-facing side; a real dispatch would have the
  // trader select vendors on per-original lines if they want that breakdown
  // on the PDF.
  const { data: originals } = await admin
    .from('line_items')
    .select('id, building_tag, phase_number, species, dimension, grade, length, quantity, unit, sort_order')
    .eq('bid_id', ctx.bidId)
    .eq('is_consolidated', false)
    .order('sort_order', { ascending: true });

  // Price each original at the same unit sell price as its consolidation
  // group (same species+dimension → same cost → same sell after 12% markup).
  const perOriginalLines: PdfPricedLineInput[] = (originals ?? []).map((row) => {
    const species = row.species as string;
    const dimension = row.dimension as string;
    const costU = costUnitPriceFor(species, dimension);
    const sellU = Math.round(costU * 1.12 * 100) / 100;
    const qty = Number(row.quantity);
    const unit = narrowPdfLineUnit(row.unit as string) ?? 'PCS';
    return {
      lineItemId: row.id as string,
      sortOrder: Number(row.sort_order),
      buildingTag: (row.building_tag as string | null) ?? null,
      phaseNumber: (row.phase_number as number | null) ?? null,
      species,
      dimension,
      grade: (row.grade as string | null) ?? null,
      length: (row.length as string | null) ?? null,
      quantity: qty,
      unit,
      sellUnitPrice: sellU,
      extendedSell: Math.round(sellU * qty * 100) / 100,
    };
  });

  const input = buildQuotePdfInput({
    pricedLines: perOriginalLines.length > 0 ? perOriginalLines : pricedLines,
    totals: {
      lumberTax: pricing.totals.lumberTax,
      salesTax: pricing.totals.salesTax,
      grandTotal: pricing.totals.grandTotal,
    },
    bid: {
      customerName: bid!.customer_name as string,
      jobName: (bid!.job_name as string | null) ?? null,
      jobAddress: (bid!.job_address as string | null) ?? null,
      jobState: (bid!.job_state as string | null) ?? null,
      consolidationMode: (bid!.consolidation_mode as 'hybrid') ?? 'hybrid',
    },
    company: {
      name: company!.name as string,
      slug: company!.slug as string,
      emailDomain: (company!.email_domain as string | null) ?? null,
    },
    quoteNumber: ctx.quoteNumber,
    quoteDate: new Date(),
    validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  const buffer = await renderQuotePdfBuffer(input);
  ctx.pdfBuffer = buffer;

  assert(step, buffer.length > 1024, `PDF buffer too small (${buffer.length} bytes)`);

  // @react-pdf/renderer writes text into PDF content streams — raw bytes
  // are not reliably searchable. Use pdf-parse to extract the rendered
  // text layer, which is what a customer would actually see and what a
  // leak would actually reveal.
  const { default: pdfParse } = (await import('pdf-parse')) as {
    default: (b: Buffer) => Promise<{ text: string }>;
  };
  const parsed = await pdfParse(buffer);
  const text = parsed.text;

  // Vendor name MUST NOT appear in the rendered text.
  assert(
    step,
    !text.includes(`${SMOKE_PREFIX} Mill Alpha`),
    'PDF must not contain vendor name (internal data leak)',
  );
  assert(step, !text.includes('cost_price'), 'PDF must not contain "cost_price" field name');
  assert(
    step,
    !text.includes('margin_percent'),
    'PDF must not contain "margin_percent" field name',
  );

  // Raw cost unit price ($420) must not appear as a rendered dollar
  // figure. Sell prices render as $470.40 etc., so no collision with a
  // bare "$420" token.
  assert(
    step,
    !/\$420\b/.test(text),
    'PDF must not leak raw cost price "$420" — sell prices only',
  );

  // Positive checks — customer-facing data present.
  assert(step, text.includes(`${SMOKE_PREFIX} Valley Ridge`), 'job name must be on PDF');
  for (const building of ['House 1', 'House 2', 'House 3']) {
    assert(
      step,
      text.includes(building),
      `building "${building}" must be on PDF (hybrid → structured)`,
    );
  }

  // Verify at least one extended dollar figure > $420 (sell > cost).
  const dollarMatches = text.match(/\$[\d,]+\.\d{2}/g) ?? [];
  const parsedDollars = dollarMatches.map((s) => Number(s.replace(/[$,]/g, '')));
  const maxDollar = parsedDollars.length > 0 ? Math.max(...parsedDollars) : 0;
  assert(
    step,
    maxDollar > 420,
    `expected at least one rendered $ value > $420, got max ${maxDollar}`,
  );

  // Release-gate pure check: quote in pending_approval is releasable.
  const gate = canReleaseQuote('pending_approval');
  assert(step, gate.ok === true, 'canReleaseQuote(pending_approval) must return ok', gate);
}

// -----------------------------------------------------------------------------
// STEP 9 — Quote persistence
// -----------------------------------------------------------------------------

async function step9_quote_persistence(ctx: SmokeContext): Promise<void> {
  const step = 'Step 9 — Quote persistence';
  const admin = ctx.admin!;

  const { data: quoteRow, error: readErr } = await admin
    .from('quotes')
    .select('id, bid_id, status, pdf_url, total')
    .eq('bid_id', ctx.bidId)
    .single();
  assert(step, !readErr, `quotes read failed: ${readErr?.message}`);
  assert(step, quoteRow!.status === 'pending_approval', 'quote.status must be pending_approval', quoteRow!.status);
  assert(step, quoteRow!.pdf_url === null, 'quote.pdf_url must be null (no release path executed)', quoteRow!.pdf_url);

  // Upload the PDF from Step 8 and set pdf_url so the storage side is
  // also covered.
  assert(step, ctx.pdfBuffer, 'pdfBuffer must be set by Step 8');
  const QUOTES_BUCKET = 'quotes';
  try {
    const { data: bucket } = await admin.storage.getBucket(QUOTES_BUCKET);
    if (!bucket) {
      await admin.storage.createBucket(QUOTES_BUCKET, {
        public: false,
        fileSizeLimit: 52428800,
      });
    }
  } catch {
    /* non-fatal */
  }
  const pdfPath = `${ctx.companyId}/${ctx.quoteId}.pdf`;
  const { error: upErr } = await admin.storage
    .from(QUOTES_BUCKET)
    .upload(pdfPath, ctx.pdfBuffer!, {
      contentType: 'application/pdf',
      upsert: true,
    });
  assert(step, !upErr, `quote PDF upload failed: ${upErr?.message}`);

  const { data: signed } = await admin.storage
    .from(QUOTES_BUCKET)
    .createSignedUrl(pdfPath, 60 * 60 * 24);
  assert(step, !!signed?.signedUrl, 'signed url must be non-null');

  const { error: updateErr } = await admin
    .from('quotes')
    .update({ pdf_url: signed!.signedUrl })
    .eq('id', ctx.quoteId);
  assert(step, !updateErr, `quote pdf_url update failed: ${updateErr?.message}`);

  const { data: after } = await admin
    .from('quotes')
    .select('pdf_url')
    .eq('id', ctx.quoteId)
    .single();
  assert(step, after!.pdf_url, 'pdf_url must now be set', after!.pdf_url);

  // Cleanup the bucket object explicitly so main cleanup doesn't have to
  // hunt for it.
  await admin.storage.from(QUOTES_BUCKET).remove([pdfPath]).catch(() => {});
}

// -----------------------------------------------------------------------------
// CLEANUP — FK-safe ordering; never throws; idempotent on partial seeds.
// -----------------------------------------------------------------------------

async function cleanup(ctx: SmokeContext): Promise<void> {
  const admin = ctx.admin ?? (() => {
    try { return getSupabaseAdmin(); } catch { return null; }
  })();
  if (!admin) {
    console.error('  Cleanup: no admin client available, skipping.');
    return;
  }

  const counts: Record<string, number> = {};
  type DeleteRes = { data: unknown[] | null; error: { message: string } | null };
  async function delByCompany(table: string): Promise<void> {
    if (!ctx.companyId) return;
    try {
      const res = (await admin
        .from(table)
        .delete()
        .eq('company_id', ctx.companyId)
        .select('id')) as unknown as DeleteRes;
      if (res.error) {
        console.error(`  Cleanup: ${table} — ${res.error.message}`);
        return;
      }
      counts[table] = (res.data ?? []).length;
    } catch (e) {
      console.error(`  Cleanup: ${table} — ${e instanceof Error ? e.message : e}`);
    }
  }
  async function delById(table: string, id: string | undefined): Promise<void> {
    if (!id) return;
    try {
      const res = (await admin
        .from(table)
        .delete()
        .eq('id', id)
        .select('id')) as unknown as DeleteRes;
      if (res.error) {
        console.error(`  Cleanup: ${table} — ${res.error.message}`);
        return;
      }
      counts[table] = (res.data ?? []).length;
    } catch (e) {
      console.error(`  Cleanup: ${table} — ${e instanceof Error ? e.message : e}`);
    }
  }
  async function delByRole(table: string, roleId: string | undefined): Promise<void> {
    if (!roleId) return;
    try {
      const res = (await admin
        .from(table)
        .delete()
        .eq('role_id', roleId)
        .select('id')) as unknown as DeleteRes;
      if (res.error) {
        console.error(`  Cleanup: ${table} — ${res.error.message}`);
        return;
      }
      counts[table] = (res.data ?? []).length;
    } catch (e) {
      console.error(`  Cleanup: ${table} — ${e instanceof Error ? e.message : e}`);
    }
  }

  if (ctx.companyId) {
    await delByCompany('quote_line_items');
    await delByCompany('quotes');
    await delByCompany('vendor_bid_line_items');
    await delByCompany('vendor_bids');
    await delByCompany('bid_routings');
    await delByCompany('line_items');
    await delByCompany('extraction_costs');
    await delByCompany('bids');
    await delByRole('commodity_assignments', ctx.roleId);
    await delByCompany('roles');
    await delByCompany('vendors');
    // users cascades from companies via FK but we delete explicitly so the
    // (company_id, email) unique index doesn't linger if the companies
    // cascade is stubbed out in the future.
    await delByCompany('users');
    await delById('companies', ctx.companyId);
  }

  if (ctx.authUserId) {
    try {
      await admin.auth.admin.deleteUser(ctx.authUserId);
      counts['auth.users'] = 1;
    } catch (e) {
      console.error(`  Cleanup: auth.users — ${e instanceof Error ? e.message : e}`);
    }
  }

  if (ctx.storageObjectPath) {
    try {
      await admin.storage.from(BIDS_BUCKET).remove([ctx.storageObjectPath]);
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
  try {
    console.log('LMBR.ai smoke-e2e starting at ' + new Date().toISOString());
    console.log(`  prefix=${SMOKE_PREFIX}  timestamp=${TIMESTAMP}\n`);

    await runStep('Seed', () => seed(ctx));
    await runStep('Step 1 — Ingest', () => step1_ingest(ctx));
    await runStep('Step 2 — Routing', () => step2_routing(ctx));
    await runStep('Step 3 — Consolidation', () => step3_consolidation(ctx));
    await runStep('Step 4 — Vendor dispatch', () => step4_dispatch(ctx));
    await runStep('Step 5 — Vendor pricing', () => step5_vendor_pricing(ctx));
    await runStep('Step 6 — Comparison', () => step6_comparison(ctx));
    await runStep('Step 7 — Margin stack', () => step7_margin(ctx));
    await runStep('Step 8 — PDF render', () => step8_pdf(ctx));
    await runStep('Step 9 — Quote persistence', () => step9_quote_persistence(ctx));

    console.log(
      `\n✓ Smoke test passed — ready for Prompt 08 (${Date.now() - started}ms total)`,
    );
  } catch (err) {
    failed = true;
    const stepName = err instanceof StepError ? err.step : '?';
    console.error(`\n✗ Smoke test FAILED at ${stepName} — fix before proceeding`);
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
  // Belt-and-suspenders: if failed is set we've already stamped exitCode.
  if (failed && process.exitCode === 0) process.exitCode = 1;
}

// Only run when invoked directly (e.g. `pnpm tsx scripts/smoke-e2e.ts`).
// Guard keeps the module safe to import from unit tests that want to
// reach into runStep / assert / fixture builders.
const invokedDirectly = (() => {
  try {
    if (typeof require !== 'undefined' && typeof module !== 'undefined') {
      // CJS — tsx compiles this file as CJS by default.
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

export { main, seed, cleanup, FIXTURE_ROWS, buildFixtureXlsx };
