/**
 * BidLinesView — read-only grouped view of a bid's persisted line items.
 *
 * Purpose:  Canonical review surface for a bid after ingest. Unlike
 *           LineItemTable (editable, takes ExtractionOutput + QaReport
 *           in-memory), this component reads from persisted
 *           public.line_items rows and renders them grouped by
 *           building/phase with the self-reported model confidence +
 *           flags from the notes JSON blob. Meant for the bid detail
 *           page where traders audit extractions against the source
 *           document without editing.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { AlertCircle, AlertTriangle, Info } from 'lucide-react';

import { cn } from '../../lib/cn';

export interface BidLinesRow {
  id: string;
  building_tag: string | null;
  phase_number: number | null;
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number;
  unit: string;
  board_feet: number | null;
  notes: string | null;
  sort_order: number;
}

interface LineMeta {
  confidence: number;
  flags: string[];
  original_text: string;
}

function parseMeta(notes: string | null): LineMeta {
  if (!notes) return { confidence: 1, flags: [], original_text: '' };
  try {
    const parsed = JSON.parse(notes);
    return {
      confidence:
        typeof parsed.confidence === 'number' ? parsed.confidence : 1,
      flags: Array.isArray(parsed.flags) ? parsed.flags : [],
      original_text:
        typeof parsed.original_text === 'string' ? parsed.original_text : '',
    };
  } catch {
    return { confidence: 1, flags: [], original_text: '' };
  }
}

interface Group {
  buildingTag: string;
  phaseNumber: number | null;
  rows: BidLinesRow[];
}

function groupLines(rows: BidLinesRow[]): Group[] {
  const map = new Map<string, Group>();
  for (const row of rows) {
    const tag = row.building_tag ?? 'Unassigned';
    const key = `${tag}::${row.phase_number ?? ''}`;
    const bucket = map.get(key);
    if (bucket) {
      bucket.rows.push(row);
    } else {
      map.set(key, {
        buildingTag: tag,
        phaseNumber: row.phase_number,
        rows: [row],
      });
    }
  }
  return Array.from(map.values());
}

export function BidLinesView({ rows }: { rows: BidLinesRow[] }) {
  const groups = React.useMemo(() => groupLines(rows), [rows]);
  const grandTotalBF = rows.reduce((s, r) => s + (r.board_feet ?? 0), 0);

  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border-base bg-bg-surface px-6 py-10 text-center text-body text-text-tertiary">
        No line items on this bid yet.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-border-base bg-bg-surface shadow-sm">
      <div className="max-h-[720px] overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-body-sm">
          <thead className="sticky top-0 z-20">
            <tr className="bg-bg-surface">
              <Th className="w-10" align="center">
                <span className="sr-only">Confidence</span>
              </Th>
              <Th>Species</Th>
              <Th>Dimension</Th>
              <Th>Grade</Th>
              <Th>Length</Th>
              <Th align="right">Qty</Th>
              <Th>Unit</Th>
              <Th align="right">Board feet</Th>
              <Th align="center" className="w-10">
                <span className="sr-only">Flags</span>
              </Th>
              <Th>Source line</Th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const groupBF = group.rows.reduce(
                (s, r) => s + (r.board_feet ?? 0),
                0,
              );
              return (
                <React.Fragment
                  key={`${group.buildingTag}-${group.phaseNumber ?? 0}`}
                >
                  <GroupHeaderRow
                    buildingTag={group.buildingTag}
                    phaseNumber={group.phaseNumber}
                    rowCount={group.rows.length}
                    groupBoardFeet={groupBF}
                  />
                  {group.rows.map((row) => (
                    <LineRow key={row.id} row={row} />
                  ))}
                </React.Fragment>
              );
            })}
          </tbody>
          <tfoot className="sticky bottom-0 z-20">
            <tr className="bg-bg-elevated">
              <td
                colSpan={5}
                className="border-t border-border-strong px-3 py-3"
              >
                <span className="text-label uppercase text-text-tertiary">
                  Grand total
                </span>
              </td>
              <td className="border-t border-border-strong px-3 py-3 text-right font-mono tabular-nums text-text-primary">
                {rows.length.toLocaleString()}
              </td>
              <td className="border-t border-border-strong px-3 py-3 text-text-tertiary">
                lines
              </td>
              <td className="border-t border-border-strong px-3 py-3 text-right font-mono tabular-nums text-text-primary">
                {grandTotalBF.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}
              </td>
              <td
                colSpan={2}
                className="border-t border-border-strong px-3 py-3"
              />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function GroupHeaderRow({
  buildingTag,
  phaseNumber,
  rowCount,
  groupBoardFeet,
}: {
  buildingTag: string;
  phaseNumber: number | null;
  rowCount: number;
  groupBoardFeet: number;
}) {
  return (
    <tr className="sticky top-[37px] z-10">
      <td
        colSpan={10}
        className="border-b border-border-base bg-bg-surface px-3 py-3"
      >
        <div className="flex items-center gap-3 border-l-[3px] border-accent-primary pl-3">
          <span className="text-h4 text-text-primary">{buildingTag}</span>
          {phaseNumber !== null && (
            <span className="text-label uppercase text-text-tertiary">
              Phase {phaseNumber}
            </span>
          )}
          <span className="ml-auto flex items-center gap-4 text-caption text-text-tertiary">
            <span>
              <span className="font-mono tabular-nums text-text-secondary">
                {rowCount}
              </span>{' '}
              lines
            </span>
            <span>
              <span className="font-mono tabular-nums text-text-secondary">
                {groupBoardFeet.toLocaleString(undefined, {
                  maximumFractionDigits: 0,
                })}
              </span>{' '}
              BF
            </span>
          </span>
        </div>
      </td>
    </tr>
  );
}

function LineRow({ row }: { row: BidLinesRow }) {
  const meta = parseMeta(row.notes);
  const tone =
    meta.confidence < 0.75
      ? 'error'
      : meta.confidence < 0.9
        ? 'warn'
        : 'ok';
  const severity: 'info' | 'warning' | 'error' | null =
    meta.flags.length > 0
      ? meta.flags.some((f) =>
          ['missing_grade', 'missing_field'].includes(f),
        )
        ? 'error'
        : 'warning'
      : null;

  return (
    <tr className="group transition-colors duration-micro hover:bg-bg-subtle">
      <td className="border-b border-border-subtle px-3 py-2 text-center">
        <span
          className={cn(
            'inline-block h-2 w-2 rounded-pill',
            tone === 'ok' && 'bg-accent-primary',
            tone === 'warn' && 'bg-semantic-warning',
            tone === 'error' && 'bg-semantic-error',
          )}
          aria-label={`Confidence ${Math.round(meta.confidence * 100)}%`}
          title={`Confidence ${Math.round(meta.confidence * 100)}%`}
        />
      </td>
      <td className="border-b border-border-subtle px-3 py-2 text-text-primary">
        {row.species}
      </td>
      <td className="border-b border-border-subtle px-3 py-2 font-mono text-text-primary">
        {row.dimension}
      </td>
      <td className="border-b border-border-subtle px-3 py-2">
        {row.grade ?? '—'}
      </td>
      <td className="border-b border-border-subtle px-3 py-2">
        {row.length ?? '—'}
      </td>
      <td className="border-b border-border-subtle px-3 py-2 text-right font-mono tabular-nums text-text-primary">
        {Number(row.quantity).toLocaleString()}
      </td>
      <td className="border-b border-border-subtle px-3 py-2 text-text-tertiary">
        {row.unit}
      </td>
      <td className="border-b border-border-subtle px-3 py-2 text-right font-mono tabular-nums text-text-primary">
        {row.board_feet != null
          ? Number(row.board_feet).toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })
          : '—'}
      </td>
      <td className="border-b border-border-subtle px-3 py-2 text-center">
        {severity && <FlagIcon severity={severity} flags={meta.flags} />}
      </td>
      <td
        className="max-w-[260px] truncate border-b border-border-subtle px-3 py-2 text-caption text-text-tertiary"
        title={meta.original_text}
      >
        {meta.original_text || '—'}
      </td>
    </tr>
  );
}

function FlagIcon({
  severity,
  flags,
}: {
  severity: 'info' | 'warning' | 'error';
  flags: string[];
}) {
  const Icon =
    severity === 'error'
      ? AlertCircle
      : severity === 'warning'
        ? AlertTriangle
        : Info;
  const color =
    severity === 'error'
      ? 'text-semantic-error'
      : severity === 'warning'
        ? 'text-semantic-warning'
        : 'text-semantic-info';
  return (
    <span title={flags.join(', ')}>
      <Icon className={cn('h-4 w-4', color)} aria-hidden="true" />
    </span>
  );
}

function Th({
  children,
  align = 'left',
  className,
}: {
  children?: React.ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  return (
    <th
      className={cn(
        'border-b border-border-base bg-bg-surface px-3 py-2 text-label uppercase text-text-tertiary',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}
