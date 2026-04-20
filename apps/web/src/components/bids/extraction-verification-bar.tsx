/**
 * ExtractionVerificationBar — collapsible provenance chip above the
 * line item table on the bid detail screen.
 *
 * Purpose:  Surfaces the extraction provenance a trader needs to trust
 *           the auto-ingested line items at a glance:
 *             • Lines extracted
 *             • Total board feet
 *             • Building groups detected
 *             • Items flagged for review
 *             • Method breakdown (spreadsheet / PDF-text / OCR / AI)
 *
 *           Collapsed by default — the default-closed state matches the
 *           "zero friction on the hot path" feel of a trading terminal.
 *           Traders who trust the pipeline never expand it. New
 *           traders and ones auditing a weird bid click once and see
 *           the per-method breakdown. Source file download stays on
 *           the page header where it already lives; this component
 *           does NOT duplicate it.
 *
 *           Deliberately computes its summary from the same `rows`
 *           array that BidLinesView consumes — no second data read,
 *           no drift between the bar's counts and the table below.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

import { cn } from '../../lib/cn';
import type { BidLinesRow } from './bid-lines-view';

// Human-readable label per method. Matches the badge map in BidLinesView
// but kept local so a future label tweak in one place doesn't ripple.
const METHOD_LABEL: Record<string, string> = {
  excel_parse: 'Spreadsheet',
  csv_parse: 'CSV',
  pdf_direct: 'PDF text',
  docx_parse: 'DOCX',
  email_text: 'Email',
  direct_text: 'Text',
  ocr: 'Scan / OCR',
  claude_extraction: 'AI extraction',
};

function countFlags(row: BidLinesRow): number {
  if (!row.notes) return 0;
  try {
    const parsed = JSON.parse(row.notes);
    return Array.isArray(parsed.flags) ? parsed.flags.length : 0;
  } catch {
    return 0;
  }
}

export function ExtractionVerificationBar({
  rows,
}: {
  rows: BidLinesRow[];
}) {
  const [open, setOpen] = React.useState(false);

  if (rows.length === 0) return null;

  const totalBF = rows.reduce((s, r) => s + (r.board_feet ?? 0), 0);
  const buildingCount = new Set(
    rows.map((r) => `${r.building_tag ?? ''}::${r.phase_number ?? ''}`),
  ).size;
  const flaggedCount = rows.reduce((s, r) => s + (countFlags(r) > 0 ? 1 : 0), 0);

  // Method mix — one entry per distinct extraction_method present on
  // the rows. Ordered by count desc then alphabetically for stability.
  const methodCounts = new Map<string, number>();
  for (const row of rows) {
    const method = row.extraction_method ?? 'unknown';
    methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);
  }
  const methodMix = Array.from(methodCounts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  // Average extraction confidence across rows that have it populated.
  // Legacy rows (pre-migration 014) have null — exclude from the mean.
  const scored = rows.filter(
    (r) => typeof r.extraction_confidence === 'number',
  );
  const avgConfidence =
    scored.length === 0
      ? null
      : scored.reduce((s, r) => s + (r.extraction_confidence ?? 0), 0) /
        scored.length;

  const summaryTone: 'ok' | 'warn' =
    flaggedCount === 0 && (avgConfidence === null || avgConfidence >= 0.92)
      ? 'ok'
      : 'warn';

  return (
    <section
      className={cn(
        'rounded-md border bg-bg-surface shadow-sm',
        summaryTone === 'ok' ? 'border-border-base' : 'border-[rgba(232,161,72,0.35)]',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-micro hover:bg-bg-elevated"
        aria-expanded={open}
      >
        {summaryTone === 'ok' ? (
          <CheckCircle2
            className="h-4 w-4 flex-none text-accent-primary"
            aria-hidden="true"
          />
        ) : (
          <AlertTriangle
            className="h-4 w-4 flex-none text-semantic-warning"
            aria-hidden="true"
          />
        )}
        <span className="text-body text-text-primary">
          Extraction verification
        </span>
        <span className="text-body-sm text-text-tertiary">
          <span className="font-mono tabular-nums text-text-secondary">
            {rows.length.toLocaleString()}
          </span>{' '}
          lines ·{' '}
          <span className="font-mono tabular-nums text-text-secondary">
            {Math.round(totalBF).toLocaleString()}
          </span>{' '}
          BF ·{' '}
          <span className="font-mono tabular-nums text-text-secondary">
            {buildingCount}
          </span>{' '}
          {buildingCount === 1 ? 'group' : 'groups'}
          {flaggedCount > 0 && (
            <>
              {' '}
              ·{' '}
              <span className="font-mono tabular-nums text-semantic-warning">
                {flaggedCount}
              </span>{' '}
              flagged
            </>
          )}
        </span>
        <span className="ml-auto flex items-center text-text-tertiary">
          {open ? (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
      </button>

      {open && (
        <div className="border-t border-border-subtle px-4 py-4">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <DetailStat label="Lines extracted" value={rows.length.toLocaleString()} />
            <DetailStat
              label="Total board feet"
              value={totalBF.toLocaleString(undefined, {
                maximumFractionDigits: 0,
              })}
            />
            <DetailStat
              label="Building groups"
              value={buildingCount.toLocaleString()}
            />
            <DetailStat
              label="Items flagged"
              value={flaggedCount.toLocaleString()}
              tone={flaggedCount > 0 ? 'warn' : 'default'}
            />
            {avgConfidence !== null && (
              <DetailStat
                label="Avg confidence"
                value={`${Math.round(avgConfidence * 100)}%`}
                tone={avgConfidence < 0.92 ? 'warn' : 'default'}
              />
            )}
          </div>

          {methodMix.length > 0 && (
            <div className="mt-4 border-t border-border-subtle pt-3">
              <div className="mb-2 text-label uppercase text-text-tertiary">
                Method breakdown
              </div>
              <ul className="flex flex-wrap gap-2">
                {methodMix.map(([method, count]) => (
                  <li
                    key={method}
                    className="inline-flex items-center gap-2 rounded-full border border-border-base bg-bg-elevated px-3 py-1 text-caption"
                  >
                    <span className="text-text-secondary">
                      {METHOD_LABEL[method] ?? method}
                    </span>
                    <span className="font-mono tabular-nums text-text-primary">
                      {count.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-4 text-caption text-text-tertiary">
            Counts are computed from persisted rows. A mismatch with your
            source document means extraction missed lines — open the
            source file from the header and compare.
          </p>
        </div>
      )}
    </section>
  );
}

function DetailStat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warn';
}) {
  return (
    <div>
      <div className="text-label uppercase text-text-tertiary">{label}</div>
      <div
        className={cn(
          'mt-1 text-h3 font-mono tabular-nums',
          tone === 'warn' ? 'text-semantic-warning' : 'text-text-primary',
        )}
      >
        {value}
      </div>
    </div>
  );
}
