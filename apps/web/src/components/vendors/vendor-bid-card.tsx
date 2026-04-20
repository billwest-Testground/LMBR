/**
 * VendorBidCard — one-vendor status tile for the buyer's status board.
 *
 * Purpose:  Rendered one-per-`vendor_bids` row on the buyer's workspace
 *           (`/bids/[bidId]/vendors`). Shows the vendor's current state at
 *           a glance — status chip, relative dispatch time, firm due-by
 *           using the shared `formatDueByLabel` helper, priced-vs-expected
 *           progress, and the two URLs the buyer needs in a hurry: the
 *           vendor submit link (copy-to-clipboard) and the printable PDF
 *           tally (opens). A "Nudge" action posts to the stub endpoint.
 *
 *           Color tokens hug the LMBR.ai palette (bg-bg-surface + accent /
 *           semantic / info tints) rather than raw Tailwind slate/amber so
 *           the card lives happily on the dark console background without
 *           extra theming. Status → style mapping is a single `STATUS_STYLES`
 *           constant so the summary row + card ring stay in lockstep.
 *
 * Inputs:   { vendorBid, vendor, pricedCount, expectedCount, onNudge,
 *              nudging }.
 * Outputs:  JSX card.
 * Agent/API: POST /api/vendors/nudge via parent onNudge callback.
 * Imports:  lucide-react, format-datetime helper, @lmbr/types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { Bell, Check, Copy, Printer } from 'lucide-react';

import type { VendorBidStatus } from '@lmbr/types';

import { cn } from '../../lib/cn';
import { formatDueByLabel } from '../../lib/format-datetime';

export interface VendorBidCardVendor {
  id: string;
  name: string;
  vendorType: string | null;
  minOrderMbf: number | null;
}

export interface VendorBidCardVb {
  id: string;
  status: VendorBidStatus;
  submissionMethod: string;
  sentAt: string | null;
  dueBy: string | null;
  submittedAt: string | null;
  token: string | null;
  tokenExpiresAt: string | null;
  rawResponseUrl: string | null;
}

export interface VendorBidCardProps {
  vendorBid: VendorBidCardVb;
  vendor: VendorBidCardVendor | null;
  pricedCount: number;
  expectedCount: number;
  submitUrl: string | null;
  printUrl: string | null;
  onNudge: (vendorBidId: string) => void;
  nudging: boolean;
}

interface StatusStyle {
  /** Left border accent — the dominant visual cue on the card. */
  ring: string;
  /** Pill background tint. */
  badgeBg: string;
  /** Pill text color. */
  badgeText: string;
  label: string;
}

/**
 * Status palette — anchored to the tailwind.config.ts tokens so every
 * downstream surface (status board, comparison matrix, quote header) can
 * pull from the same place. Raw `rgba(...)` tints match the existing
 * `status-badge.tsx` convention exactly.
 */
export const STATUS_STYLES: Record<VendorBidStatus, StatusStyle> = {
  pending: {
    ring: 'border-l-semantic-warning',
    badgeBg: 'bg-[rgba(184,122,29,0.15)]',
    badgeText: 'text-semantic-warning',
    label: 'pending',
  },
  submitted: {
    ring: 'border-l-accent-primary',
    badgeBg: 'bg-[rgba(29,184,122,0.15)]',
    badgeText: 'text-accent-primary',
    label: 'submitted',
  },
  partial: {
    ring: 'border-l-semantic-info',
    badgeBg: 'bg-[rgba(45,111,163,0.15)]',
    badgeText: 'text-semantic-info',
    label: 'partial',
  },
  declined: {
    ring: 'border-l-text-tertiary',
    badgeBg: 'bg-[rgba(107,124,117,0.15)]',
    badgeText: 'text-text-tertiary',
    label: 'declined',
  },
  expired: {
    ring: 'border-l-semantic-error',
    badgeBg: 'bg-[rgba(192,57,43,0.15)]',
    badgeText: 'text-semantic-error',
    label: 'expired',
  },
};

export function VendorBidCard({
  vendorBid,
  vendor,
  pricedCount,
  expectedCount,
  submitUrl,
  printUrl,
  onNudge,
  nudging,
}: VendorBidCardProps) {
  const style = STATUS_STYLES[vendorBid.status];
  const pricedPct =
    expectedCount > 0
      ? Math.min(100, Math.round((pricedCount / expectedCount) * 100))
      : 0;

  // Three-state copy indicator — idle / copied / failed. 'failed' covers
  // Safari + insecure-origin contexts where navigator.clipboard throws;
  // we surface that visibly instead of silently no-op'ing so the buyer
  // knows to long-press the title'd link for manual copy.
  const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const copyTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const handleCopy = React.useCallback(async () => {
    if (!submitUrl) return;
    try {
      await navigator.clipboard.writeText(submitUrl);
      setCopyState('copied');
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      // Clipboard API can fail on insecure origins / Safari. Flip to the
      // 'failed' label so the user sees something happened and can fall
      // back to long-press on the title'd URL for manual copy.
      setCopyState('failed');
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyState('idle'), 2500);
    }
  }, [submitUrl]);

  return (
    <div
      className={cn(
        'group relative flex flex-col gap-3 rounded-md border border-border-base border-l-4 bg-bg-surface p-4 shadow-sm transition-[background-color,border-color,box-shadow,transform] duration-standard',
        'hover:border-border-strong hover:bg-bg-elevated hover:shadow-md hover:-translate-y-0.5',
        style.ring,
      )}
    >
      {/* Header row: vendor name + status badge */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-h4 text-text-primary">
            {vendor?.name ?? 'Unknown vendor'}
          </h3>
          {vendor?.vendorType && (
            <p className="mt-0.5 text-caption uppercase tracking-wide text-text-tertiary">
              {vendor.vendorType}
              {vendor.minOrderMbf != null && vendor.minOrderMbf > 0
                ? ` · min ${vendor.minOrderMbf.toLocaleString()} MBF`
                : ''}
            </p>
          )}
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center rounded-pill px-2 py-0.5 text-label uppercase',
            style.badgeBg,
            style.badgeText,
          )}
          aria-label={`Status: ${style.label}`}
        >
          {style.label}
        </span>
      </div>

      {/* Timing row */}
      <div className="grid grid-cols-2 gap-3 text-caption">
        <div>
          <p className="text-label uppercase tracking-wider text-text-tertiary">
            Sent
          </p>
          <p className="mt-0.5 text-body-sm text-text-secondary">
            {formatRelativeTime(vendorBid.sentAt)}
          </p>
        </div>
        <div>
          <p className="text-label uppercase tracking-wider text-text-tertiary">
            Due by
          </p>
          <p className="mt-0.5 text-body-sm text-text-secondary">
            {formatDueByLabel(vendorBid.dueBy)}
          </p>
        </div>
      </div>

      {/* Priced progress */}
      <div>
        <div className="flex items-baseline justify-between">
          <p className="text-label uppercase tracking-wider text-text-tertiary">
            Priced
          </p>
          <p className="font-mono text-body-sm tabular-nums text-text-primary">
            {pricedCount.toLocaleString()} / {expectedCount.toLocaleString()}
            <span className="ml-2 text-text-tertiary">{pricedPct}%</span>
          </p>
        </div>
        <div
          className="mt-1 h-1 w-full overflow-hidden rounded-pill bg-bg-subtle"
          role="progressbar"
          aria-valuenow={pricedPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${pricedCount} of ${expectedCount} lines priced`}
        >
          <div
            className="h-full bg-accent-primary transition-all duration-standard"
            style={{ width: `${pricedPct}%` }}
          />
        </div>
      </div>

      {/* URLs row */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleCopy}
          disabled={!submitUrl}
          title={submitUrl ?? 'No token issued'}
          className={cn(
            'inline-flex flex-1 items-center justify-center gap-1.5 rounded-sm border border-border-base bg-bg-elevated px-3 py-1.5 text-body-sm text-text-secondary transition-colors duration-micro',
            'hover:border-border-strong hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border-base disabled:hover:text-text-secondary',
          )}
        >
          {copyState === 'copied' ? (
            <>
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              Copied
            </>
          ) : copyState === 'failed' ? (
            <>
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              Copy failed — long-press link to copy
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              Copy submit link
            </>
          )}
        </button>
        <a
          href={printUrl ?? '#'}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!printUrl}
          tabIndex={printUrl ? 0 : -1}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-sm border border-border-base bg-bg-elevated px-3 py-1.5 text-body-sm text-text-secondary transition-colors duration-micro',
            'hover:border-border-strong hover:text-text-primary',
            !printUrl && 'pointer-events-none opacity-50',
          )}
          title={printUrl ?? 'No print URL'}
        >
          <Printer className="h-3.5 w-3.5" aria-hidden="true" />
          Print
        </a>
        <button
          type="button"
          onClick={() => onNudge(vendorBid.id)}
          disabled={nudging}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-sm border border-accent-primary bg-accent-primary/10 px-3 py-1.5 text-body-sm font-medium text-accent-primary transition-colors duration-micro',
            'hover:bg-accent-primary/20 disabled:cursor-not-allowed disabled:opacity-60',
          )}
        >
          <Bell className="h-3.5 w-3.5" aria-hidden="true" />
          {nudging ? 'Queueing…' : 'Nudge'}
        </button>
      </div>

      {/* Hidden screen-reader live region for copy confirmation. */}
      <span role="status" aria-live="polite" className="sr-only">
        {copyState === 'copied'
          ? 'Submit link copied to clipboard'
          : copyState === 'failed'
            ? 'Copy failed — long-press the link to copy manually'
            : ''}
      </span>
    </div>
  );
}

/**
 * Relative time ("2h ago", "3d ago", "just now"). Kept local to the card
 * because it's a niche helper — the shared `formatDueByLabel` covers the
 * absolute-timestamp case.
 */
function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'Not sent';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return 'Just now';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
