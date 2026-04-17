/**
 * Market agent — LMBR Cash Market Index builder + price lookup + budget estimator.
 *
 * Purpose:  Three cooperating primitives that build the long-term moat:
 *             1. aggregateMarketSnapshots  — rolls up vendor bid prices
 *                into daily anonymized snapshots for the Cash Index.
 *             2. lookupMarketPrice         — resolves a price for a
 *                given (species, dimension, grade, region, unit) via a
 *                4-level fallback cascade with a 30-day staleness cutoff.
 *             3. generateBudgetQuote       — assembles a market-rate
 *                estimate when a trader needs a ballpark number before
 *                running a vendor cycle.
 *
 *           Pure TypeScript. NO LLM on the price path — this is the
 *           money-math layer, same discipline as pricing-agent and
 *           comparison-agent. Every decision has to be reproducible
 *           from the inputs alone so the unit tests can lock the
 *           contract down.
 *
 *           Anonymization floor (non-negotiable):
 *             A snapshot is only written when at least 3 distinct
 *             BUYER companies (bids.company_id) contributed a priced
 *             vendor_bid_line_items row to that slice on that day.
 *             Not 3 vendors — 3 buyers. The constraint is enforced
 *             both here (in buildSnapshots) and in the DB (CHECK on
 *             market_price_snapshots.company_count, migration 024).
 *             Defense-in-depth; a buggy writer cannot cross the floor.
 *
 *           Stale-data cutoff (non-negotiable):
 *             lookupMarketPrice ignores snapshots older than 30 days.
 *             A six-month-old price is directional noise in lumber;
 *             surfacing it as a "current" market rate is worse than
 *             surfacing nothing. The 30-day window is a product
 *             decision — see CLAUDE.md Market Intelligence section.
 *
 *           Terminology (non-negotiable):
 *             NEVER call the output of generateBudgetQuote a "quote"
 *             in user-facing strings. It's a market-rate ESTIMATE.
 *             It is not a quote until a vendor has bid it. The
 *             BudgetQuote type name is internal; the UI surfaces it
 *             as "Budget estimate" or "Market rate estimate".
 *
 *           Composable for testability:
 *             buildSnapshots / matchCascade / composeBudgetQuote are
 *             pure functions with no DB. aggregateMarketSnapshots /
 *             lookupMarketPrice / generateBudgetQuote are thin
 *             orchestrators that wire those primitives to Supabase.
 *             Tests assert the pure layer directly; the orchestrators
 *             get covered by the smoke-e2e integration suite (Step 4
 *             extends it).
 *
 * Inputs:   Service-role Supabase client (orchestrators) OR in-memory
 *           fixtures (pure functions).
 * Outputs:  buildSnapshots, matchCascade, composeBudgetQuote,
 *           aggregateMarketSnapshots, lookupMarketPrice,
 *           generateBudgetQuote, ANONYMIZATION_FLOOR,
 *           MAX_SNAPSHOT_AGE_DAYS.
 * Agent/API: Supabase (service-role, cross-tenant aggregation by
 *            design).
 * Imports:  @lmbr/lib (getSupabaseAdmin), @lmbr/types, node:crypto (randomUUID).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { randomUUID } from 'node:crypto';

import { getSupabaseAdmin } from '@lmbr/lib';
import type {
  BudgetQuote,
  BudgetQuoteFallbackLevel,
  BudgetQuoteLine,
  MarketPriceSnapshot,
  MarketSnapshotUnit,
} from '@lmbr/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum distinct BUYER companies (bids.company_id) required before a
 * slice can land in market_price_snapshots. Enforced here and in the
 * DB; changing this requires both a code change AND a migration.
 */
export const ANONYMIZATION_FLOOR = 3;

/**
 * Snapshots older than this are treated as "no data" by lookupMarketPrice.
 * Product decision — see file header.
 */
export const MAX_SNAPSHOT_AGE_DAYS = 30;

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

/**
 * One raw contributing price point — what buildSnapshots consumes. The
 * aggregateMarketSnapshots orchestrator fetches this shape from the DB;
 * tests construct it inline.
 */
export interface RawBidPrice {
  unitPrice: number;
  species: string;
  dimension: string | null;
  grade: string | null;
  unit: MarketSnapshotUnit;
  /** bids.company_id — NOT vendors.company_id (vendors belong to buyers). */
  companyId: string;
  region: string | null;
}

/**
 * Snapshot-ready row with DB-shape column names so a direct upsert is a
 * one-liner. The orchestrator adds nothing — this shape is the payload
 * that lands in market_price_snapshots.
 */
export interface SnapshotInsert {
  species: string;
  dimension: string | null;
  grade: string | null;
  region: string | null;
  unit: MarketSnapshotUnit;
  sample_date: string;
  company_count: number;
  sample_size: number;
  price_median: number;
  price_mean: number;
  price_low: number;
  price_high: number;
  price_spread: number;
}

export interface LookupQuery {
  species: string;
  dimension: string | null;
  grade: string | null;
  region: string | null;
  unit: MarketSnapshotUnit;
}

export type CascadeLevel = BudgetQuoteFallbackLevel | 'none';

export interface LookupResult {
  snapshot: MarketPriceSnapshot | null;
  level: CascadeLevel;
}

export interface AggregateResult {
  sampleDate: string;
  scanned: number;
  slicesConsidered: number;
  slicesBelowFloor: number;
  slicesWritten: number;
}

// ---------------------------------------------------------------------------
// Pure: buildSnapshots
// ---------------------------------------------------------------------------

/**
 * Group raw bid prices by slice, apply the 3-buyer anonymization floor,
 * compute distribution stats per slice. Output is deterministic — same
 * input always produces the same SnapshotInsert[] (up to map iteration
 * order, which we sort for stability).
 */
export function buildSnapshots(
  rows: RawBidPrice[],
  sampleDate: string,
): SnapshotInsert[] {
  const groups = new Map<string, RawBidPrice[]>();
  for (const row of rows) {
    if (!Number.isFinite(row.unitPrice) || row.unitPrice <= 0) continue;
    const key = sliceKey(row);
    const arr = groups.get(key) ?? [];
    arr.push(row);
    groups.set(key, arr);
  }

  const out: SnapshotInsert[] = [];
  // Array.from(…) rather than `for (const [, slice] of groups)` so the
  // code targets any ES target without downlevelIteration — the smoke
  // harness invokes this outside the agents package's own tsconfig.
  for (const slice of Array.from(groups.values())) {
    const companies = new Set(slice.map((r) => r.companyId));
    if (companies.size < ANONYMIZATION_FLOOR) continue;

    const prices = slice.map((r) => r.unitPrice).sort((a, b) => a - b);
    const head = slice[0]!;
    const low = prices[0]!;
    const high = prices[prices.length - 1]!;

    out.push({
      species: head.species,
      dimension: head.dimension,
      grade: head.grade,
      region: head.region,
      unit: head.unit,
      sample_date: sampleDate,
      company_count: companies.size,
      sample_size: slice.length,
      price_median: median(prices),
      price_mean: mean(prices),
      price_low: round2(low),
      price_high: round2(high),
      price_spread: round2(high - low),
    });
  }

  // Stable ordering so callers (and tests) see a deterministic array.
  out.sort((a, b) => sliceKeyFromInsert(a).localeCompare(sliceKeyFromInsert(b)));
  return out;
}

function sliceKey(row: RawBidPrice): string {
  return [
    row.species,
    row.dimension ?? '',
    row.grade ?? '',
    row.region ?? '',
    row.unit,
  ].join('|');
}

function sliceKeyFromInsert(s: SnapshotInsert): string {
  return [s.species, s.dimension ?? '', s.grade ?? '', s.region ?? '', s.unit].join('|');
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  const val =
    n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return round2(val);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  return round2(sum / values.length);
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Pure: matchCascade
// ---------------------------------------------------------------------------

/**
 * Walk the 4-level fallback cascade. Caller supplies candidate snapshots
 * already filtered to within the 30-day staleness window; this function
 * never re-checks dates.
 *
 *   Level 1 — exact: species + dimension + grade + region all match.
 *   Level 2 — region_any: same species + dimension + grade; any region.
 *   Level 3 — grade_any: same species + dimension; any grade / region.
 *   Level 4 — none: null return.
 *
 * `unit` must always match. Mixing MBF and MSF in a single fallback is
 * a category error (a piece price for a panel product is not a
 * substitute for a board-foot price for dimensional lumber).
 *
 * Within each level, the most recent sample_date wins.
 */
export function matchCascade(
  snapshots: MarketPriceSnapshot[],
  query: LookupQuery,
): LookupResult {
  const base = snapshots.filter(
    (s) => s.species === query.species && s.unit === query.unit,
  );
  const sorted = [...base].sort((a, b) =>
    b.sampleDate.localeCompare(a.sampleDate),
  );

  const exact = sorted.find(
    (s) =>
      s.dimension === query.dimension &&
      s.grade === query.grade &&
      s.region === query.region,
  );
  if (exact) return { snapshot: exact, level: 'exact' };

  const regionAny = sorted.find(
    (s) => s.dimension === query.dimension && s.grade === query.grade,
  );
  if (regionAny) return { snapshot: regionAny, level: 'region_any' };

  const gradeAny = sorted.find((s) => s.dimension === query.dimension);
  if (gradeAny) return { snapshot: gradeAny, level: 'grade_any' };

  return { snapshot: null, level: 'none' };
}

// ---------------------------------------------------------------------------
// Pure: composeBudgetQuote
// ---------------------------------------------------------------------------

export interface BudgetQuoteLineInput {
  commodityId: string;
  species: string;
  dimension: string | null;
  grade: string | null;
  unit: MarketSnapshotUnit;
  quantity: number;
  boardFeet?: number;
}

export interface ComposeBudgetQuoteArgs {
  companyId: string;
  customerName: string;
  region: string | null;
  lines: BudgetQuoteLineInput[];
  marginPct: number;
  generatedAtIso?: string;
  quoteId?: string;
}

/**
 * Assemble a market-rate ESTIMATE (never called a "quote" in UI) from
 * line inputs + an injectable price lookup. The DB orchestrator passes
 * a lookup backed by a Supabase query; tests pass an in-memory lookup
 * over fixture snapshots.
 */
export function composeBudgetQuote(
  args: ComposeBudgetQuoteArgs,
  lookup: (query: LookupQuery) => LookupResult,
): BudgetQuote {
  const pricedLines: BudgetQuoteLine[] = [];
  const unpricedLines: BudgetQuote['unpricedLines'] = [];
  let totalSellPrice = 0;

  for (const line of args.lines) {
    const result = lookup({
      species: line.species,
      dimension: line.dimension,
      grade: line.grade,
      region: args.region,
      unit: line.unit,
    });

    if (!result.snapshot || result.level === 'none') {
      unpricedLines.push({
        commodityId: line.commodityId,
        reason: 'insufficient_data',
      });
      continue;
    }

    // Spec: marginPct applies uniformly to all priced lines.
    const marketUnitPrice = result.snapshot.priceMedian;
    const sellUnitPrice = marketUnitPrice * (1 + args.marginPct);
    // quantity is already in the snapshot's unit (mbf / msf / piece).
    const extendedSellPrice = round2(sellUnitPrice * line.quantity);

    const pricedLine: BudgetQuoteLine = {
      commodityId: line.commodityId,
      quantity: line.quantity,
      marketUnitPrice: round2(marketUnitPrice),
      marginPct: args.marginPct,
      extendedSellPrice,
      companyCount: result.snapshot.companyCount,
      fallbackLevel: result.level,
    };
    if (line.boardFeet !== undefined) {
      pricedLine.boardFeet = line.boardFeet;
    }
    pricedLines.push(pricedLine);
    totalSellPrice += extendedSellPrice;
  }

  const quote: BudgetQuote = {
    id: args.quoteId ?? randomUUID(),
    companyId: args.companyId,
    customerName: args.customerName,
    lines: pricedLines,
    totalSellPrice: round2(totalSellPrice),
    generatedAt: args.generatedAtIso ?? new Date().toISOString(),
    unpricedLines,
  };
  if (args.region !== null) {
    quote.region = args.region;
  }
  return quote;
}

// ---------------------------------------------------------------------------
// Orchestrator: aggregateMarketSnapshots
// ---------------------------------------------------------------------------

interface AggregateArgs {
  /** ISO date YYYY-MM-DD. Defaults to today in UTC. */
  sampleDate?: string;
  /** Optional: scope aggregation to bids in one region. */
  region?: string;
}

function todayUtcIso(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfUtcDay(iso: string): string {
  return `${iso}T00:00:00.000Z`;
}

function startOfNextUtcDay(iso: string): string {
  // Parse as UTC midnight then add a day.
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/**
 * Daily aggregation pass. Reads every vendor_bid_line_items row whose
 * parent vendor_bid.submitted_at falls on sampleDate, inner-joined to a
 * non-archived bid, groups by slice, applies the 3-buyer floor, and
 * upserts into market_price_snapshots with ON CONFLICT DO NOTHING.
 *
 * Idempotent: re-running for the same sampleDate produces zero new
 * rows. The unique index on
 * (species, dimension, grade, region, unit, sample_date) is the
 * SQL-level guarantee; this function's determinism ensures the JS
 * layer sends the same payload on every re-run.
 */
export async function aggregateMarketSnapshots(
  args: AggregateArgs = {},
): Promise<AggregateResult> {
  const sampleDate = args.sampleDate ?? todayUtcIso();
  const dayStart = startOfUtcDay(sampleDate);
  const dayEnd = startOfNextUtcDay(sampleDate);

  const admin = getSupabaseAdmin();

  // Pull the raw prices. Joined shape:
  //   vendor_bid_line_items (unit_price)
  //     → line_items (species, dimension, grade, unit)
  //     → vendor_bids (status, submitted_at)
  //         → bids (company_id, job_region, status)
  //
  // !inner tells PostgREST to inner-join so the filters on the parent
  // tables actually constrain the row set.
  const selectSpec =
    'unit_price,' +
    ' line_items!inner(species, dimension, grade, unit),' +
    ' vendor_bids!inner(status, submitted_at,' +
    '   bids!inner(company_id, job_region, status))';

  let query = admin
    .from('vendor_bid_line_items')
    .select(selectSpec)
    .eq('vendor_bids.status', 'submitted')
    .gte('vendor_bids.submitted_at', dayStart)
    .lt('vendor_bids.submitted_at', dayEnd)
    // archived_at IS NULL is the single source of truth for "active"
    // bids (migration 027). Legacy status='archived' is dormant.
    // Nested filter via .filter() because PostgREST's .is() helper
    // doesn't accept a dotted path; .filter(path, 'is', null) does.
    .filter('vendor_bids.bids.archived_at', 'is', null)
    .not('unit_price', 'is', null);

  if (args.region) {
    query = query.eq('vendor_bids.bids.job_region', args.region);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`aggregateMarketSnapshots: fetch failed: ${error.message}`);
  }

  interface RowShape {
    unit_price: number | string;
    line_items: {
      species: string;
      dimension: string | null;
      grade: string | null;
      unit: string;
    };
    vendor_bids: {
      status: string;
      submitted_at: string;
      bids: {
        company_id: string;
        job_region: string | null;
        status: string;
      };
    };
  }

  const raw: RawBidPrice[] = [];
  for (const rowUnknown of (data ?? []) as unknown[]) {
    const row = rowUnknown as RowShape;
    const line = row.line_items;
    const vb = row.vendor_bids;
    const bid = vb?.bids;
    if (!line || !vb || !bid) continue;

    const unit = narrowUnit(line.unit);
    if (!unit) continue;

    const price = toFiniteNumber(row.unit_price);
    if (price === null) continue;

    raw.push({
      unitPrice: price,
      species: line.species,
      dimension: line.dimension,
      grade: line.grade,
      unit,
      companyId: bid.company_id,
      region: bid.job_region,
    });
  }

  const snapshots = buildSnapshots(raw, sampleDate);
  const slicesConsidered = countUniqueSlices(raw);
  const slicesBelowFloor = slicesConsidered - snapshots.length;

  if (snapshots.length === 0) {
    return {
      sampleDate,
      scanned: raw.length,
      slicesConsidered,
      slicesBelowFloor,
      slicesWritten: 0,
    };
  }

  // INSERT ... ON CONFLICT DO NOTHING. ignoreDuplicates: true at the
  // Supabase JS client level maps to the same SQL. The unique index
  // on (species, dimension, grade, region, unit, sample_date) makes
  // the conflict detection work.
  const { error: insertError, count } = await admin
    .from('market_price_snapshots')
    .upsert(snapshots, {
      onConflict: 'species,dimension,grade,region,unit,sample_date',
      ignoreDuplicates: true,
      count: 'exact',
    });
  if (insertError) {
    throw new Error(
      `aggregateMarketSnapshots: insert failed: ${insertError.message}`,
    );
  }

  return {
    sampleDate,
    scanned: raw.length,
    slicesConsidered,
    slicesBelowFloor,
    // Supabase returns the count of affected rows; treat null as
    // "unknown" and fall back to snapshots.length (the candidate count).
    slicesWritten: count ?? snapshots.length,
  };
}

function narrowUnit(value: string): MarketSnapshotUnit | null {
  if (value === 'mbf' || value === 'MBF') return 'mbf';
  if (value === 'msf' || value === 'MSF') return 'msf';
  if (value === 'piece' || value === 'PCS' || value === 'pcs') return 'piece';
  return null;
}

function toFiniteNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function countUniqueSlices(rows: RawBidPrice[]): number {
  const keys = new Set<string>();
  for (const row of rows) keys.add(sliceKey(row));
  return keys.size;
}

// ---------------------------------------------------------------------------
// Orchestrator: lookupMarketPrice
// ---------------------------------------------------------------------------

/**
 * Snapshot-row shape as it comes back from Supabase — snake_case and
 * lightly sanitized into the camelCase `MarketPriceSnapshot` used by
 * matchCascade.
 */
interface SnapshotRow {
  id: string;
  species: string;
  dimension: string | null;
  grade: string | null;
  region: string | null;
  unit: MarketSnapshotUnit;
  sample_date: string;
  company_count: number;
  sample_size: number;
  price_median: number | string;
  price_mean: number | string;
  price_low: number | string;
  price_high: number | string;
  price_spread: number | string;
  created_at: string;
}

function rowToSnapshot(row: SnapshotRow): MarketPriceSnapshot {
  return {
    id: row.id,
    species: row.species,
    dimension: row.dimension,
    grade: row.grade,
    region: row.region,
    unit: row.unit,
    sampleDate: row.sample_date,
    companyCount: row.company_count,
    sampleSize: row.sample_size,
    priceMedian: Number(row.price_median),
    priceMean: Number(row.price_mean),
    priceLow: Number(row.price_low),
    priceHigh: Number(row.price_high),
    priceSpread: Number(row.price_spread),
    createdAt: row.created_at,
  };
}

export async function lookupMarketPrice(
  query: LookupQuery,
): Promise<LookupResult> {
  const admin = getSupabaseAdmin();

  // Pull every candidate snapshot that might satisfy the cascade —
  // species + unit fixed, within staleness window. Dimension / grade /
  // region are left wide open so the cascade can pick the right one.
  const horizonIso = new Date(
    Date.now() - MAX_SNAPSHOT_AGE_DAYS * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);

  const { data, error } = await admin
    .from('market_price_snapshots')
    .select(
      'id, species, dimension, grade, region, unit, sample_date, company_count, sample_size, price_median, price_mean, price_low, price_high, price_spread, created_at',
    )
    .eq('species', query.species)
    .eq('unit', query.unit)
    .gte('sample_date', horizonIso)
    .order('sample_date', { ascending: false });

  if (error) {
    throw new Error(`lookupMarketPrice: query failed: ${error.message}`);
  }

  const snapshots = ((data ?? []) as SnapshotRow[]).map(rowToSnapshot);
  return matchCascade(snapshots, query);
}

// ---------------------------------------------------------------------------
// Orchestrator: generateBudgetQuote
// ---------------------------------------------------------------------------

export interface GenerateBudgetQuoteArgs {
  companyId: string;
  customerName: string;
  region?: string | null;
  lines: BudgetQuoteLineInput[];
  marginPct: number;
}

/**
 * End-to-end budget estimate: pulls the price candidates once per line,
 * runs the cascade, composes the BudgetQuote. Suitable as the handler
 * for POST /api/budget-quote (Step 5). Never called a "quote" in any
 * user-facing string — the product contract is that this output only
 * becomes a quote after a real vendor bids it.
 */
export async function generateBudgetQuote(
  args: GenerateBudgetQuoteArgs,
): Promise<BudgetQuote> {
  const region = args.region ?? null;

  // We could batch-load all species in one query; for today's volumes
  // (O(20) lines per estimate) the per-line lookup is simple and
  // exposes the cascade behavior directly.
  const lookups = new Map<string, LookupResult>();
  for (const line of args.lines) {
    const cacheKey = `${line.species}|${line.unit}`;
    if (lookups.has(cacheKey)) continue;
    const result = await lookupMarketPrice({
      species: line.species,
      dimension: line.dimension,
      grade: line.grade,
      region,
      unit: line.unit,
    });
    lookups.set(cacheKey, result);
  }

  // composeBudgetQuote expects a synchronous lookup fn. Build a closure
  // over the pre-fetched results. A species/unit combination maps to
  // the same snapshot candidate set, so this is safe.
  //
  // Re-run per-line so each line's (dimension, grade) combo walks the
  // cascade independently — two lines on the same species might price
  // at different levels.
  const snapshotsBySpeciesUnit = new Map<string, MarketPriceSnapshot[]>();
  for (const line of args.lines) {
    const cacheKey = `${line.species}|${line.unit}`;
    if (snapshotsBySpeciesUnit.has(cacheKey)) continue;
    const result = lookups.get(cacheKey);
    if (!result?.snapshot) {
      snapshotsBySpeciesUnit.set(cacheKey, []);
      continue;
    }
    // Pull the full candidate set so per-line cascade can re-match.
    const allForSpecies = await fetchCandidateSnapshots(line.species, line.unit);
    snapshotsBySpeciesUnit.set(cacheKey, allForSpecies);
  }

  return composeBudgetQuote(
    {
      companyId: args.companyId,
      customerName: args.customerName,
      region,
      lines: args.lines,
      marginPct: args.marginPct,
    },
    (q) =>
      matchCascade(
        snapshotsBySpeciesUnit.get(`${q.species}|${q.unit}`) ?? [],
        q,
      ),
  );
}

async function fetchCandidateSnapshots(
  species: string,
  unit: MarketSnapshotUnit,
): Promise<MarketPriceSnapshot[]> {
  const admin = getSupabaseAdmin();
  const horizonIso = new Date(
    Date.now() - MAX_SNAPSHOT_AGE_DAYS * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);

  const { data, error } = await admin
    .from('market_price_snapshots')
    .select(
      'id, species, dimension, grade, region, unit, sample_date, company_count, sample_size, price_median, price_mean, price_low, price_high, price_spread, created_at',
    )
    .eq('species', species)
    .eq('unit', unit)
    .gte('sample_date', horizonIso)
    .order('sample_date', { ascending: false });
  if (error) {
    throw new Error(
      `generateBudgetQuote: candidate fetch failed: ${error.message}`,
    );
  }
  return ((data ?? []) as SnapshotRow[]).map(rowToSnapshot);
}
