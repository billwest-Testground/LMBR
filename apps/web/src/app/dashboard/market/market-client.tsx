/**
 * MarketClient — client island for /dashboard/market.
 *
 * Purpose:  Renders every surface of the market intelligence dashboard:
 *             - Page header + contributor note + as-of + stale banner
 *             - Filter bar (species / region / unit)
 *             - Price cards grid with lazy-loaded per-card sparklines
 *             - Empty state when the platform has no data yet
 *             - Collapsible budget-estimate panel (role-gated by the
 *               server at /api/market/budget-quote, not here)
 *
 *           Fetches GET /api/market once on mount; filters are applied
 *           client-side over the already-fetched snapshots so switching
 *           a dropdown doesn't round-trip. Sparkline history is fetched
 *           per-card and cached in a ref Map keyed by
 *           species|dimension|grade|unit so toggling filters back and
 *           forth doesn't re-fetch the same slice.
 *
 *           Anonymization contract: the API response already strips
 *           companyCount — we only ever see the bucketed contributor
 *           note string. Never surface exact counts.
 *
 *           Terminology: the budget panel UI says "Budget estimate" or
 *           "Market-rate estimate" every time. Never "quote". Warning
 *           banner is always visible when results render — product rule
 *           (see CLAUDE.md Market Intelligence section).
 *
 * Inputs:   none (loads data via fetch on mount).
 * Outputs:  JSX.
 * Agent/API: GET /api/market
 *            GET /api/market/history
 *            POST /api/market/budget-quote
 *            Supabase browser client for the bid selector list.
 * Imports:  react, recharts, lucide-react, ../../../components/ui/button,
 *           ../../../lib/supabase/browser, ../../../lib/cn.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { Line, LineChart } from 'recharts';
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  LineChart as LineChartIcon,
  TrendingUp,
} from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/cn';
import { getSupabaseBrowserClient } from '../../../lib/supabase/browser';

// ---------------------------------------------------------------------------
// Types (mirrors the /api/market public response — companyCount stripped)
// ---------------------------------------------------------------------------

type SnapshotUnit = 'mbf' | 'msf' | 'piece';

interface PublicSnapshot {
  id: string;
  species: string;
  dimension: string | null;
  grade: string | null;
  region: string | null;
  unit: SnapshotUnit;
  sampleDate: string;
  sampleSize: number;
  priceMedian: number;
  priceMean: number;
  priceLow: number;
  priceHigh: number;
  priceSpread: number;
  createdAt: string;
}

interface MarketResponse {
  snapshots: PublicSnapshot[];
  asOf: string | null;
  sliceCount: number;
  contributorNote: string;
  staleDays: number | null;
}

interface HistoryPoint {
  date: string;
  median: number;
  mean: number;
  low: number;
  high: number;
}

interface HistoryResponse {
  series: HistoryPoint[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPECIES_OPTIONS = [
  'All',
  'SPF',
  'DF',
  'HF',
  'SYP',
  'Cedar',
  'LVL',
  'OSB',
  'Plywood',
  'Treated',
] as const;

const REGION_OPTIONS = [
  { label: 'All regions', value: 'all' },
  { label: 'Pacific Northwest', value: 'pnw' },
  { label: 'California', value: 'california' },
  { label: 'Mountain West', value: 'mountain' },
  { label: 'Southwest', value: 'southwest' },
  { label: 'Midwest', value: 'midwest' },
  { label: 'Southeast', value: 'southeast' },
  { label: 'Northeast', value: 'northeast' },
  { label: 'West', value: 'west' },
  { label: 'South', value: 'south' },
];

const UNIT_OPTIONS: Array<{ label: string; value: SnapshotUnit }> = [
  { label: 'MBF', value: 'mbf' },
  { label: 'MSF', value: 'msf' },
];

const ACCENT_STROKE = '#1DB87A';
const STALE_DAYS_WARN = 7;

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const USD_2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MarketClient() {
  const [state, setState] = React.useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; data: MarketResponse }
  >({ kind: 'loading' });

  const [speciesFilter, setSpeciesFilter] = React.useState<string>('All');
  const [regionFilter, setRegionFilter] = React.useState<string>('all');
  const [unitFilter, setUnitFilter] = React.useState<SnapshotUnit>('mbf');

  // History cache shared across every card. Not state — never triggers
  // re-renders; each card reads the entry it owns after an async
  // populate via setSparklineVersion.
  const historyCache = React.useRef<
    Map<string, HistoryPoint[] | 'loading' | 'empty'>
  >(new Map());

  // Counter bumped whenever a sparkline lands — forces cards to
  // re-render against the freshly-populated cache without putting the
  // Map itself into state (which would GC badly across filter changes).
  const [sparklineVersion, setSparklineVersion] = React.useState(0);

  React.useEffect(() => {
    void reload();
  }, []);

  async function reload(): Promise<void> {
    try {
      const res = await fetch('/api/market', { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setState({
          kind: 'error',
          message: body.error ?? `Status ${res.status}`,
        });
        return;
      }
      const data = (await res.json()) as MarketResponse;
      setState({ kind: 'ready', data });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Market load failed',
      });
    }
  }

  if (state.kind === 'loading') return <LoadingShell />;
  if (state.kind === 'error')
    return <ErrorShell message={state.message} onRetry={() => void reload()} />;

  const { data } = state;
  const filtered = applyFilters(data.snapshots, {
    species: speciesFilter,
    region: regionFilter,
    unit: unitFilter,
  });

  return (
    <div className="flex flex-col gap-6">
      <Header data={data} />
      <FilterBar
        species={speciesFilter}
        region={regionFilter}
        unit={unitFilter}
        onSpecies={setSpeciesFilter}
        onRegion={setRegionFilter}
        onUnit={setUnitFilter}
      />

      {data.snapshots.length === 0 ? (
        <EmptyState />
      ) : filtered.length === 0 ? (
        <FilteredEmptyState />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((snapshot) => (
            <PriceCard
              key={snapshot.id}
              snapshot={snapshot}
              historyCache={historyCache}
              version={sparklineVersion}
              onHistoryLoaded={() => setSparklineVersion((v) => v + 1)}
            />
          ))}
        </div>
      )}

      <BudgetEstimatePanel />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({ data }: { data: MarketResponse }) {
  const stale = data.staleDays !== null && data.staleDays > STALE_DAYS_WARN;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-h1 text-text-primary">Market intelligence</h1>
          <p className="mt-1 text-body text-text-secondary">
            {data.contributorNote}
          </p>
        </div>
        {data.asOf ? (
          <div className="rounded-sm border border-border-subtle bg-bg-surface px-3 py-1.5 text-right">
            <div className="text-label uppercase text-text-tertiary">
              Last updated
            </div>
            <div className="mt-0.5 text-body-sm text-text-primary">
              {formatAbsoluteDate(data.asOf)}
            </div>
          </div>
        ) : null}
      </div>
      {stale && data.staleDays !== null ? (
        <div className="flex items-start gap-2 rounded-sm border border-[rgba(232,172,72,0.3)] bg-[rgba(232,172,72,0.08)] px-3 py-2 text-body-sm text-semantic-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
          <span>
            Market data is {data.staleDays} {data.staleDays === 1 ? 'day' : 'days'} old —
            run aggregation to refresh.
          </span>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function FilterBar({
  species,
  region,
  unit,
  onSpecies,
  onRegion,
  onUnit,
}: {
  species: string;
  region: string;
  unit: SnapshotUnit;
  onSpecies: (next: string) => void;
  onRegion: (next: string) => void;
  onUnit: (next: SnapshotUnit) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border border-border-subtle bg-bg-surface p-3">
      <FilterSelect
        label="Species"
        value={species}
        onChange={onSpecies}
        options={SPECIES_OPTIONS.map((s) => ({ label: s, value: s }))}
      />
      <FilterSelect
        label="Region"
        value={region}
        onChange={onRegion}
        options={REGION_OPTIONS}
      />
      <div className="flex flex-col gap-1">
        <span className="text-label uppercase text-text-tertiary">Unit</span>
        <div className="inline-flex overflow-hidden rounded-sm border border-border-strong">
          {UNIT_OPTIONS.map((opt) => {
            const active = unit === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onUnit(opt.value)}
                className={cn(
                  'px-3 py-1.5 text-body-sm transition-colors duration-micro',
                  active
                    ? 'bg-accent-primary text-text-inverse'
                    : 'bg-transparent text-text-secondary hover:bg-bg-elevated hover:text-text-primary',
                )}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: Array<{ label: string; value: string }>;
}) {
  return (
    <label className="flex flex-col gap-1 text-body-sm">
      <span className="text-label uppercase text-text-tertiary">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'rounded-sm border border-border-strong bg-bg-input px-2 py-1.5 text-body text-text-primary',
          'focus-visible:outline-none focus-visible:shadow-accent',
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Price card (with lazy sparkline)
// ---------------------------------------------------------------------------

interface PriceCardProps {
  snapshot: PublicSnapshot;
  historyCache: React.MutableRefObject<
    Map<string, HistoryPoint[] | 'loading' | 'empty'>
  >;
  version: number;
  onHistoryLoaded: () => void;
}

function PriceCard({
  snapshot,
  historyCache,
  version,
  onHistoryLoaded,
}: PriceCardProps) {
  void version; // dependency marker so the card re-renders on cache fill
  const cacheKey = React.useMemo(
    () =>
      [
        snapshot.species,
        snapshot.dimension ?? '',
        snapshot.grade ?? '',
        snapshot.unit,
      ].join('|'),
    [snapshot],
  );

  React.useEffect(() => {
    const cache = historyCache.current;
    if (cache.has(cacheKey)) return;
    cache.set(cacheKey, 'loading');

    async function load() {
      try {
        const params = new URLSearchParams({
          species: snapshot.species,
          unit: snapshot.unit,
        });
        if (snapshot.dimension) params.set('dimension', snapshot.dimension);
        if (snapshot.grade) params.set('grade', snapshot.grade);
        const res = await fetch(`/api/market/history?${params.toString()}`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          historyCache.current.set(cacheKey, 'empty');
          onHistoryLoaded();
          return;
        }
        const body = (await res.json()) as HistoryResponse;
        historyCache.current.set(
          cacheKey,
          body.series.length > 0 ? body.series : 'empty',
        );
        onHistoryLoaded();
      } catch {
        historyCache.current.set(cacheKey, 'empty');
        onHistoryLoaded();
      }
    }
    void load();
  }, [cacheKey, historyCache, onHistoryLoaded, snapshot]);

  const entry = historyCache.current.get(cacheKey);
  const series = Array.isArray(entry) ? entry : null;
  const trend = computeTrend(series);

  const description = [snapshot.dimension, snapshot.grade]
    .filter((v): v is string => Boolean(v))
    .join(' · ');

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-base bg-bg-surface p-4 shadow-sm transition-shadow duration-micro hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-label uppercase text-text-tertiary">
            {snapshot.species}
          </div>
          <div className="mt-0.5 truncate text-body-sm text-text-secondary">
            {description || 'Any dimension · any grade'}
          </div>
        </div>
        <span
          className="inline-flex items-center rounded-[4px] border border-border-subtle bg-bg-subtle px-1.5 py-0.5 text-label uppercase text-text-tertiary"
          title={snapshot.region ?? 'All regions'}
        >
          {snapshot.region ?? 'all'}
        </span>
      </div>

      <div className="flex items-end gap-2">
        <div className="font-mono text-[24px] font-semibold leading-none tabular-nums text-text-primary">
          {USD.format(snapshot.priceMedian)}
        </div>
        <div className="pb-1 text-label uppercase text-text-tertiary">
          / {snapshot.unit.toUpperCase()}
        </div>
      </div>

      <div className="mt-1 flex items-end justify-between gap-3">
        <div className="h-[24px] w-[48px]">
          {series && series.length >= 2 ? (
            <LineChart width={48} height={24} data={series}>
              <Line
                type="monotone"
                dataKey="median"
                stroke={ACCENT_STROKE}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          ) : (
            <div
              className="h-full w-full rounded-[2px] bg-bg-subtle"
              aria-hidden="true"
            />
          )}
        </div>

        <TrendBadge trend={trend} />
      </div>

      <div className="mt-1 flex items-baseline justify-between text-label uppercase text-text-tertiary">
        <span>{`low ${USD.format(snapshot.priceLow)}`}</span>
        <span>{`high ${USD.format(snapshot.priceHigh)}`}</span>
      </div>
    </div>
  );
}

interface Trend {
  direction: 'up' | 'down' | 'flat';
  pct: number | null;
}

function computeTrend(series: HistoryPoint[] | null): Trend {
  if (!series || series.length < 2) return { direction: 'flat', pct: null };
  const first = series[0]!.median;
  const last = series[series.length - 1]!.median;
  if (first === 0) return { direction: 'flat', pct: null };
  const pct = ((last - first) / first) * 100;
  if (Math.abs(pct) < 0.5) return { direction: 'flat', pct };
  return { direction: pct > 0 ? 'up' : 'down', pct };
}

function TrendBadge({ trend }: { trend: Trend }) {
  if (trend.pct === null) {
    return (
      <span className="inline-flex items-center gap-1 text-label uppercase text-text-tertiary">
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        —
      </span>
    );
  }
  if (trend.direction === 'up') {
    return (
      <span className="inline-flex items-center gap-1 text-label uppercase text-accent-warm">
        <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
        {trend.pct.toFixed(1)}%
      </span>
    );
  }
  if (trend.direction === 'down') {
    return (
      <span className="inline-flex items-center gap-1 text-label uppercase text-semantic-error">
        <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
        {Math.abs(trend.pct).toFixed(1)}%
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-label uppercase text-text-tertiary">
      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      {trend.pct.toFixed(1)}%
    </span>
  );
}

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-3 rounded-md border border-border-base bg-bg-surface px-6 py-12 text-center shadow-sm">
      <LineChartIcon
        className="h-12 w-12 text-text-tertiary"
        aria-hidden="true"
      />
      <h2 className="text-h3 text-text-secondary">Market data is building</h2>
      <p className="max-w-md text-body-sm text-text-tertiary">
        Pricing intelligence grows as your team processes bids. Data appears
        here once enough transactions have been recorded across multiple
        distributors.
      </p>
    </div>
  );
}

function FilteredEmptyState() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-3 rounded-md border border-border-base bg-bg-surface px-6 py-10 text-center shadow-sm">
      <TrendingUp className="h-10 w-10 text-text-tertiary" aria-hidden="true" />
      <h2 className="text-h3 text-text-secondary">
        No slices match the current filters
      </h2>
      <p className="max-w-md text-body-sm text-text-tertiary">
        Try a broader region or a different unit. The full Index may still
        have coverage elsewhere.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Budget estimate panel
// ---------------------------------------------------------------------------

interface BidOption {
  id: string;
  customer_name: string | null;
  job_name: string | null;
  created_at: string;
}

interface BudgetResponseLine {
  commodityId: string;
  quantity: number;
  boardFeet?: number;
  marketUnitPrice: number;
  marginPct: number;
  extendedSellPrice: number;
  companyCount: number | null;
  fallbackLevel: 'exact' | 'region_any' | 'grade_any';
}

interface BudgetResponseUnpriced {
  commodityId: string;
  reason: 'insufficient_data' | 'unknown_commodity';
}

interface BudgetQuoteResponse {
  bidId: string;
  budget: {
    id: string;
    companyId: string;
    customerName: string;
    region?: string;
    lines: BudgetResponseLine[];
    totalSellPrice: number;
    generatedAt: string;
    unpricedLines: BudgetResponseUnpriced[];
  };
  generatedAt: string;
  warning: string;
  skippedLineItemIds?: string[];
}

function BudgetEstimatePanel() {
  const [open, setOpen] = React.useState(false);
  const [bids, setBids] = React.useState<BidOption[] | 'loading' | 'error'>(
    'loading',
  );
  const [selectedBidId, setSelectedBidId] = React.useState<string>('');
  const [marginInput, setMarginInput] = React.useState<string>('10');
  const [submitting, setSubmitting] = React.useState(false);
  const [result, setResult] = React.useState<BudgetQuoteResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    if (bids !== 'loading') return;
    void loadBids();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function loadBids(): Promise<void> {
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error: queryError } = await supabase
        .from('bids')
        .select('id, customer_name, job_name, created_at, status')
        // archived_at IS NULL is the single source of truth for "active"
        // bids — migration 027. Legacy status='archived' is dormant.
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(50);
      if (queryError) {
        setBids('error');
        return;
      }
      const rows = (data ?? []).map((row) => ({
        id: row.id as string,
        customer_name: (row.customer_name as string | null) ?? null,
        job_name: (row.job_name as string | null) ?? null,
        created_at: row.created_at as string,
      }));
      setBids(rows);
      if (rows.length > 0 && !selectedBidId) setSelectedBidId(rows[0]!.id);
    } catch {
      setBids('error');
    }
  }

  async function generate() {
    if (!selectedBidId) return;
    const marginPct = parseMarginPct(marginInput);
    if (marginPct === null) {
      setError('Margin must be a finite number (e.g. 10 for 10%).');
      return;
    }
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/market/budget-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bidId: selectedBidId, marginPct }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<
        BudgetQuoteResponse & { error?: string }
      >;
      if (!res.ok) {
        setError(body.error ?? `Request failed (${res.status}).`);
        return;
      }
      setResult(body as BudgetQuoteResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Budget estimate failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-md border border-border-base bg-bg-surface shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-5 py-4 text-left"
      >
        <div>
          <h2 className="text-h3 text-text-primary">Generate budget estimate</h2>
          <p className="mt-0.5 text-body-sm text-text-secondary">
            Market-rate ballpark from the Cash Index — never a vendor quote.
          </p>
        </div>
        {open ? (
          <ChevronUp className="h-5 w-5 text-text-tertiary" aria-hidden="true" />
        ) : (
          <ChevronDown
            className="h-5 w-5 text-text-tertiary"
            aria-hidden="true"
          />
        )}
      </button>

      {open ? (
        <div className="flex flex-col gap-4 border-t border-border-subtle p-5">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-[280px] flex-1 flex-col gap-1">
              <span className="text-label uppercase text-text-tertiary">Bid</span>
              <select
                value={selectedBidId}
                onChange={(e) => setSelectedBidId(e.target.value)}
                disabled={!Array.isArray(bids)}
                className={cn(
                  'rounded-sm border border-border-strong bg-bg-input px-2 py-1.5 text-body text-text-primary',
                  'focus-visible:outline-none focus-visible:shadow-accent',
                  'disabled:opacity-60',
                )}
              >
                {bids === 'loading' ? (
                  <option>Loading bids…</option>
                ) : bids === 'error' ? (
                  <option>Could not load bids</option>
                ) : bids.length === 0 ? (
                  <option value="">No active bids yet</option>
                ) : (
                  bids.map((b) => (
                    <option key={b.id} value={b.id}>
                      {formatBidLabel(b)}
                    </option>
                  ))
                )}
              </select>
            </label>

            <label className="flex w-[120px] flex-col gap-1">
              <span className="text-label uppercase text-text-tertiary">
                Margin %
              </span>
              <input
                type="number"
                min="-100"
                max="200"
                step="0.5"
                value={marginInput}
                onChange={(e) => setMarginInput(e.target.value)}
                className={cn(
                  'rounded-sm border border-border-strong bg-bg-input px-2 py-1.5 text-body text-text-primary',
                  'focus-visible:outline-none focus-visible:shadow-accent',
                )}
              />
            </label>

            <Button
              variant="primary"
              onClick={() => void generate()}
              loading={submitting}
              disabled={
                submitting ||
                !selectedBidId ||
                !(Array.isArray(bids) && bids.length > 0)
              }
            >
              Generate estimate
            </Button>
          </div>

          {error ? (
            <p className="text-body-sm text-semantic-error">{error}</p>
          ) : null}

          {result ? <BudgetResult result={result} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function BudgetResult({ result }: { result: BudgetQuoteResponse }) {
  const { budget, warning } = result;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-sm border border-[rgba(232,172,72,0.3)] bg-[rgba(232,172,72,0.08)] px-3 py-2 text-body-sm text-semantic-warning">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
        <span>{warning}</span>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3 rounded-sm border border-border-subtle bg-bg-subtle p-3">
        <div>
          <div className="text-label uppercase text-text-tertiary">
            Estimated total
          </div>
          <div className="mt-1 font-mono text-[28px] font-semibold leading-none tabular-nums text-text-primary">
            {USD_2.format(budget.totalSellPrice)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-label uppercase text-text-tertiary">
            Priced lines
          </div>
          <div className="mt-1 text-body-sm text-text-secondary">
            {budget.lines.length} of {budget.lines.length + budget.unpricedLines.length}
          </div>
        </div>
      </div>

      {budget.lines.length > 0 ? (
        <div className="overflow-hidden rounded-sm border border-border-subtle">
          <table className="w-full border-separate border-spacing-0 text-body-sm">
            <thead className="bg-bg-surface">
              <tr>
                <Th>Line</Th>
                <Th align="right">Qty</Th>
                <Th align="right">Market rate</Th>
                <Th>Confidence</Th>
                <Th align="right">Extended</Th>
              </tr>
            </thead>
            <tbody>
              {budget.lines.map((line) => (
                <tr key={line.commodityId}>
                  <Td className="font-mono text-text-tertiary">
                    {line.commodityId.slice(0, 8)}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {line.quantity}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {USD_2.format(line.marketUnitPrice)}
                  </Td>
                  <Td>
                    <FallbackBadge level={line.fallbackLevel} />
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {USD_2.format(line.extendedSellPrice)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {budget.unpricedLines.length > 0 ? (
        <div className="rounded-sm border border-border-subtle bg-bg-subtle p-3">
          <div className="text-label uppercase text-text-tertiary">
            No market data ({budget.unpricedLines.length})
          </div>
          <ul className="mt-2 flex flex-col gap-1">
            {budget.unpricedLines.map((u) => (
              <li
                key={u.commodityId}
                className="flex items-center justify-between gap-3 text-body-sm"
              >
                <span className="font-mono text-text-tertiary">
                  {u.commodityId.slice(0, 8)}
                </span>
                <span className="inline-flex items-center rounded-[4px] border border-[rgba(232,172,72,0.3)] bg-[rgba(232,172,72,0.08)] px-1.5 py-0.5 text-label uppercase text-semantic-warning">
                  No market data
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function FallbackBadge({
  level,
}: {
  level: 'exact' | 'region_any' | 'grade_any';
}) {
  const label =
    level === 'exact'
      ? 'Exact match'
      : level === 'region_any'
        ? 'Any region'
        : 'Any grade';
  const tone =
    level === 'exact'
      ? 'border-[rgba(29,184,122,0.3)] bg-[rgba(29,184,122,0.08)] text-semantic-success'
      : level === 'region_any'
        ? 'border-border-subtle bg-bg-subtle text-text-secondary'
        : 'border-[rgba(232,172,72,0.3)] bg-[rgba(232,172,72,0.08)] text-semantic-warning';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[4px] border px-1.5 py-0.5 text-label uppercase',
        tone,
      )}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Small table primitives (duplicated from dashboard/manager — fine for V1)
// ---------------------------------------------------------------------------

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={cn(
        'border-b border-border-subtle px-3 py-2 text-label uppercase text-text-tertiary',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
  className,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <td
      className={cn(
        'border-b border-border-subtle px-3 py-2 text-text-primary',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </td>
  );
}

// ---------------------------------------------------------------------------
// Shells
// ---------------------------------------------------------------------------

function LoadingShell() {
  return (
    <div className="rounded-md border border-border-base bg-bg-surface p-6 shadow-sm">
      <p className="text-body text-text-secondary">Loading market data…</p>
    </div>
  );
}

function ErrorShell({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-md border border-border-base bg-bg-surface p-6 shadow-sm">
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="h-6 w-6 flex-none text-semantic-error"
          aria-hidden="true"
        />
        <div className="flex-1">
          <h2 className="text-h3 text-text-primary">Could not load market data</h2>
          <p className="mt-1 text-body-sm text-text-secondary">{message}</p>
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter + formatting helpers
// ---------------------------------------------------------------------------

function applyFilters(
  snapshots: PublicSnapshot[],
  filters: { species: string; region: string; unit: SnapshotUnit },
): PublicSnapshot[] {
  return snapshots.filter((s) => {
    if (filters.species !== 'All' && s.species !== filters.species) return false;
    if (filters.region !== 'all') {
      const snapRegion = s.region ?? 'all';
      if (snapRegion !== filters.region) return false;
    }
    if (s.unit !== filters.unit) return false;
    return true;
  });
}

function formatAbsoluteDate(iso: string): string {
  // ISO can be YYYY-MM-DD or full datetime — both parse correctly.
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

function formatBidLabel(b: BidOption): string {
  const customer = b.customer_name ?? 'Unknown customer';
  const job = b.job_name ? ` — ${b.job_name}` : '';
  return `${customer}${job}`;
}

function parseMarginPct(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // UI shows "10" meaning 10%; translate to 0.10 for the API.
  return n / 100;
}
