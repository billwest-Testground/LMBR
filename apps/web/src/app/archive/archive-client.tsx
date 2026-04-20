/**
 * ArchiveClient — /archive page client island.
 *
 * Purpose:  Two tabs behind one URL, one sidebar nav item:
 *             - Archived Bids — table of archived bids + client-side
 *               filters (search text, date range, "bid multiple times"
 *               toggle) + reactivation modal (continue / fresh).
 *             - Search — knowledge base entry point. Placeholder in
 *               this step; Step 5 fills it in.
 *
 *           Tab state is URL-driven via `?tab=archived|search` so
 *           deep links and browser back/forward work. The tab write
 *           uses `window.history.replaceState` (not router.replace)
 *           so typedRoutes doesn't reject the untyped string target.
 *
 *           Data loading: single GET /api/archive on mount for Tab 1.
 *           Filters apply client-side over the already-fetched array,
 *           matching the market dashboard pattern. Reactivation hits
 *           POST /api/bids/[bidId]/reactivate and optimistically
 *           removes the row on success.
 *
 *           Design system: cards on bg-surface, teal accent, uppercase
 *           label text, mono tabular nums on numeric columns. Mirrors
 *           the manager dashboard + integrations page patterns.
 *
 * Inputs:   none (fetches on mount, filters in-memory).
 * Outputs:  JSX.
 * Agent/API: GET /api/archive
 *            POST /api/bids/[bidId]/reactivate
 * Imports:  react, next/navigation, next/link, lucide-react, Button,
 *           cn.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  Archive as ArchiveIcon,
  HelpCircle,
  Search,
  X,
} from 'lucide-react';

import { Button } from '../../components/ui/button';
import { StatusBadge, type BidStatus } from '../../components/bids/status-badge';
import { cn } from '../../lib/cn';

// ---------------------------------------------------------------------------
// Types mirroring GET /api/archive response
// ---------------------------------------------------------------------------

interface ArchiveBid {
  id: string;
  jobName: string | null;
  customerName: string;
  jobAddress: string | null;
  status: string;
  archivedAt: string;
  archivedByUserId: string | null;
  archivedByDisplayName: string | null;
  totalBoardFeet: number;
  repeatCount: number;
}

interface ArchiveResponse {
  bids: ArchiveBid[];
  total: number;
}

type TabKey = 'archived' | 'search';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ArchiveClient() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [tab, setTab] = React.useState<TabKey>(
    tabParam === 'search' ? 'search' : 'archived',
  );

  React.useEffect(() => {
    // Keep the URL in sync without triggering typedRoutes (router.replace
    // rejects arbitrary strings under typedRoutes). replaceState avoids
    // a re-render and a history entry.
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (tab === 'archived') {
      url.searchParams.delete('tab');
    } else {
      url.searchParams.set('tab', tab);
    }
    window.history.replaceState({}, '', url.pathname + url.search);
  }, [tab]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-h1 text-text-primary">Archive</h1>
        <p className="mt-1 text-body text-text-secondary">
          Bids removed from your active pipeline. Reactivate at any time.
        </p>
      </header>

      <TabBar current={tab} onChange={setTab} />

      {tab === 'archived' ? <ArchivedBidsTab /> : <SearchTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

function TabBar({
  current,
  onChange,
}: {
  current: TabKey;
  onChange: (next: TabKey) => void;
}) {
  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'archived', label: 'Archived bids' },
    { key: 'search', label: 'Search' },
  ];
  return (
    <div className="flex gap-1 border-b border-border-subtle">
      {tabs.map((t) => {
        const active = current === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={cn(
              'relative px-4 py-2 text-body-sm transition-colors duration-micro',
              active
                ? 'text-text-primary'
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {t.label}
            {active ? (
              <span
                aria-hidden="true"
                className="absolute inset-x-2 bottom-[-1px] h-[2px] bg-accent-primary"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 1 — Archived bids
// ---------------------------------------------------------------------------

function ArchivedBidsTab() {
  const [state, setState] = React.useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; data: ArchiveResponse }
  >({ kind: 'loading' });

  // Client-side filters — the fetched data is the full archived set
  // for the tenant; all filtering happens in-memory to match the
  // market dashboard's responsive feel.
  const [searchText, setSearchText] = React.useState('');
  const [fromDate, setFromDate] = React.useState('');
  const [toDate, setToDate] = React.useState('');
  // "Repeated jobs only" toggle — shows rows whose (customer, address)
  // pair appears more than once in the archive. `repeatCount` is already
  // populated per row from GET /api/archive (counted server-side over
  // the response set), so the filter is pure client-side.
  const [repeatsOnly, setRepeatsOnly] = React.useState(false);

  // Reactivation modal state — one modal shared across rows.
  const [modal, setModal] = React.useState<ArchiveBid | null>(null);

  // Per-row status after reactivation. Rows optimistically removed.
  const [removedIds, setRemovedIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [toast, setToast] = React.useState<string | null>(null);

  React.useEffect(() => {
    void reload();
  }, []);

  async function reload(): Promise<void> {
    try {
      const res = await fetch('/api/archive', { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setState({
          kind: 'error',
          message: body.error ?? `Archive request failed (${res.status}).`,
        });
        return;
      }
      const data = (await res.json()) as ArchiveResponse;
      setState({ kind: 'ready', data });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Archive load failed.',
      });
    }
  }

  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  if (state.kind === 'loading') return <LoadingShell />;
  if (state.kind === 'error')
    return <ErrorShell message={state.message} onRetry={() => void reload()} />;

  const filtered = applyFilters(
    state.data.bids.filter((b) => !removedIds.has(b.id)),
    { search: searchText, fromDate, toDate, repeatsOnly },
  );

  return (
    <div className="flex flex-col gap-4">
      <FilterBar
        count={filtered.length}
        searchText={searchText}
        fromDate={fromDate}
        toDate={toDate}
        repeatsOnly={repeatsOnly}
        onSearch={setSearchText}
        onFromDate={setFromDate}
        onToDate={setToDate}
        onRepeatsOnly={setRepeatsOnly}
      />

      {toast ? (
        <div className="flex items-center justify-between gap-3 rounded-sm border border-[rgba(29,184,122,0.3)] bg-[rgba(29,184,122,0.08)] px-3 py-2 text-body-sm text-semantic-success">
          <span>{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="rounded-sm p-1 hover:bg-bg-elevated"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {state.data.bids.length === 0 ? (
        <EmptyState />
      ) : filtered.length === 0 ? (
        <FilteredEmptyState />
      ) : (
        <ArchiveTable
          rows={filtered}
          onReactivateClick={(bid) => setModal(bid)}
        />
      )}

      {modal ? (
        <ReactivationModal
          bid={modal}
          onClose={() => setModal(null)}
          onReactivated={(bidId, mode) => {
            setRemovedIds((prev) => {
              const next = new Set(prev);
              next.add(bidId);
              return next;
            });
            setToast(
              mode === 'continue'
                ? 'Bid reactivated'
                : 'Bid reset to received',
            );
            setModal(null);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function FilterBar({
  count,
  searchText,
  fromDate,
  toDate,
  repeatsOnly,
  onSearch,
  onFromDate,
  onToDate,
  onRepeatsOnly,
}: {
  count: number;
  searchText: string;
  fromDate: string;
  toDate: string;
  repeatsOnly: boolean;
  onSearch: (next: string) => void;
  onFromDate: (next: string) => void;
  onToDate: (next: string) => void;
  onRepeatsOnly: (next: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border border-border-subtle bg-bg-surface p-3">
      <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-body-sm">
        <span className="text-label uppercase text-text-tertiary">Search</span>
        <input
          type="search"
          placeholder="Job or customer"
          value={searchText}
          onChange={(e) => onSearch(e.target.value)}
          className={cn(
            'rounded-sm border border-border-strong bg-bg-input px-2 py-1.5 text-body text-text-primary',
            'focus-visible:outline-none focus-visible:shadow-accent',
          )}
        />
      </label>
      <label className="flex flex-col gap-1 text-body-sm">
        <span className="text-label uppercase text-text-tertiary">
          Archived from
        </span>
        <input
          type="date"
          value={fromDate}
          onChange={(e) => onFromDate(e.target.value)}
          className={cn(
            'rounded-sm border border-border-strong bg-bg-input px-2 py-1.5 text-body text-text-primary',
            'focus-visible:outline-none focus-visible:shadow-accent',
          )}
        />
      </label>
      <label className="flex flex-col gap-1 text-body-sm">
        <span className="text-label uppercase text-text-tertiary">
          Archived to
        </span>
        <input
          type="date"
          value={toDate}
          onChange={(e) => onToDate(e.target.value)}
          className={cn(
            'rounded-sm border border-border-strong bg-bg-input px-2 py-1.5 text-body text-text-primary',
            'focus-visible:outline-none focus-visible:shadow-accent',
          )}
        />
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-body-sm">
        <input
          type="checkbox"
          checked={repeatsOnly}
          onChange={(e) => onRepeatsOnly(e.target.checked)}
          className="h-4 w-4 cursor-pointer accent-accent-primary"
        />
        <span className="text-text-secondary">Repeated jobs only</span>
        <span
          title="Shows jobs where the same customer and address appears more than once in your archive. Useful for finding delayed or rebid projects."
          className="inline-flex cursor-help items-center text-text-tertiary"
          aria-label="Repeated jobs only — explanation"
        >
          <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </label>
      <div className="ml-auto rounded-sm border border-border-subtle bg-bg-subtle px-2 py-1 text-label uppercase text-text-tertiary">
        {count} archived {count === 1 ? 'bid' : 'bids'}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Archive table
// ---------------------------------------------------------------------------

function ArchiveTable({
  rows,
  onReactivateClick,
}: {
  rows: ArchiveBid[];
  onReactivateClick: (bid: ArchiveBid) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border-base bg-bg-surface shadow-sm">
      <table className="w-full border-separate border-spacing-0 text-body-sm">
        <thead className="bg-bg-surface">
          <tr>
            <Th>Job name</Th>
            <Th>Customer</Th>
            <Th align="right">Board feet</Th>
            <Th>Status at archive</Th>
            <Th>Archived</Th>
            <Th>Archived by</Th>
            <Th align="right">Action</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr
              key={b.id}
              className="transition-colors duration-micro hover:bg-bg-subtle"
            >
              <Td className="max-w-[22ch] truncate">
                <Link
                  href={`/bids/${b.id}`}
                  className="text-text-primary hover:text-accent-primary"
                >
                  {b.jobName ?? b.customerName}
                </Link>
              </Td>
              <Td className="text-text-secondary">{b.customerName}</Td>
              <Td align="right" className="font-mono tabular-nums">
                {b.totalBoardFeet.toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}
              </Td>
              <Td>
                <StatusBadge status={b.status as BidStatus} />
              </Td>
              <Td className="text-text-tertiary" title={formatAbsolute(b.archivedAt)}>
                {formatRelative(b.archivedAt)}
              </Td>
              <Td className="text-text-secondary">
                {b.archivedByDisplayName ?? '—'}
              </Td>
              <Td align="right">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onReactivateClick(b)}
                >
                  Reactivate
                </Button>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reactivation modal
// ---------------------------------------------------------------------------

function ReactivationModal({
  bid,
  onClose,
  onReactivated,
}: {
  bid: ArchiveBid;
  onClose: () => void;
  onReactivated: (bidId: string, mode: 'continue' | 'fresh') => void;
}) {
  const [submitting, setSubmitting] = React.useState<
    null | 'continue' | 'fresh'
  >(null);
  const [error, setError] = React.useState<string | null>(null);

  async function call(mode: 'continue' | 'fresh') {
    setSubmitting(mode);
    setError(null);
    try {
      const res = await fetch(`/api/bids/${bid.id}/reactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Reactivate failed (${res.status}).`);
        return;
      }
      onReactivated(bid.id, mode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reactivate failed.');
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(10,14,12,0.7)] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reactivate-title"
    >
      <div className="w-full max-w-lg rounded-md border border-border-base bg-bg-surface p-5 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <h2 id="reactivate-title" className="text-h3 text-text-primary">
            Reactivate this bid
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm p-1 text-text-tertiary hover:bg-bg-subtle hover:text-text-primary"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-2 text-body text-text-secondary">
          <span className="text-text-primary">
            {bid.jobName ?? bid.customerName}
          </span>{' '}
          was archived {formatRelative(bid.archivedAt)}. How would you like to
          bring it back?
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <ReactivationOption
            title="Continue where you left off"
            body="Restores the bid as-is — same status, same consolidation mode, same routing. Use this when you're resuming work."
            onClick={() => void call('continue')}
            loading={submitting === 'continue'}
            disabled={submitting !== null}
            variant="primary"
          />
          <ReactivationOption
            title="Start fresh"
            body="Resets the bid to 'received', clears routing, and sets consolidation to structured. Line items and vendor pricing history are kept."
            onClick={() => void call('fresh')}
            loading={submitting === 'fresh'}
            disabled={submitting !== null}
            variant="secondary"
          />
        </div>
        {error ? (
          <p className="mt-3 text-body-sm text-semantic-error">{error}</p>
        ) : null}
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={onClose} disabled={submitting !== null}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function ReactivationOption({
  title,
  body,
  onClick,
  loading,
  disabled,
  variant,
}: {
  title: string;
  body: string;
  onClick: () => void;
  loading: boolean;
  disabled: boolean;
  variant: 'primary' | 'secondary';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'group flex flex-col gap-1 rounded-sm border px-3 py-3 text-left transition-colors duration-micro',
        variant === 'primary'
          ? 'border-[rgba(29,184,122,0.3)] bg-[rgba(29,184,122,0.06)] hover:bg-[rgba(29,184,122,0.12)]'
          : 'border-border-subtle bg-bg-subtle hover:bg-bg-elevated',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span
        className={cn(
          'text-body font-medium',
          variant === 'primary'
            ? 'text-accent-primary'
            : 'text-text-primary',
        )}
      >
        {loading ? `${title}…` : title}
      </span>
      <span className="text-body-sm text-text-secondary">{body}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-3 rounded-md border border-border-base bg-bg-surface px-6 py-12 text-center shadow-sm">
      <ArchiveIcon className="h-12 w-12 text-text-tertiary" aria-hidden="true" />
      <h2 className="text-h3 text-text-secondary">No archived bids</h2>
      <p className="max-w-md text-body-sm text-text-tertiary">
        Bids you archive will appear here. They're never deleted — just out of
        your active pipeline until you need them.
      </p>
    </div>
  );
}

function FilteredEmptyState() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-3 rounded-md border border-border-base bg-bg-surface px-6 py-10 text-center shadow-sm">
      <Search className="h-10 w-10 text-text-tertiary" aria-hidden="true" />
      <h2 className="text-h3 text-text-secondary">
        No archived bids match the current filters
      </h2>
      <p className="max-w-md text-body-sm text-text-tertiary">
        Broaden the search text or clear the date range to see more results.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 2 — Search (knowledge base over completed + archived bids)
// ---------------------------------------------------------------------------

interface SearchFilters {
  species: string;
  dimension: string;
  grade: string;
  region: string;
  customer: string;
  vendor: string;
  fromDate: string;
  toDate: string;
}

const EMPTY_FILTERS: SearchFilters = {
  species: '',
  dimension: '',
  grade: '',
  region: '',
  customer: '',
  vendor: '',
  fromDate: '',
  toDate: '',
};

const SEARCH_SPECIES = [
  '',
  'SPF',
  'DF',
  'HF',
  'SYP',
  'Cedar',
  'LVL',
  'OSB',
  'Plywood',
  'Treated',
];

const SEARCH_REGIONS = [
  { label: 'Any region', value: '' },
  { label: 'West', value: 'west' },
  { label: 'Pacific Northwest', value: 'pnw' },
  { label: 'California', value: 'california' },
  { label: 'Mountain West', value: 'mountain' },
  { label: 'Southwest', value: 'southwest' },
  { label: 'South', value: 'south' },
  { label: 'Midwest', value: 'midwest' },
  { label: 'Southeast', value: 'southeast' },
  { label: 'Northeast', value: 'northeast' },
];

interface KnowledgeResult {
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

interface KnowledgeAggregates {
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

function SearchTab() {
  const [filters, setFilters] = React.useState<SearchFilters>(EMPTY_FILTERS);
  const [state, setState] = React.useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; data: SearchResponse }
  >({ kind: 'idle' });

  function updateFilter<K extends keyof SearchFilters>(
    key: K,
    value: SearchFilters[K],
  ): void {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  async function runSearch(ev: React.FormEvent<HTMLFormElement>): Promise<void> {
    ev.preventDefault();
    setState({ kind: 'loading' });
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (typeof value === 'string' && value.trim().length > 0) {
          params.set(key, value.trim());
        }
      }
      const qs = params.toString();
      const res = await fetch(
        `/api/archive/search${qs.length > 0 ? `?${qs}` : ''}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setState({
          kind: 'error',
          message: body.error ?? `Search failed (${res.status}).`,
        });
        return;
      }
      const data = (await res.json()) as SearchResponse;
      setState({ kind: 'ready', data });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Search failed.',
      });
    }
  }

  function resetFilters(): void {
    setFilters(EMPTY_FILTERS);
    setState({ kind: 'idle' });
  }

  return (
    <div className="flex flex-col gap-4">
      <SearchFilterForm
        filters={filters}
        onChange={updateFilter}
        onSubmit={runSearch}
        onReset={resetFilters}
        submitting={state.kind === 'loading'}
      />

      {state.kind === 'idle' ? (
        <SearchIdleState />
      ) : state.kind === 'loading' ? (
        <LoadingShell />
      ) : state.kind === 'error' ? (
        <ErrorShell
          message={state.message}
          onRetry={() => setState({ kind: 'idle' })}
        />
      ) : (
        <SearchResultsPanel data={state.data} />
      )}
    </div>
  );
}

function SearchFilterForm({
  filters,
  onChange,
  onSubmit,
  onReset,
  submitting,
}: {
  filters: SearchFilters;
  onChange: <K extends keyof SearchFilters>(
    key: K,
    value: SearchFilters[K],
  ) => void;
  onSubmit: (ev: React.FormEvent<HTMLFormElement>) => void;
  onReset: () => void;
  submitting: boolean;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-md border border-border-subtle bg-bg-surface p-3"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
        <SelectField
          label="Species"
          value={filters.species}
          onChange={(v) => onChange('species', v)}
          options={SEARCH_SPECIES.map((s) => ({
            value: s,
            label: s === '' ? 'Any species' : s,
          }))}
        />
        <TextField
          label="Dimension"
          value={filters.dimension}
          onChange={(v) => onChange('dimension', v)}
          placeholder="2x4, 2x6, …"
        />
        <TextField
          label="Grade"
          value={filters.grade}
          onChange={(v) => onChange('grade', v)}
          placeholder="#2, Stud, …"
        />
        <SelectField
          label="Region"
          value={filters.region}
          onChange={(v) => onChange('region', v)}
          options={SEARCH_REGIONS}
        />
        <TextField
          label="Customer"
          value={filters.customer}
          onChange={(v) => onChange('customer', v)}
          placeholder="Contains match"
        />
        <TextField
          label="Vendor"
          value={filters.vendor}
          onChange={(v) => onChange('vendor', v)}
          placeholder="Contains match"
        />
        <TextField
          label="From date"
          type="date"
          value={filters.fromDate}
          onChange={(v) => onChange('fromDate', v)}
        />
        <TextField
          label="To date"
          type="date"
          value={filters.toDate}
          onChange={(v) => onChange('toDate', v)}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-body-sm text-text-tertiary">
          Searches completed and archived bids only. Drafts are excluded.
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" type="button" onClick={onReset} disabled={submitting}>
            Reset
          </Button>
          <Button variant="primary" type="submit" loading={submitting}>
            Search
          </Button>
        </div>
      </div>
    </form>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  type?: 'text' | 'date';
}) {
  return (
    <label className="flex flex-col gap-1 text-body-sm">
      <span className="text-label uppercase text-text-tertiary">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          'rounded-sm border border-border-strong bg-bg-input px-2 py-1.5 text-body text-text-primary',
          'focus-visible:outline-none focus-visible:shadow-accent',
          'placeholder:text-text-tertiary',
        )}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
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

function SearchIdleState() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-3 rounded-md border border-border-base bg-bg-surface px-6 py-12 text-center shadow-sm">
      <Search className="h-12 w-12 text-text-tertiary" aria-hidden="true" />
      <h2 className="text-h3 text-text-secondary">Knowledge base search</h2>
      <p className="max-w-md text-body-sm text-text-tertiary">
        Filter by species, dimension, region, customer, vendor, or date
        range. Results pull from every quote this company has ever
        committed to — the platform&apos;s memory of what you paid and
        who won.
      </p>
    </div>
  );
}

function SearchResultsPanel({ data }: { data: SearchResponse }) {
  const { results, aggregates } = data;
  if (results.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-3 rounded-md border border-border-base bg-bg-surface px-6 py-10 text-center shadow-sm">
        <Search className="h-10 w-10 text-text-tertiary" aria-hidden="true" />
        <h2 className="text-h3 text-text-secondary">No matching lines</h2>
        <p className="max-w-md text-body-sm text-text-tertiary">
          Loosen a filter or widen the date range. The knowledge base
          only indexes quotes that moved past draft — newer companies
          may need a few complete bids before results show up.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <AggregatesRow aggregates={aggregates} />
      <ResultsTable results={results} />
    </div>
  );
}

function AggregatesRow({ aggregates }: { aggregates: KnowledgeAggregates }) {
  const fmt2 = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <SummaryCard
        label="Top vendors"
        value={
          aggregates.topVendors.length === 0
            ? '—'
            : aggregates.topVendors.length.toString()
        }
        caption={
          aggregates.topVendors.length === 0
            ? 'no vendor data'
            : 'by lines won'
        }
      >
        {aggregates.topVendors.length > 0 ? (
          <ol className="mt-2 flex flex-col gap-1 text-body-sm">
            {aggregates.topVendors.slice(0, 5).map((v, index) => (
              <li
                key={v.vendorId}
                className="flex items-baseline justify-between gap-2 text-text-secondary"
              >
                <span className="truncate">
                  {index + 1}. {v.vendorName}
                </span>
                <span className="font-mono tabular-nums text-text-tertiary">
                  {v.winCount}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </SummaryCard>
      <SummaryCard
        label="Average margin"
        value={
          aggregates.avgMarginPercent === null
            ? '—'
            : pct(aggregates.avgMarginPercent)
        }
        caption={
          aggregates.uniqueQuotes > 0
            ? `across ${aggregates.uniqueQuotes} ${
                aggregates.uniqueQuotes === 1 ? 'quote' : 'quotes'
              }`
            : ''
        }
      />
      <SummaryCard
        label="Cost price range"
        value={
          aggregates.priceRange
            ? fmt2.format(aggregates.priceRange.median)
            : '—'
        }
        caption={
          aggregates.priceRange
            ? `${fmt2.format(aggregates.priceRange.low)} — ${fmt2.format(aggregates.priceRange.high)}`
            : 'no priced lines'
        }
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  caption,
  children,
}: {
  label: string;
  value: string;
  caption?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border-base bg-bg-surface px-4 py-3 shadow-sm">
      <div className="text-label uppercase text-text-tertiary">{label}</div>
      <div className="mt-1 font-mono text-[24px] font-semibold leading-none tabular-nums text-text-primary">
        {value}
      </div>
      {caption ? (
        <div className="mt-1 text-body-sm text-text-tertiary">{caption}</div>
      ) : null}
      {children}
    </div>
  );
}

function ResultsTable({ results }: { results: KnowledgeResult[] }) {
  const fmt2 = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (
    <div className="overflow-hidden rounded-md border border-border-base bg-bg-surface shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-body-sm">
          <thead className="bg-bg-surface">
            <tr>
              <Th>Species</Th>
              <Th>Dim / grade</Th>
              <Th>Customer</Th>
              <Th>Region</Th>
              <Th>Vendor</Th>
              <Th align="right">Qty</Th>
              <Th align="right">Cost</Th>
              <Th align="right">Sell</Th>
              <Th>Date</Th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => {
              const descParts: string[] = [];
              if (r.dimension) descParts.push(r.dimension);
              if (r.grade) descParts.push(r.grade);
              return (
                <tr
                  key={r.lineId}
                  className="transition-colors duration-micro hover:bg-bg-subtle"
                >
                  <Td>{r.species}</Td>
                  <Td className="text-text-secondary">
                    {descParts.join(' · ') || '—'}
                  </Td>
                  <Td className="max-w-[18ch] truncate">
                    <Link
                      href={`/bids/${r.bidId}`}
                      className="text-text-primary hover:text-accent-primary"
                      title={r.jobName ? `${r.customerName} · ${r.jobName}` : r.customerName}
                    >
                      {r.customerName}
                    </Link>
                  </Td>
                  <Td className="text-text-secondary">
                    {r.jobRegion ?? '—'}
                  </Td>
                  <Td className="text-text-secondary">
                    {r.vendorName ?? '—'}
                  </Td>
                  <Td align="right" className="font-mono tabular-nums">
                    {r.quantity}
                  </Td>
                  <Td align="right" className="font-mono tabular-nums">
                    {fmt2.format(r.costPrice)}
                  </Td>
                  <Td align="right" className="font-mono tabular-nums">
                    {fmt2.format(r.sellPrice)}
                  </Td>
                  <Td className="text-text-tertiary">
                    {formatAbsoluteDate(r.bidCreatedAt)}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatAbsoluteDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Shells
// ---------------------------------------------------------------------------

function LoadingShell() {
  return (
    <div className="rounded-md border border-border-base bg-bg-surface p-6 shadow-sm">
      <p className="text-body text-text-secondary">Loading archive…</p>
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
          <h2 className="text-h3 text-text-primary">Could not load archive</h2>
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
// Small helpers + primitives
// ---------------------------------------------------------------------------

function applyFilters(
  rows: ArchiveBid[],
  filters: {
    search: string;
    fromDate: string;
    toDate: string;
    repeatsOnly: boolean;
  },
): ArchiveBid[] {
  const needle = filters.search.trim().toLowerCase();
  const fromMs = filters.fromDate
    ? new Date(`${filters.fromDate}T00:00:00Z`).getTime()
    : null;
  const toMs = filters.toDate
    ? new Date(`${filters.toDate}T23:59:59.999Z`).getTime()
    : null;

  return rows.filter((b) => {
    if (needle.length > 0) {
      const job = (b.jobName ?? '').toLowerCase();
      const cust = b.customerName.toLowerCase();
      if (!job.includes(needle) && !cust.includes(needle)) return false;
    }
    const archivedMs = new Date(b.archivedAt).getTime();
    if (fromMs !== null && archivedMs < fromMs) return false;
    if (toMs !== null && archivedMs > toMs) return false;
    if (filters.repeatsOnly && b.repeatCount <= 1) return false;
    return true;
  });
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diffMs = Date.now() - t;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  });
}

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
  title,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
  title?: string;
}) {
  return (
    <td
      title={title}
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
