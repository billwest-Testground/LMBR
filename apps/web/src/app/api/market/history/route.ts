/**
 * GET /api/market/history — Cash Index time-series for sparklines.
 *
 * Purpose:  Dashboard sparkline + trend-chart data source. Returns one
 *           row per sample_date for a requested slice, ordered oldest
 *           first, capped at 90 days.
 *
 *           No contributor note / anonymization bucket here — every
 *           individual row already passed the 3-buyer DB CHECK at
 *           write time, and series data doesn't expose any field the
 *           Index endpoint doesn't. Returning price stats plus the
 *           date is safe.
 *
 *           Empty series is a valid response — if the requested slice
 *           has no snapshots in the window, return { series: [] }
 *           with the requested params echoed. Dashboard renders a
 *           "no history yet" state off the empty array, not off a 404.
 *
 * Inputs:   Query params:
 *             species    required.
 *             unit       required — MBF / MSF / piece.
 *             dimension  optional — filter to one dimension.
 *             grade      optional.
 *             region     optional.
 *             days       optional — default 30, max 90.
 * Outputs:  200 {
 *             series: Array<{ date, median, mean, low, high }>,
 *             species, dimension, grade, region, unit, days
 *           }.
 *           400 missing required field.
 *           401 not authenticated.
 * Agent/API: market_price_snapshots read (RLS authenticated select).
 * Imports:  next/server, @lmbr/types, ../../../../lib/supabase/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

import type { MarketSnapshotUnit } from '@lmbr/types';

import { getSupabaseRouteHandlerClient } from '../../../../lib/supabase/server';

export const runtime = 'nodejs';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

interface HistoryRow {
  sample_date: string;
  price_median: number | string;
  price_mean: number | string;
  price_low: number | string;
  price_high: number | string;
}

interface SeriesPoint {
  date: string;
  median: number;
  mean: number;
  low: number;
  high: number;
}

function narrowUnit(raw: string | null): MarketSnapshotUnit | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'mbf') return 'mbf';
  if (lower === 'msf') return 'msf';
  if (lower === 'piece' || lower === 'pcs') return 'piece';
  return null;
}

function parseDays(raw: string | null): number {
  if (!raw) return DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.floor(n));
}

function windowStartIsoDate(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
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
    const species = url.searchParams.get('species');
    const unit = narrowUnit(url.searchParams.get('unit'));
    const dimension = url.searchParams.get('dimension');
    const grade = url.searchParams.get('grade');
    const region = url.searchParams.get('region');
    const days = parseDays(url.searchParams.get('days'));

    if (!species || !unit) {
      return NextResponse.json(
        { error: 'species and unit are required query params' },
        { status: 400 },
      );
    }

    let query = supabase
      .from('market_price_snapshots')
      .select('sample_date, price_median, price_mean, price_low, price_high')
      .eq('species', species)
      .eq('unit', unit)
      .gte('sample_date', windowStartIsoDate(days))
      .order('sample_date', { ascending: true });
    if (dimension) query = query.eq('dimension', dimension);
    if (grade) query = query.eq('grade', grade);
    if (region) query = query.eq('region', region);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = (data ?? []) as HistoryRow[];
    const series: SeriesPoint[] = rows.map((r) => ({
      date: r.sample_date,
      median: Number(r.price_median),
      mean: Number(r.price_mean),
      low: Number(r.price_low),
      high: Number(r.price_high),
    }));

    return NextResponse.json({
      series,
      species,
      unit,
      dimension: dimension ?? null,
      grade: grade ?? null,
      region: region ?? null,
      days,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Market history read failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
