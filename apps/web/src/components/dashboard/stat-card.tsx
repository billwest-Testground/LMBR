/**
 * StatCard — metric tile per README §5 "Stat Card".
 *
 * Purpose:  Dense, scannable metric tile used across every dashboard.
 *           Renders a caps label, a monospace tabular value, and an
 *           optional trend arrow + delta.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import * as React from 'react';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface StatCardProps {
  label: string;
  value: string;
  trend?: 'up' | 'down' | 'flat';
  trendLabel?: string;
  tone?: 'default' | 'accent' | 'warn' | 'error';
}

export function StatCard({
  label,
  value,
  trend,
  trendLabel,
  tone = 'default',
}: StatCardProps) {
  const toneClass =
    tone === 'accent'
      ? 'text-accent-primary'
      : tone === 'warn'
        ? 'text-semantic-warning'
        : tone === 'error'
          ? 'text-semantic-error'
          : 'text-text-primary';

  return (
    <div className="rounded-md border border-border-base bg-bg-surface px-5 py-4 shadow-sm">
      <div className="text-label uppercase tracking-wide text-text-tertiary">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 text-h1 font-mono tabular-nums leading-none',
          toneClass,
        )}
      >
        {value}
      </div>
      {trend && trendLabel && (
        <div
          className={cn(
            'mt-2 inline-flex items-center gap-1 text-caption',
            trend === 'up' && 'text-accent-warm',
            trend === 'down' && 'text-semantic-error',
            trend === 'flat' && 'text-text-tertiary',
          )}
        >
          {trend === 'up' && <ArrowUpRight className="h-3 w-3" aria-hidden="true" />}
          {trend === 'down' && (
            <ArrowDownRight className="h-3 w-3" aria-hidden="true" />
          )}
          <span>{trendLabel}</span>
        </div>
      )}
    </div>
  );
}
