/**
 * GET /api/archive/search — Knowledge base query over past bids.
 *
 * Purpose:  The archive IS the knowledge base — every completed or
 *           archived bid is a data point. This route lets the search
 *           tab on /archive answer three concrete questions:
 *
 *             1. What did we pay for {species dimension grade} in
 *                {region} between {dates}? → the results[] array.
 *             2. Which vendors win the most? → aggregates.topVendors.
 *             3. What's typical margin / price range for this filter?
 *                → aggregates.avgMargin + aggregates.priceRange.
 *
 *           Base table: quote_line_items. Every row represents a
 *           priced line the tenant actually committed to (cost_price
 *           + margin_percent + sell_price), joined back through the
 *           quote to the bid for customer / region / status context
 *           and through vendor_bid_line_items to the vendor that
 *           won the line. Using quote_line_items (not
 *           vendor_bid_line_items) scopes the signal to "prices that
 *           moved through a real quote decision" — the tenant's
 *           actual transaction history, not every unselected vendor
 *           offer.
 *
 *           Completion / archive filter:
 *             quote.status != 'draft'  (past the trader's desk)
 *             OR bid.archived_at IS NOT NULL (archived)
 *           Applied client-side in TypeScript — PostgREST OR across
 *           joined tables is painful and this filter is cheap.
 *
 *           Session-auth. RLS on quote_line_items already scopes to
 *           the current tenant; no extra role gate — any authenticated
 *           user who can see quote_line_items can read the knowledge
 *           base their company built.
 *
 * Inputs:   Query params — all optional:
 *             species, dimension, grade   filter line_items.
 *             region                      bid.job_region exact match.
 *             customer, vendor            ilike contains match.
 *             fromDate, toDate            YYYY-MM-DD on bid.created_at.
 *             limit                       1-500, default 200.
 * Outputs:  200 {
 *             results: KnowledgeResult[],
 *             aggregates: {
 *               topVendors: [{vendorId, vendorName, winCount}],
 *               avgMarginPercent: number | null,
 *               priceRange: {low, median, high} | null,
 *               resultCount: number,
 *               uniqueQuotes: number
 *             }
 *           }.
 *           401 not authenticated.
 *           500 DB error.
 * Agent/API: Supabase session client.
 * Imports:  next/server, ../../../../lib/supabase/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getSupabaseRouteHandlerClient } from '../../../../lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const TOP_VENDORS = 10;

// ---------------------------------------------------------------------------
// Response types (exported so the client island imports the same shape)
// ---------------------------------------------------------------------------

export interface KnowledgeResult {
  lineId: string;
  quoteId: string;
  bidId: string;
  customerName: string;
  jobName: string | null;
  jobAddress: string | null;
  jobRegion: string | null;
  bidStatus: string;
  archivedAt: string | null;
  bidCreatedAt: string;
  quoteCreatedAt: string;
  species: string;
  dimension: string | null;
  grade: string | null;
  length: string | null;
  unit: string;
  quantity: number;
  costPrice: number;
  sellPrice: number;
  extendedSell: number;
  marginPercent: number;
  vendorId: string | null;
  vendorName: string | null;
}

export interface KnowledgeAggregates {
  topVendors: Array<{
    vendorId: string;
    vendorName: string;
    winCount: number;
  }>;
  avgMarginPercent: number | null;
  priceRange: { low: number; median: number; high: number } | null;
  resultCount: number;
  uniqueQuotes: number;
}

interface SearchResponse {
  results: KnowledgeResult[];
  aggregates: KnowledgeAggregates;
}

// ---------------------------------------------------------------------------
// Raw row shape (what PostgREST returns for the nested select)
// ---------------------------------------------------------------------------

interface RawRow {
  id: string;
  cost_price: number | string;
  sell_price: number | string;
  extended_sell: number | string;
  margin_percent: number | string;
  line_items: {
    species: string;
    dimension: string | null;
    grade: string | null;
    length: string | null;
    unit: string;
    quantity: number | string;
  } | null;
  quotes: {
    id: string;
    status: string;
    margin_percent: number | string;
    created_at: string;
    bids: {
      id: string;
      customer_name: string;
      job_name: string | null;
      job_address: string | null;
      job_region: string | null;
      status: string;
      archived_at: string | null;
      created_at: string;
    } | null;
  } | null;
  vendor_bid_line_items: {
    vendor_bids: {
      vendors: {
        id: string;
        name: string;
      } | null;
    } | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function toFiniteNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function median(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0
    ? (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2
    : sortedAsc[mid]!;
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(
  req: NextRequest,
): Promise<NextResponse<SearchResponse | { error: string }>> {
  try {
    const supabase = getSupabaseRouteHandlerClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const url = new URL(req.url);
    const species = url.searchParams.get('species')?.trim() ?? '';
    const dimension = url.searchParams.get('dimension')?.trim() ?? '';
    const grade = url.searchParams.get('grade')?.trim() ?? '';
    const region = url.searchParams.get('region')?.trim() ?? '';
    const customer = url.searchParams.get('customer')?.trim() ?? '';
    const vendor = url.searchParams.get('vendor')?.trim() ?? '';
    const fromDate = url.searchParams.get('fromDate')?.trim() ?? '';
    const toDate = url.searchParams.get('toDate')?.trim() ?? '';
    const limit = parseLimit(url.searchParams.get('limit'));

    // Nested select — quote_line_items is the base; the joined chain
    // reaches quotes → bids for the filter context, line_items for the
    // species slice, and vendor_bid_line_items → vendor_bids → vendors
    // for the vendor label. `!inner` on the mandatory edges so PostgREST
    // filters the row out when the join is empty.
    const selectSpec =
      'id, cost_price, sell_price, extended_sell, margin_percent,' +
      ' line_items!inner(species, dimension, grade, length, unit, quantity),' +
      ' quotes!inner(id, status, margin_percent, created_at,' +
      '   bids!inner(id, customer_name, job_name, job_address, job_region,' +
      '     status, archived_at, created_at)),' +
      ' vendor_bid_line_items(vendor_bids(vendors(id, name)))';

    let query = supabase
      .from('quote_line_items')
      .select(selectSpec)
      .order('created_at', { ascending: false, referencedTable: 'quotes' })
      .limit(limit);

    // Direct-column filters (line_items, quotes.bids).
    if (species) query = query.eq('line_items.species', species);
    if (dimension) query = query.eq('line_items.dimension', dimension);
    if (grade) query = query.eq('line_items.grade', grade);
    if (region) query = query.eq('quotes.bids.job_region', region);
    if (customer) {
      const safe = customer.slice(0, 120).replace(/[(),%]/g, ' ');
      query = query.ilike('quotes.bids.customer_name', `%${safe}%`);
    }
    if (fromDate) query = query.gte('quotes.bids.created_at', fromDate);
    if (toDate) query = query.lte('quotes.bids.created_at', toDate);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rawRows = (data ?? []) as unknown as RawRow[];

    // Client-side fan-out: completion/archive OR, vendor ilike,
    // shape translation. Keeping this in TS instead of cramming it
    // into PostgREST's .or() helper — the filter is cheap and the
    // code reads better.
    const vendorNeedle = vendor.toLowerCase();
    const results: KnowledgeResult[] = [];
    for (const row of rawRows) {
      const quote = row.quotes;
      const bid = quote?.bids;
      const li = row.line_items;
      if (!quote || !bid || !li) continue;

      // Completion / archive gate.
      const isPastDraft = quote.status !== 'draft';
      const isArchived = bid.archived_at !== null;
      if (!isPastDraft && !isArchived) continue;

      const vendorRow = row.vendor_bid_line_items?.vendor_bids?.vendors ?? null;
      if (vendorNeedle.length > 0) {
        if (!vendorRow) continue;
        if (!vendorRow.name.toLowerCase().includes(vendorNeedle)) continue;
      }

      results.push({
        lineId: row.id,
        quoteId: quote.id,
        bidId: bid.id,
        customerName: bid.customer_name,
        jobName: bid.job_name,
        jobAddress: bid.job_address,
        jobRegion: bid.job_region,
        bidStatus: bid.status,
        archivedAt: bid.archived_at,
        bidCreatedAt: bid.created_at,
        quoteCreatedAt: quote.created_at,
        species: li.species,
        dimension: li.dimension,
        grade: li.grade,
        length: li.length,
        unit: li.unit,
        quantity: toFiniteNumber(li.quantity),
        costPrice: toFiniteNumber(row.cost_price),
        sellPrice: toFiniteNumber(row.sell_price),
        extendedSell: toFiniteNumber(row.extended_sell),
        marginPercent: toFiniteNumber(row.margin_percent),
        vendorId: vendorRow?.id ?? null,
        vendorName: vendorRow?.name ?? null,
      });
    }

    const aggregates = computeAggregates(results);

    return NextResponse.json({ results, aggregates });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Knowledge search failed';
    console.warn(`LMBR.ai knowledge-search: ${message}.`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

function computeAggregates(results: KnowledgeResult[]): KnowledgeAggregates {
  if (results.length === 0) {
    return {
      topVendors: [],
      avgMarginPercent: null,
      priceRange: null,
      resultCount: 0,
      uniqueQuotes: 0,
    };
  }

  // Top vendors by win count — count the number of lines a vendor
  // produced. A "win" is a quote_line_item; ties are counted per
  // unique line, so one quote with ten lines from one vendor
  // contributes ten wins. Adequate for the "who shows up most" read.
  const vendorCounts = new Map<
    string,
    { vendorId: string; vendorName: string; winCount: number }
  >();
  for (const r of results) {
    if (!r.vendorId || !r.vendorName) continue;
    const existing = vendorCounts.get(r.vendorId);
    if (existing) {
      existing.winCount += 1;
    } else {
      vendorCounts.set(r.vendorId, {
        vendorId: r.vendorId,
        vendorName: r.vendorName,
        winCount: 1,
      });
    }
  }
  const topVendors = Array.from(vendorCounts.values())
    .sort((a, b) => {
      if (b.winCount !== a.winCount) return b.winCount - a.winCount;
      return a.vendorName.localeCompare(b.vendorName);
    })
    .slice(0, TOP_VENDORS);

  // Average margin — one entry per distinct quote (the margin is a
  // quote-level property; averaging per-line would double-count big
  // quotes). Pull margin_percent from the result row's line — it's
  // already the line's computed margin, which for budget-quote-style
  // uniform margins matches the quote's overall margin. Use the
  // median of per-quote line-level margins for robustness against
  // outlier lines.
  const marginsByQuote = new Map<string, number[]>();
  for (const r of results) {
    const arr = marginsByQuote.get(r.quoteId) ?? [];
    arr.push(r.marginPercent);
    marginsByQuote.set(r.quoteId, arr);
  }
  const perQuoteMedians: number[] = [];
  for (const arr of Array.from(marginsByQuote.values())) {
    const sorted = [...arr].sort((a, b) => a - b);
    perQuoteMedians.push(median(sorted));
  }
  const avgMarginPercent =
    perQuoteMedians.length > 0
      ? perQuoteMedians.reduce((s, n) => s + n, 0) / perQuoteMedians.length
      : null;

  // Price range over cost_price — what we actually paid. Using
  // cost_price (not sell_price) because the knowledge base answers
  // "what did we pay", not "what did we charge".
  const prices = results
    .map((r) => r.costPrice)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const priceRange = prices.length
    ? {
        low: prices[0]!,
        median: median(prices),
        high: prices[prices.length - 1]!,
      }
    : null;

  return {
    topVendors,
    avgMarginPercent,
    priceRange,
    resultCount: results.length,
    uniqueQuotes: marginsByQuote.size,
  };
}
