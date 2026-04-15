/**
 * StatusBadge — bid_status pill per README §7.
 *
 * Purpose:  Compact status indicator reused across every bid list,
 *           card, table, and detail header in the LMBR.ai console. The
 *           color tables come directly from README §7 — no custom
 *           branding creep because every pill in the console shares
 *           this single source of truth.
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

interface StatusStyle {
  bg: string;
  text: string;
  label: string;
  pulse?: boolean;
}

const STATUS_STYLES: Record<BidStatus, StatusStyle> = {
  received: {
    bg: 'bg-[rgba(74,158,232,0.15)]',
    text: 'text-semantic-info',
    label: 'received',
  },
  extracting: {
    bg: 'bg-[rgba(29,184,122,0.15)]',
    text: 'text-accent-primary',
    label: 'extracting',
    pulse: true,
  },
  reviewing: {
    bg: 'bg-[rgba(232,168,50,0.15)]',
    text: 'text-semantic-warning',
    label: 'reviewing',
  },
  routing: {
    bg: 'bg-[rgba(143,212,74,0.15)]',
    text: 'text-accent-warm',
    label: 'routing',
    pulse: true,
  },
  quoting: {
    bg: 'bg-[rgba(29,184,122,0.15)]',
    text: 'text-accent-primary',
    label: 'quoting',
  },
  comparing: {
    bg: 'bg-[rgba(143,212,74,0.15)]',
    text: 'text-accent-warm',
    label: 'comparing',
  },
  pricing: {
    bg: 'bg-[rgba(232,168,50,0.15)]',
    text: 'text-semantic-warning',
    label: 'pricing',
  },
  approved: {
    bg: 'bg-[rgba(29,184,122,0.15)]',
    text: 'text-accent-primary',
    label: 'approved',
  },
  sent: {
    bg: 'bg-[rgba(74,158,232,0.15)]',
    text: 'text-semantic-info',
    label: 'sent',
  },
  archived: {
    bg: 'bg-[rgba(107,124,117,0.15)]',
    text: 'text-text-tertiary',
    label: 'archived',
  },
};

export interface StatusBadgeProps {
  status: BidStatus | string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const style = STATUS_STYLES[status as BidStatus] ?? {
    bg: 'bg-bg-subtle',
    text: 'text-text-tertiary',
    label: status,
    pulse: false,
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-label uppercase',
        style.bg,
        style.text,
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
