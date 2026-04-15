/**
 * LineItemTable — editable, grouped view of an extracted lumber list.
 *
 * Purpose:  The first review surface a trader sees after the ingest
 *           pipeline runs. Renders the extraction output grouped by
 *           building_tag + phase_number with sticky building headers,
 *           color-coded confidence dots, inline-editable cells, flag
 *           tooltips, and per-group + grand totals. The trader can
 *           correct any field the model got wrong before advancing the
 *           bid into the routing step.
 *
 *           Non-negotiables per README §14:
 *           - Numeric cells use monospace + tabular-nums + right-align.
 *           - Building/phase structure is NEVER destroyed — if the
 *             extraction had two buildings, the UI shows two groups.
 *           - Proceed is gated: any row at confidence < 0.75 blocks the
 *             button until the trader edits or re-extracts.
 *
 * Inputs:   extraction (ExtractionOutput), qaReport, onSave, onProceed.
 * Outputs:  JSX + callbacks.
 * Agent/API: qa-agent issues display only. Saves go through parent →
 *           PATCH /api/bids/[bidId]/line-items.
 * Imports:  lucide icons, design-system primitives.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import {
  AlertTriangle,
  AlertCircle,
  Info,
  ChevronRight,
  Save,
  ArrowRight,
} from 'lucide-react';

import { Button } from '../ui/button';
import { cn } from '../../lib/cn';
import type { ExtractionOutput, ExtractedLineItem, LineItemUnit } from '@lmbr/types';
import type { QaReport, QaLineItemIssue } from '@lmbr/agents';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface EditableLineItem extends ExtractedLineItem {
  /** Stable row key for React (either DB row id or locally-generated). */
  localId: string;
  /** Corresponding public.line_items row, populated after the first save. */
  dbId?: string;
  /** Group tag + phase for this row. */
  buildingTag: string;
  phaseNumber: number | null;
  /** True if the user has edited a field in this row since last save. */
  isDirty: boolean;
}

export interface LineItemTableProps {
  extraction: ExtractionOutput;
  qaReport: QaReport;
  /** Optional callback — called with ALL rows when the trader clicks Save. */
  onSave?: (rows: EditableLineItem[]) => Promise<void> | void;
  /** Optional callback — called when the trader clicks Proceed to routing. */
  onProceed?: () => void;
  /** Saving state for the Save button spinner. */
  saving?: boolean;
}

const CONFIDENCE_RED = 0.75;
const CONFIDENCE_YELLOW = 0.9;

const UNIT_OPTIONS: LineItemUnit[] = ['PCS', 'MBF', 'MSF'];

// -----------------------------------------------------------------------------
// Flatten the extraction into editable rows
// -----------------------------------------------------------------------------

function flattenToEditable(extraction: ExtractionOutput): EditableLineItem[] {
  const rows: EditableLineItem[] = [];
  extraction.buildingGroups.forEach((group, gi) => {
    group.lineItems.forEach((item, ii) => {
      rows.push({
        ...item,
        buildingTag: group.buildingTag,
        phaseNumber: group.phaseNumber,
        localId: `row-${gi}-${ii}`,
        isDirty: false,
      });
    });
  });
  return rows;
}

function buildIssueIndex(issues: QaLineItemIssue[]): Map<string, QaLineItemIssue[]> {
  const map = new Map<string, QaLineItemIssue[]>();
  issues.forEach((issue) => {
    const key = `row-${issue.groupIndex}-${issue.itemIndex}`;
    const bucket = map.get(key) ?? [];
    bucket.push(issue);
    map.set(key, bucket);
  });
  return map;
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

export function LineItemTable({
  extraction,
  qaReport,
  onSave,
  onProceed,
  saving = false,
}: LineItemTableProps) {
  const [rows, setRows] = React.useState<EditableLineItem[]>(() =>
    flattenToEditable(extraction),
  );

  // Reset when a fresh extraction arrives from the parent.
  React.useEffect(() => {
    setRows(flattenToEditable(extraction));
  }, [extraction]);

  const issueIndex = React.useMemo(
    () => buildIssueIndex(qaReport.issues),
    [qaReport.issues],
  );

  const groups = React.useMemo(() => groupRows(rows), [rows]);

  const grand = React.useMemo(() => computeTotals(rows), [rows]);

  const blockingItemCount = rows.filter((r) => r.confidence < CONFIDENCE_RED).length;
  const hasDirty = rows.some((r) => r.isDirty);

  function updateField<K extends keyof ExtractedLineItem>(
    localId: string,
    field: K,
    value: EditableLineItem[K],
  ) {
    setRows((current) =>
      current.map((r) =>
        r.localId !== localId
          ? r
          : {
              ...r,
              [field]: value,
              // Manual edits bump confidence to 1.0 — the trader is the
              // authority once they've touched a cell.
              confidence: field === 'confidence' ? (value as number) : 1,
              isDirty: true,
            },
      ),
    );
  }

  async function handleSave() {
    if (!onSave) return;
    await onSave(rows);
    setRows((current) => current.map((r) => ({ ...r, isDirty: false })));
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Summary strip ----------------------------------------------------- */}
      <SummaryStrip
        total={grand.totalRows}
        totalBoardFeet={grand.totalBoardFeet}
        extractionConfidence={extraction.extractionConfidence}
        qaReport={qaReport}
      />

      {/* Table ------------------------------------------------------------- */}
      <div className="overflow-hidden rounded-md border border-border-base bg-bg-surface shadow-sm">
        <div className="max-h-[640px] overflow-auto">
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
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const groupTotal = group.rows.reduce(
                  (s, r) => s + (r.boardFeet ?? 0),
                  0,
                );
                return (
                  <React.Fragment key={`${group.buildingTag}-${group.phaseNumber ?? 0}`}>
                    <GroupHeaderRow
                      buildingTag={group.buildingTag}
                      phaseNumber={group.phaseNumber}
                      rowCount={group.rows.length}
                      groupBoardFeet={groupTotal}
                    />
                    {group.rows.map((row) => (
                      <LineItemRow
                        key={row.localId}
                        row={row}
                        issues={issueIndex.get(row.localId) ?? []}
                        onUpdate={updateField}
                      />
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
            <tfoot className="sticky bottom-0 z-20">
              <tr className="bg-bg-elevated">
                <td colSpan={5} className="border-t border-border-strong px-3 py-3">
                  <span className="text-label uppercase text-text-tertiary">Grand total</span>
                </td>
                <td className="border-t border-border-strong px-3 py-3 text-right font-mono tabular-nums text-text-primary">
                  {grand.totalRows.toLocaleString()}
                </td>
                <td className="border-t border-border-strong px-3 py-3 text-text-tertiary">lines</td>
                <td className="border-t border-border-strong px-3 py-3 text-right font-mono tabular-nums text-text-primary">
                  {grand.totalBoardFeet.toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })}
                </td>
                <td className="border-t border-border-strong px-3 py-3" />
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Action bar -------------------------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-caption text-text-tertiary">
          {blockingItemCount > 0 ? (
            <span className="text-semantic-error">
              {blockingItemCount} line{blockingItemCount === 1 ? '' : 's'} below 75% confidence — fix before routing.
            </span>
          ) : (
            <span>All lines above 75% confidence. Ready to route.</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={handleSave}
            loading={saving}
            disabled={saving || !hasDirty}
          >
            <Save className="h-4 w-4" aria-hidden="true" /> Save changes
          </Button>
          <Button
            type="button"
            size="lg"
            onClick={onProceed}
            disabled={blockingItemCount > 0 || hasDirty}
          >
            Proceed to routing <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Subcomponents
// -----------------------------------------------------------------------------

function SummaryStrip({
  total,
  totalBoardFeet,
  extractionConfidence,
  qaReport,
}: {
  total: number;
  totalBoardFeet: number;
  extractionConfidence: number;
  qaReport: QaReport;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat label="Line items" value={total.toLocaleString()} />
      <Stat
        label="Total BF"
        value={totalBoardFeet.toLocaleString(undefined, { maximumFractionDigits: 0 })}
      />
      <Stat
        label="Extract confidence"
        value={`${Math.round(extractionConfidence * 100)}%`}
        tone={extractionConfidence >= 0.9 ? 'accent' : extractionConfidence >= 0.75 ? 'warn' : 'error'}
      />
      <Stat
        label="QA flags"
        value={`${qaReport.summary.errorCount} err · ${qaReport.summary.warningCount} warn`}
        tone={qaReport.pass ? 'accent' : 'warn'}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'accent' | 'warn' | 'error';
}) {
  const toneClass =
    tone === 'accent'
      ? 'text-accent-primary'
      : tone === 'warn'
        ? 'text-semantic-warning'
        : tone === 'error'
          ? 'text-semantic-error'
          : 'text-text-primary';
  return (
    <div className="rounded-md border border-border-base bg-bg-surface px-4 py-3 shadow-sm">
      <div className="text-label uppercase text-text-tertiary">{label}</div>
      <div className={cn('mt-1 text-h3 font-mono tabular-nums', toneClass)}>{value}</div>
    </div>
  );
}

function Th({
  children,
  align = 'left',
  className,
}: {
  children: React.ReactNode;
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
        colSpan={9}
        className="border-b border-border-base bg-bg-surface px-3 py-3"
      >
        <div className="flex items-center gap-3 border-l-[3px] border-accent-primary pl-3">
          <ChevronRight className="h-4 w-4 text-accent-primary" aria-hidden="true" />
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

function LineItemRow({
  row,
  issues,
  onUpdate,
}: {
  row: EditableLineItem;
  issues: QaLineItemIssue[];
  onUpdate: <K extends keyof ExtractedLineItem>(
    localId: string,
    field: K,
    value: EditableLineItem[K],
  ) => void;
}) {
  const tone =
    row.confidence < CONFIDENCE_RED
      ? 'error'
      : row.confidence < CONFIDENCE_YELLOW
        ? 'warn'
        : 'ok';
  const severity = issues.reduce<'info' | 'warning' | 'error' | null>((acc, i) => {
    if (i.severity === 'error') return 'error';
    if (i.severity === 'warning' && acc !== 'error') return 'warning';
    if (i.severity === 'info' && !acc) return 'info';
    return acc;
  }, null);

  return (
    <tr
      className={cn(
        'group transition-colors duration-micro',
        'hover:bg-bg-subtle',
        row.isDirty && 'bg-[rgba(29,184,122,0.04)]',
      )}
    >
      <td className="border-b border-border-subtle px-3 py-2 text-center">
        <ConfidenceDot tone={tone} value={row.confidence} />
      </td>
      <td className="border-b border-border-subtle px-2 py-1">
        <CellInput
          value={row.species}
          onCommit={(v) => onUpdate(row.localId, 'species', v)}
          align="left"
        />
      </td>
      <td className="border-b border-border-subtle px-2 py-1">
        <CellInput
          value={row.dimension}
          onCommit={(v) => onUpdate(row.localId, 'dimension', v)}
          mono
          align="left"
        />
      </td>
      <td className="border-b border-border-subtle px-2 py-1">
        <CellInput
          value={row.grade}
          onCommit={(v) => onUpdate(row.localId, 'grade', v)}
          align="left"
        />
      </td>
      <td className="border-b border-border-subtle px-2 py-1">
        <CellInput
          value={row.length}
          onCommit={(v) => onUpdate(row.localId, 'length', v)}
          align="left"
        />
      </td>
      <td className="border-b border-border-subtle px-2 py-1 text-right">
        <CellInput
          value={String(row.quantity)}
          onCommit={(v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) onUpdate(row.localId, 'quantity', n);
          }}
          mono
          align="right"
        />
      </td>
      <td className="border-b border-border-subtle px-2 py-1">
        <select
          value={row.unit}
          onChange={(e) => onUpdate(row.localId, 'unit', e.target.value as LineItemUnit)}
          className="block h-7 w-full rounded-sm border border-transparent bg-transparent px-1 text-body-sm text-text-primary transition-colors duration-micro hover:border-border-base focus:border-accent-primary focus:shadow-accent focus:outline-none"
        >
          {UNIT_OPTIONS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </td>
      <td className="border-b border-border-subtle px-3 py-2 text-right font-mono tabular-nums text-text-primary">
        {row.boardFeet.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </td>
      <td className="border-b border-border-subtle px-3 py-2 text-center">
        <FlagIndicator severity={severity} issues={issues} />
      </td>
    </tr>
  );
}

function ConfidenceDot({ tone, value }: { tone: 'ok' | 'warn' | 'error'; value: number }) {
  return (
    <span
      aria-label={`Confidence ${Math.round(value * 100)}%`}
      title={`Confidence ${Math.round(value * 100)}%`}
      className={cn(
        'status-dot inline-block h-2 w-2',
        tone === 'ok' && 'bg-accent-primary',
        tone === 'warn' && 'bg-semantic-warning',
        tone === 'error' && 'bg-semantic-error',
      )}
    />
  );
}

function CellInput({
  value,
  onCommit,
  mono,
  align = 'left',
}: {
  value: string | null | undefined;
  onCommit: (value: string) => void;
  mono?: boolean;
  align?: 'left' | 'right';
}) {
  const [local, setLocal] = React.useState(value ?? '');
  React.useEffect(() => setLocal(value ?? ''), [value]);

  return (
    <input
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => onCommit(local)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
      className={cn(
        'block h-7 w-full rounded-sm border border-transparent bg-transparent px-1 text-body-sm text-text-primary',
        'transition-colors duration-micro hover:border-border-base focus:border-accent-primary focus:shadow-accent focus:outline-none',
        mono && 'font-mono tabular-nums',
        align === 'right' && 'text-right',
      )}
    />
  );
}

function FlagIndicator({
  severity,
  issues,
}: {
  severity: 'info' | 'warning' | 'error' | null;
  issues: QaLineItemIssue[];
}) {
  if (!severity) return null;
  const Icon =
    severity === 'error' ? AlertCircle : severity === 'warning' ? AlertTriangle : Info;
  const color =
    severity === 'error'
      ? 'text-semantic-error'
      : severity === 'warning'
        ? 'text-semantic-warning'
        : 'text-semantic-info';
  return (
    <div className="relative inline-flex">
      <Icon className={cn('h-4 w-4', color)} aria-hidden="true" />
      <div className="pointer-events-none absolute left-1/2 top-full z-30 mt-1 hidden w-64 -translate-x-1/2 rounded-md border border-border-strong bg-bg-elevated p-3 text-caption text-text-secondary shadow-lg group-hover:block">
        <div className="mb-1 text-label uppercase text-text-tertiary">
          {severity}
        </div>
        <ul className="space-y-1">
          {issues.map((issue, i) => (
            <li key={i}>
              <span className="text-text-primary">{issue.code}</span>: {issue.message}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Derivations
// -----------------------------------------------------------------------------

interface GroupedRows {
  buildingTag: string;
  phaseNumber: number | null;
  rows: EditableLineItem[];
}

function groupRows(rows: EditableLineItem[]): GroupedRows[] {
  const map = new Map<string, GroupedRows>();
  rows.forEach((row) => {
    const key = `${row.buildingTag}::${row.phaseNumber ?? ''}`;
    const bucket = map.get(key);
    if (bucket) {
      bucket.rows.push(row);
    } else {
      map.set(key, {
        buildingTag: row.buildingTag,
        phaseNumber: row.phaseNumber,
        rows: [row],
      });
    }
  });
  return Array.from(map.values());
}

function computeTotals(rows: EditableLineItem[]): {
  totalRows: number;
  totalBoardFeet: number;
} {
  return {
    totalRows: rows.length,
    totalBoardFeet: rows.reduce((sum, r) => sum + (r.boardFeet ?? 0), 0),
  };
}
