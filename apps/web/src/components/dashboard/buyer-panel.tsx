/**
 * BuyerPanel — shared buyer queue for /dashboard/buyer + /dashboard/unified.
 *
 * Purpose:  Renders the current user's vendor-dispatch queue — every
 *           bid_routings row assigned to them, joined against the parent
 *           bid so the trader name, job name, due date, and status are
 *           visible. Polls every 10s via TanStack Query.
 *
 * Inputs:   { compact } — unified dashboard passes true for a denser view.
 * Outputs:  JSX.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Inbox, ArrowRight, Clock } from 'lucide-react';

import { getSupabaseBrowserClient } from '../../lib/supabase/browser';
import { StatCard } from './stat-card';
import { StatusBadge } from '../bids/status-badge';
import { cn } from '../../lib/cn';

type RoutingStatus =
  | 'pending'
  | 'accepted'
  | 'in_progress'
  | 'submitted'
  | 'completed';

interface BuyerQueueRow {
  id: string;
  commodity_group: string;
  line_item_ids: string[];
  status: RoutingStatus;
  created_at: string;
  bid: {
    id: string;
    customer_name: string;
    job_name: string | null;
    job_address: string | null;
    status: string;
    due_date: string | null;
  } | null;
}

type FilterKey = 'all' | 'pending' | 'in_progress' | 'submitted';

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'New' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'submitted', label: 'Submitted' },
];

export interface BuyerPanelProps {
  compact?: boolean;
}

export function BuyerPanel({ compact = false }: BuyerPanelProps) {
  const supabase = React.useMemo(() => getSupabaseBrowserClient(), []);
  const [filter, setFilter] = React.useState<FilterKey>('all');

  const { data: userId } = useQuery({
    queryKey: ['buyer-panel', 'user-id'],
    queryFn: async () => {
      const { data } = await supabase.auth.getUser();
      return data.user?.id ?? null;
    },
    staleTime: Infinity,
  });

  const { data: rows, isLoading, error } = useQuery({
    queryKey: ['buyer-panel', 'queue', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error: qErr } = await supabase
        .from('bid_routings')
        .select(
          `id, commodity_group, line_item_ids, status, created_at,
           bid:bids!inner(id, customer_name, job_name, job_address, status, due_date)`,
        )
        .eq('buyer_user_id', userId!)
        .order('created_at', { ascending: false })
        .limit(100);
      if (qErr) throw qErr;
      return (data ?? []) as unknown as BuyerQueueRow[];
    },
  });

  const stats = React.useMemo(() => {
    const r = rows ?? [];
    return {
      pending: r.filter((x) => x.status === 'pending').length,
      inProgress: r.filter((x) => x.status === 'in_progress').length,
      submitted: r.filter((x) => x.status === 'submitted').length,
      totalLines: r.reduce((s, x) => s + (x.line_item_ids?.length ?? 0), 0),
    };
  }, [rows]);

  const filteredRows = React.useMemo(() => {
    const r = rows ?? [];
    if (filter === 'all') return r;
    return r.filter((x) => x.status === filter);
  }, [rows, filter]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <div className="text-label uppercase text-text-tertiary">Buyer</div>
        <h1
          className={cn('mt-1 text-text-primary', compact ? 'text-h2' : 'text-h1')}
        >
          Vendor queue
        </h1>
      </header>

      <div
        className={cn(
          'grid gap-3',
          compact ? 'grid-cols-2' : 'grid-cols-2 md:grid-cols-4',
        )}
      >
        <StatCard
          label="New"
          value={stats.pending.toLocaleString()}
          tone={stats.pending > 0 ? 'accent' : 'default'}
        />
        <StatCard label="In progress" value={stats.inProgress.toLocaleString()} />
        {!compact && (
          <>
            <StatCard label="Submitted" value={stats.submitted.toLocaleString()} />
            <StatCard label="Total lines" value={stats.totalLines.toLocaleString()} />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              'inline-flex h-7 items-center rounded-pill border px-3 text-caption uppercase tracking-wide transition-colors duration-micro',
              filter === f.key
                ? 'border-accent-primary bg-[rgba(29,184,122,0.12)] text-accent-primary'
                : 'border-border-base text-text-tertiary hover:border-border-strong hover:text-text-secondary',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-sm border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.10)] px-3 py-2 text-body-sm text-semantic-error"
        >
          {error instanceof Error ? error.message : 'Failed to load queue'}
        </div>
      ) : isLoading ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[96px] animate-pulse rounded-md border border-border-base bg-bg-surface"
            />
          ))}
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border-base bg-bg-surface px-6 py-12 text-center">
          <Inbox className="h-10 w-10 text-text-tertiary" aria-hidden="true" />
          <div className="mt-4 text-h3 text-text-secondary">Queue is empty</div>
          <div className="mt-2 max-w-sm text-body text-text-tertiary">
            When a trader routes a bid to you, it shows up here ready for
            vendor dispatch.
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {filteredRows.map((row) => (
            <BuyerQueueCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function BuyerQueueCard({ row }: { row: BuyerQueueRow }) {
  const lineCount = row.line_item_ids?.length ?? 0;
  const bid = row.bid;
  return (
    <Link
      href={bid ? `/bids/${bid.id}` : '#'}
      className="group flex items-center justify-between gap-4 rounded-md border border-border-base bg-bg-surface p-4 shadow-sm transition-[background-color,border-color,box-shadow] duration-standard hover:border-border-strong hover:bg-bg-elevated hover:shadow-md"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-h4 text-text-primary">
            {bid?.job_name || bid?.customer_name || 'Unknown bid'}
          </span>
          <span className="rounded-pill bg-[rgba(29,184,122,0.12)] px-2 py-0.5 text-label uppercase text-accent-primary">
            {row.commodity_group}
          </span>
          {bid && <StatusBadge status={bid.status} />}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-tertiary">
          <span className="truncate">{bid?.customer_name ?? '—'}</span>
          {bid?.job_address && <span>· {bid.job_address}</span>}
          {bid?.due_date && (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden="true" />
              {new Date(bid.due_date).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
              })}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-6">
        <div className="text-right">
          <div className="font-mono text-body tabular-nums text-text-primary">
            {lineCount.toLocaleString()}
          </div>
          <div className="text-label uppercase tracking-wide text-text-tertiary">
            lines
          </div>
        </div>
        <ArrowRight
          className="h-4 w-4 text-text-tertiary transition-colors duration-micro group-hover:text-accent-primary"
          aria-hidden="true"
        />
      </div>
    </Link>
  );
}
