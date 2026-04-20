/**
 * BidList — scrollable stack of BidCard rows with an empty state.
 *
 * Purpose:  The list rendering for any panel showing a collection of
 *           bids. Handles loading, empty state, and error messages.
 *           Virtualization isn't needed yet — dashboards rarely show
 *           more than 50 bids at once. When that changes, swap the map
 *           for a TanStack Virtual list; the surrounding layout stays
 *           identical.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import * as React from 'react';
import { Inbox } from 'lucide-react';

import { BidCard, type BidCardBid } from './bid-card';

export interface BidListProps {
  bids: BidCardBid[];
  loading?: boolean;
  error?: string | null;
  hrefBuilder?: (bid: BidCardBid) => string;
  emptyTitle?: string;
  emptyBody?: string;
}

export function BidList({
  bids,
  loading,
  error,
  hrefBuilder,
  emptyTitle = 'No bids yet',
  emptyBody = 'Forward your first lumber list to bids@[company].com or upload one to get started.',
}: BidListProps) {
  if (error) {
    return (
      <div
        role="alert"
        className="rounded-sm border border-[rgba(192,57,43,0.4)] bg-[rgba(192,57,43,0.10)] px-3 py-2 text-body-sm text-semantic-error"
      >
        {error}
      </div>
    );
  }

  if (loading && bids.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-[88px] animate-pulse rounded-md border border-border-base bg-bg-surface"
          />
        ))}
      </div>
    );
  }

  if (bids.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border-base bg-bg-surface px-6 py-12 text-center">
        <Inbox className="h-10 w-10 text-text-tertiary" aria-hidden="true" />
        <div className="mt-4 text-h3 text-text-secondary">{emptyTitle}</div>
        <div className="mt-2 max-w-sm text-body text-text-tertiary">{emptyBody}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {bids.map((bid) => (
        <BidCard key={bid.id} bid={bid} href={hrefBuilder?.(bid)} />
      ))}
    </div>
  );
}
