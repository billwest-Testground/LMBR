/**
 * TraderPanel — shared trader view for /dashboard/trader + /dashboard/unified.
 *
 * Purpose:  Renders the active bid pipeline for the current tenant from
 *           the trader's perspective: four stat cards, a status filter
 *           row, and a virtualizable bid list. Data is fetched via
 *           TanStack Query against the authenticated Supabase browser
 *           client — RLS enforces tenancy, so pure traders only see
 *           their own bids while trader_buyers / buyers / managers see
 *           the full tenant. Polls every 10s.
 *
 * Inputs:   { compact } — when true, the unified dashboard's split panel
 *           renders a denser variant (smaller title, 2 stats instead of 4).
 * Outputs:  JSX.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';

import { getSupabaseBrowserClient } from '../../lib/supabase/browser';
import { Button } from '../ui/button';
import { BidList } from '../bids/bid-list';
import { StatCard } from './stat-card';
import { cn } from '../../lib/cn';
import type { BidStatus } from '../bids/status-badge';

const ALL_STATUSES: BidStatus[] = [
  'received',
  'extracting',
  'reviewing',
  'routing',
  'quoting',
  'comparing',
  'pricing',
  'approved',
  'sent',
];

interface FetchedBid {
  id: string;
  customer_name: string;
  job_name: string | null;
  status: string;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

interface StatBuckets {
  activeBids: number;
  dueToday: number;
  dueThisWeek: number;
  quotesSentMtd: number;
}

function bucketStats(bids: FetchedBid[]): StatBuckets {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
  const endOfWeek = new Date(startOfToday.getTime() + 7 * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  let activeBids = 0;
  let dueToday = 0;
  let dueThisWeek = 0;
  let quotesSentMtd = 0;

  for (const bid of bids) {
    if (bid.status !== 'sent' && bid.status !== 'archived') {
      activeBids += 1;
    }
    if (bid.due_date) {
      const due = new Date(bid.due_date);
      if (due >= startOfToday && due < endOfToday) dueToday += 1;
      if (due >= startOfToday && due < endOfWeek) dueThisWeek += 1;
    }
    if (bid.status === 'sent' && new Date(bid.updated_at) >= startOfMonth) {
      quotesSentMtd += 1;
    }
  }
  return { activeBids, dueToday, dueThisWeek, quotesSentMtd };
}

export interface TraderPanelProps {
  compact?: boolean;
}

export function TraderPanel({ compact = false }: TraderPanelProps) {
  const supabase = React.useMemo(() => getSupabaseBrowserClient(), []);
  const [statusFilter, setStatusFilter] = React.useState<BidStatus | 'all'>('all');

  const { data: bids, isLoading, error } = useQuery({
    queryKey: ['trader-panel', 'bids'],
    queryFn: async () => {
      const { data, error: qErr } = await supabase
        .from('bids')
        .select(
          'id, customer_name, job_name, status, due_date, created_at, updated_at',
        )
        .order('created_at', { ascending: false })
        .limit(100);
      if (qErr) throw qErr;
      return (data ?? []) as FetchedBid[];
    },
  });

  const stats = React.useMemo(() => bucketStats(bids ?? []), [bids]);

  const filteredBids = React.useMemo(() => {
    if (!bids) return [];
    if (statusFilter === 'all') return bids;
    return bids.filter((b) => b.status === statusFilter);
  }, [bids, statusFilter]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-label uppercase text-text-tertiary">Trader</div>
          <h1
            className={cn(
              'mt-1 text-text-primary',
              compact ? 'text-h2' : 'text-h1',
            )}
          >
            Incoming bids
          </h1>
        </div>
        <Button asChild size={compact ? 'md' : 'lg'}>
          <Link href="/bids/new">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New bid
          </Link>
        </Button>
      </header>

      <div
        className={cn(
          'grid gap-3',
          compact ? 'grid-cols-2' : 'grid-cols-2 md:grid-cols-4',
        )}
      >
        <StatCard
          label="Active bids"
          value={stats.activeBids.toLocaleString()}
          tone="accent"
        />
        <StatCard
          label="Due today"
          value={stats.dueToday.toLocaleString()}
          tone={stats.dueToday > 0 ? 'warn' : 'default'}
        />
        {!compact && (
          <>
            <StatCard
              label="Due this week"
              value={stats.dueThisWeek.toLocaleString()}
            />
            <StatCard
              label="Quotes sent MTD"
              value={stats.quotesSentMtd.toLocaleString()}
            />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <StatusFilterChip
          active={statusFilter === 'all'}
          onClick={() => setStatusFilter('all')}
          label="All"
        />
        {ALL_STATUSES.map((status) => (
          <StatusFilterChip
            key={status}
            active={statusFilter === status}
            onClick={() => setStatusFilter(status)}
            label={status}
          />
        ))}
      </div>

      <BidList
        bids={filteredBids}
        loading={isLoading}
        error={error instanceof Error ? error.message : null}
      />
    </div>
  );
}

function StatusFilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center rounded-pill border px-3 text-caption uppercase tracking-wide transition-colors duration-micro',
        active
          ? 'border-accent-primary bg-[rgba(29,184,122,0.12)] text-accent-primary'
          : 'border-border-base text-text-tertiary hover:border-border-strong hover:text-text-secondary',
      )}
    >
      {label}
    </button>
  );
}
