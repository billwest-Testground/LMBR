/**
 * BidCard — compact summary row for a single bid.
 *
 * Purpose:  Reused by every dashboard (trader, buyer, unified, manager)
 *           and the /bids list. Shows job name, customer, due date,
 *           status chip, board-foot total, line-item count. Click navigates
 *           to the bid detail page.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { ArrowRight, Clock } from 'lucide-react';

import { StatusBadge, type BidStatus } from './status-badge';
import { cn } from '../../lib/cn';

export interface BidCardBid {
  id: string;
  customer_name: string;
  job_name: string | null;
  status: BidStatus | string;
  due_date: string | null;
  total_board_feet?: number | null;
  line_item_count?: number | null;
  updated_at?: string | null;
}

export interface BidCardProps {
  bid: BidCardBid;
  href?: string;
  compact?: boolean;
}

export function BidCard({ bid, href, compact = false }: BidCardProps) {
  const destination = href ?? defaultHrefForStatus(bid.id, bid.status);
  return (
    <Link
      href={destination as Route}
      className={cn(
        'group flex items-center justify-between gap-4 rounded-md border border-border-base bg-bg-surface p-4 shadow-sm transition-[background-color,border-color,box-shadow] duration-standard',
        'hover:border-border-strong hover:bg-bg-elevated hover:shadow-md',
        compact && 'p-3',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-h4 text-text-primary">
            {bid.job_name || bid.customer_name}
          </span>
          <StatusBadge status={bid.status} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-tertiary">
          <span className="truncate">{bid.customer_name}</span>
          {bid.due_date && (
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden="true" />
              {formatDueDate(bid.due_date)}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-6">
        {bid.line_item_count != null && (
          <Metric
            label="lines"
            value={bid.line_item_count.toLocaleString()}
          />
        )}
        {bid.total_board_feet != null && (
          <Metric
            label="BF"
            value={Math.round(bid.total_board_feet).toLocaleString()}
          />
        )}
        <ArrowRight
          className="h-4 w-4 text-text-tertiary transition-colors duration-micro group-hover:text-accent-primary"
          aria-hidden="true"
        />
      </div>
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <div className="font-mono text-body tabular-nums text-text-primary">{value}</div>
      <div className="text-label uppercase tracking-wide text-text-tertiary">{label}</div>
    </div>
  );
}

function defaultHrefForStatus(bidId: string, status: BidStatus | string): string {
  if (status === 'routing') return `/bids/${bidId}/route`;
  // Everything else points at the stub bid detail page until later
  // prompts flesh out per-stage surfaces (ingest review, comparison
  // matrix, pricing, quote preview).
  return `/bids/${bidId}`;
}

function formatDueDate(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffDays = Math.floor(
      (date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (diffDays === 0) return 'Due today';
    if (diffDays === 1) return 'Due tomorrow';
    if (diffDays < 0) return `${Math.abs(diffDays)}d overdue`;
    if (diffDays < 7) return `Due in ${diffDays}d`;
    return `Due ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  } catch {
    return iso;
  }
}
