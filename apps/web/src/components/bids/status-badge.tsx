/**
 * StatusBadge — bid_status pill per README §7.
 *
 * Purpose:  Compact status indicator reused across every bid list,
 *           card, table, and detail header. Monochrome-first design:
 *           every status renders as a neutral gray pill except
 *           `approved` and `sent`, which earn the Worklighter teal
 *           because they're positive terminal states worth
 *           highlighting. `extracting` and `routing` keep a pulsing
 *           status dot so traders can tell at a glance that a bid is
 *           actively moving through the pipeline.
 *
 *           No color on the pill = design-system intent: color is a
 *           signal, not decoration. If you find yourself adding a new
 *           color here, ask whether the status really earns it.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import * as React from 'react';
import { cn } from '../../lib/cn';

export type BidStatus =
  | 'received'
  | 'extracting'
  | 'reviewing'
  | 'routing'
  | 'quoting'
  | 'comparing'
  | 'pricing'
  | 'approved'
  | 'sent'
  | 'archived';

// Monochrome base — every neutral-flow status shares this.
const NEUTRAL =
  'border border-border-base bg-bg-subtle text-text-secondary';

// Positive terminal state — teal-tinted. Used only for `approved` and
// `sent` because those are the statuses a trader WANTS to see.
const POSITIVE =
  'border border-[rgba(29,184,122,0.35)] bg-[rgba(29,184,122,0.10)] text-accent-primary';

interface StatusStyle {
  classes: string;
  label: string;
  pulse?: boolean;
}

const STATUS_STYLES: Record<BidStatus, StatusStyle> = {
  received: { classes: NEUTRAL, label: 'received' },
  extracting: { classes: NEUTRAL, label: 'extracting', pulse: true },
  reviewing: { classes: NEUTRAL, label: 'reviewing' },
  routing: { classes: NEUTRAL, label: 'routing', pulse: true },
  quoting: { classes: NEUTRAL, label: 'quoting' },
  comparing: { classes: NEUTRAL, label: 'comparing' },
  pricing: { classes: NEUTRAL, label: 'pricing' },
  approved: { classes: POSITIVE, label: 'approved' },
  sent: { classes: POSITIVE, label: 'sent' },
  archived: { classes: NEUTRAL, label: 'archived' },
};

export interface StatusBadgeProps {
  status: BidStatus | string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const style =
    STATUS_STYLES[status as BidStatus] ?? {
      classes: NEUTRAL,
      label: status,
      pulse: false,
    };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-label uppercase',
        style.classes,
        className,
      )}
      aria-label={`Status: ${style.label}`}
    >
      {style.pulse && (
        <span
          aria-hidden="true"
          className="status-dot status-dot-pulse bg-current"
        />
      )}
      {style.label}
    </span>
  );
}
