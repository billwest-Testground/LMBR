/**
 * GET /api/market — Current LMBR Cash Market Index.
 *
 * Purpose:  Dashboard ticker + card read. Returns the latest snapshot
 *           per unique (species, dimension, grade, region, unit) slice
 *           within the 30-day staleness window. Session-auth via the
 *           standard route-handler client; RLS on
 *           market_price_snapshots already allows any authenticated
 *           user to read (the Index is shared reference data).
 *
 *           Anonymization at the API boundary:
 *             The DB stores `company_count` per snapshot (how many
 *             distinct buyers contributed prices to that slice). We
 *             NEVER surface that exact number to clients — a caller
 *             could compare two slices and deduce tenant identities.
 *             Instead we derive `contributorNote` as one of three
 *             bucketed strings based on the MIN company_count across
 *             results (weakest-link rule):
 *                >= 10 → "Based on data from 10+ distributors"
 *                >=  5 → "Based on data from 5+ distributors"
 *                >=  3 → "Based on data from multiple distributors"
 *             The DB CHECK enforces >= 3 at write time so there's no
 *             "below 3" branch.
 *
 *           Empty-state: no snapshots in the window → 200 with the
 *           "Insufficient data" shape. Never 404 — the dashboard
 *           renders its own empty state off the snapshot array.
 *
 * Inputs:   Query params:
 *             region   optional — filter to one job region.
 *             species  optional — filter to one species.
 *             unit     optional — MBF / MSF / piece. Accepts upper or
 *                      lower case; matches the stored lowercase value.
 * Outputs:  200 {
 *             snapshots: MarketPriceSnapshot[],
 *             asOf: string | null,
 *             sliceCount: number,
 *             contributorNote: string,
 *             staleDays: number | null
 *           }.
 *           401 not authenticated.
 * Agent/API: market_price_snapshots read (RLS authenticated select).
 * Imports:  next/server, @lmbr/types, ../../../lib/supabase/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

import type {
  MarketPriceSnapshot,
  MarketSnapshotUnit,
} from '@lmbr/types';

import { getSupabaseRouteHandlerClient } from '../../../lib/supabase/server';

export const runtime = 'nodejs';

const MAX_WINDOW_DAYS = 30;

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
    // IMPORTANT: companyCount is in the domain model for server-side
    // math. Strip it before returning to clients — see response
    // construction below.
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

function sliceKey(s: MarketPriceSnapshot): string {
  return [
    s.species,
    s.dimension ?? '',
    s.grade ?? '',
    s.region ?? '',
    s.unit,
  ].join('|');
}

function narrowUnit(raw: string | null): MarketSnapshotUnit | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'mbf') return 'mbf';
  if (lower === 'msf') return 'msf';
  if (lower === 'piece' || lower === 'pcs') return 'piece';
  return null;
}

function contributorBucket(minCompanyCount: number | null): string {
  if (minCompanyCount === null) return 'Insufficient data';
  if (minCompanyCount >= 10) return 'Based on data from 10+ distributors';
  if (minCompanyCount >= 5) return 'Based on data from 5+ distributors';
  return 'Based on data from multiple distributors';
}

function windowStartIsoDate(): string {
  const d = new Date(Date.now() - MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function daysBetween(earlierIsoDate: string, laterIsoDate: string): number {
  const earlier = new Date(`${earlierIsoDate}T00:00:00Z`).getTime();
  const later = new Date(`${laterIsoDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(earlier) || !Number.isFinite(later)) return 0;
  return Math.max(0, Math.round((later - earlier) / (24 * 60 * 60 * 1000)));
}

/** Strip companyCount before returning to a client. */
type PublicSnapshot = Omit<MarketPriceSnapshot, 'companyCount'>;
function toPublic(s: MarketPriceSnapshot): PublicSnapshot {
  const { companyCount: _drop, ...rest } = s;
  void _drop;
  return rest;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const supabase = getSupabaseRouteHandlerClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const url = new URL(req.url);
    const regionFilter = url.searchParams.get('region');
    const speciesFilter = url.searchParams.get('species');
    const unitParam = url.searchParams.get('unit');
    const unitFilter = narrowUnit(unitParam);

    let query = supabase
      .from('market_price_snapshots')
      .select(
        'id, species, dimension, grade, region, unit, sample_date, company_count, sample_size, price_median, price_mean, price_low, price_high, price_spread, created_at',
      )
      .gte('sample_date', windowStartIsoDate())
      .order('sample_date', { ascending: false });
    if (regionFilter) query = query.eq('region', regionFilter);
    if (speciesFilter) query = query.eq('species', speciesFilter);
    if (unitFilter) query = query.eq('unit', unitFilter);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const snapshots = ((data ?? []) as SnapshotRow[]).map(rowToSnapshot);

    // Keep the most-recent snapshot per slice. Input is already sorted
    // by sample_date desc, so first-seen wins.
    const latestBySlice = new Map<string, MarketPriceSnapshot>();
    for (const s of snapshots) {
      const key = sliceKey(s);
      if (!latestBySlice.has(key)) latestBySlice.set(key, s);
    }
    const latest = Array.from(latestBySlice.values());

    if (latest.length === 0) {
      return NextResponse.json({
        snapshots: [],
        asOf: null,
        sliceCount: 0,
        contributorNote: 'Insufficient data',
        staleDays: null,
      });
    }

    // Anonymization bucket — weakest-link rule. The DB CHECK enforces
    // >= 3 so we don't need a "below floor" branch here.
    const minCompanyCount = latest.reduce(
      (min, s) => (s.companyCount < min ? s.companyCount : min),
      Number.POSITIVE_INFINITY,
    );
    const contributorNote = contributorBucket(
      Number.isFinite(minCompanyCount) ? minCompanyCount : null,
    );

    // asOf = most recent sample_date across returned slices.
    let asOf = latest[0]!.sampleDate;
    for (const s of latest) {
      if (s.sampleDate > asOf) asOf = s.sampleDate;
    }
    const today = new Date().toISOString().slice(0, 10);
    const staleDays = daysBetween(asOf, today);

    return NextResponse.json({
      snapshots: latest.map(toPublic),
      asOf,
      sliceCount: latest.length,
      contributorNote,
      staleDays,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Market read failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
