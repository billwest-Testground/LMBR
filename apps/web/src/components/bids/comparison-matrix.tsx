/**
 * ComparisonMatrix — vendor × line-item price grid (flagship UI).
 *
 * Purpose:  The most important screen in LMBR.ai. Renders the
 *           ComparisonResult produced by @lmbr/agents/comparison-agent as a
 *           dense, trading-terminal-style grid: every line × every vendor,
 *           best price highlighted teal, worst price tinted red, trader
 *           selections tinted warm-green. Selection is pure client state —
 *           no API calls on click. A sticky running-total bar at the bottom
 *           surfaces selected cost, savings vs worst, and vendor count.
 *
 *           Non-negotiables per README §6.2 and CLAUDE.md §"Key Product
 *           Rules":
 *           - Virtualized with TanStack Virtual (overscan 8). 400 rows ×
 *             10 vendor columns cannot lag.
 *           - Numeric cells use monospace + tabular-nums + right-align.
 *           - Vendor-name watermark "Internal only — never shown to customer"
 *             is present and permanent.
 *           - Building/phase tag is preserved in the row summary — nothing
 *             about the comparison collapses the source structure.
 *           - Never makes a network call. Prompt 07 will own persistence.
 *
 *           Keyboard: every cell is a <button>, so Tab/Shift-Tab walk the
 *           grid and Enter/Space select. Aria-labels describe
 *           "Select {vendor} for {species} {dimension}" per accessibility
 *           rules in README §15.
 *
 * Inputs:   { result, onExportSelection? }.
 * Outputs:  JSX.
 * Agent/API: none — pure client-side rendering of a prebuilt ComparisonResult.
 * Imports:  @tanstack/react-virtual, @lmbr/agents, lucide-react, ../ui/button,
 *           ../../lib/cn.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ShieldAlert, Sparkles, Users, Eraser, DollarSign } from 'lucide-react';

import type { ComparisonCell, ComparisonResult, ComparisonRow } from '@lmbr/agents';

import { Button } from '../ui/button';
import { cn } from '../../lib/cn';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ExportedSelection {
  lineItemId: string;
  vendorId: string;
  vendorBidLineItemId: string;
  unitPrice: number;
  totalPrice: number;
}

export interface ComparisonMatrixProps {
  result: ComparisonResult;
  /** Called when the trader clicks "Export selection to margin stacking". */
  onExportSelection?: (selection: ExportedSelection[]) => void;
}

interface SelectionEntry {
  vendorId: string;
  vendorBidLineItemId: string;
  unitPrice: number;
  totalPrice: number;
}

// -----------------------------------------------------------------------------
// Constants — layout widths kept in sync between header + body
// -----------------------------------------------------------------------------

const ROW_HEIGHT = 44; // README §6 standard data-table body row height
const LINE_COL_WIDTH = 280;
const QTY_COL_WIDTH = 96;
const VENDOR_COL_WIDTH = 128; // ≥ 110px per README §6.2, plus a little breathing room
const SUMMARY_COL_WIDTH = 180;

// -----------------------------------------------------------------------------
// Formatters (module-level so they're not reallocated per render)
// -----------------------------------------------------------------------------

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const UNIT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

// Spread amounts are a bucket-of-cents summary — 2 decimals is plenty.
// Unit prices (UNIT above) keep 4 fraction digits because lumber quotes
// routinely carry $0.0025-level precision.
const SPREAD = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatLineLabel(row: ComparisonRow): { top: string; bottom: string } {
  const { lineSummary } = row;
  const top = `${lineSummary.species} · ${lineSummary.dimension}`;
  const parts: string[] = [];
  if (lineSummary.grade) parts.push(lineSummary.grade);
  if (lineSummary.length) parts.push(`${lineSummary.length} ft`);
  parts.push(`${lineSummary.quantity.toLocaleString()} ${lineSummary.unit}`);
  if (lineSummary.buildingTag) parts.push(lineSummary.buildingTag);
  if (lineSummary.phaseNumber !== null) parts.push(`phase ${lineSummary.phaseNumber}`);
  return { top, bottom: parts.join(' · ') };
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

export function ComparisonMatrix({
  result,
  onExportSelection,
}: ComparisonMatrixProps) {
  const { vendors, rows, vendorSummaries, suggestions } = result;

  // --- Selection state: one vendor per line (client-side only) --------------
  const [selection, setSelection] = React.useState<Map<string, SelectionEntry>>(
    () => new Map(),
  );

  // Per-vendor response-coverage lookup for the sticky header.
  const coverageByVendor = React.useMemo(() => {
    const map = new Map<string, { linesPriced: number }>();
    for (const s of vendorSummaries) {
      map.set(s.vendorId, { linesPriced: s.linesPriced });
    }
    return map;
  }, [vendorSummaries]);

  // vendorId -> vendorName lookup for row-level aria-labels. Pre-computed
  // once per result so we don't walk the vendors array on every cell render.
  const vendorNameById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const v of vendors) map.set(v.vendorId, v.vendorName);
    return map;
  }, [vendors]);

  const totalLines = rows.length;

  // --- Virtualization -------------------------------------------------------
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  // lineItemId -> row index, memoised separately from selection-derived totals
  // so the 400-entry Map is only rebuilt when `rows` actually changes.
  const rowById = React.useMemo(() => {
    const map = new Map<string, ComparisonRow>();
    for (const r of rows) map.set(r.lineItemId, r);
    return map;
  }, [rows]);

  // --- Derived numbers (memoised) ------------------------------------------
  // Selected total uses each selection's recorded totalPrice.
  // Savings vs worst = Σ per selected line of (worstUnitPrice - selectedUnitPrice) × quantity,
  // skipping lines where worstUnitPrice is null (only one vendor priced it,
  // or no worst available). This matches "savings vs highest" in the spec —
  // picking the worst vendor per line is the counterfactual we compare to.
  const { selectedTotal, savingsVsHighest, vendorCount } = React.useMemo(() => {
    let total = 0;
    let savings = 0;
    const vendorIds = new Set<string>();

    for (const [lineItemId, entry] of selection.entries()) {
      total += entry.totalPrice;
      vendorIds.add(entry.vendorId);

      const row = rowById.get(lineItemId);
      if (
        row &&
        row.worstUnitPrice !== null &&
        row.worstUnitPrice !== undefined &&
        entry.unitPrice !== null
      ) {
        savings +=
          (row.worstUnitPrice - entry.unitPrice) * row.lineSummary.quantity;
      }
    }
    return {
      selectedTotal: total,
      savingsVsHighest: savings,
      vendorCount: vendorIds.size,
    };
  }, [rowById, selection]);

  const selectedCount = selection.size;

  // --- Selection mutations --------------------------------------------------
  // Stable callback (empty deps) so React.memo on MatrixRow can actually
  // skip re-renders when an unrelated row's selection changes. The per-cell
  // onClick closure is rebuilt inside MatrixRow only when that row itself
  // re-renders — which is what we want.
  const toggleCell = React.useCallback(
    (lineItemId: string, cell: ComparisonCell) => {
      if (
        cell.vendorBidLineItemId === null ||
        cell.unitPrice === null ||
        cell.totalPrice === null ||
        cell.declined
      ) {
        return;
      }
      const vendorBidLineItemId = cell.vendorBidLineItemId;
      const entry: SelectionEntry = {
        vendorId: cell.vendorId,
        vendorBidLineItemId,
        unitPrice: cell.unitPrice,
        totalPrice: cell.totalPrice,
      };
      setSelection((prev) => {
        const next = new Map(prev);
        const current = next.get(lineItemId);
        if (current && current.vendorBidLineItemId === vendorBidLineItemId) {
          // Clicking the currently-selected cell deselects.
          next.delete(lineItemId);
        } else {
          next.set(lineItemId, entry);
        }
        return next;
      });
    },
    [],
  );

  const applySuggestion = React.useCallback(
    (selections: Record<string, string>) => {
      // Convert agent suggestion (lineItemId -> vendorId) into full entries
      // by pulling unit/total prices off the row cells. Lines without a
      // priced cell for the suggested vendor are skipped (shouldn't happen,
      // but stay defensive).
      const next = new Map<string, SelectionEntry>();
      for (const row of rows) {
        const vendorId = selections[row.lineItemId];
        if (!vendorId) continue;
        const cell = row.cells.find((c) => c.vendorId === vendorId);
        if (
          cell &&
          cell.vendorBidLineItemId !== null &&
          cell.unitPrice !== null &&
          cell.totalPrice !== null
        ) {
          next.set(row.lineItemId, {
            vendorId,
            vendorBidLineItemId: cell.vendorBidLineItemId,
            unitPrice: cell.unitPrice,
            totalPrice: cell.totalPrice,
          });
        }
      }
      setSelection(next);
    },
    [rows],
  );

  const clearSelection = React.useCallback(() => {
    setSelection(new Map());
  }, []);

  const handleExport = React.useCallback(() => {
    if (!onExportSelection || selection.size === 0) return;
    const out: ExportedSelection[] = [];
    for (const [lineItemId, entry] of selection.entries()) {
      out.push({
        lineItemId,
        vendorId: entry.vendorId,
        vendorBidLineItemId: entry.vendorBidLineItemId,
        unitPrice: entry.unitPrice,
        totalPrice: entry.totalPrice,
      });
    }
    onExportSelection(out);
  }, [onExportSelection, selection]);

  // --- Render ---------------------------------------------------------------

  const totalGridWidth = React.useMemo(
    () =>
      LINE_COL_WIDTH +
      QTY_COL_WIDTH +
      vendors.length * VENDOR_COL_WIDTH +
      SUMMARY_COL_WIDTH,
    [vendors.length],
  );

  return (
    <div className="flex min-h-[60vh] flex-col gap-4">
      {/* Title + watermark ---------------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-h2 text-text-primary">Vendor Comparison</h2>
          <p className="mt-1 text-caption text-text-tertiary">
            Manual cell selection below. Select-all-cheapest picks best unit
            price per line; minimize-vendors greedy-covers the bid with the
            fewest purchase orders.
          </p>
        </div>
        <div
          role="note"
          aria-label="Internal only — vendor names never appear on customer output"
          className="inline-flex items-center gap-2 rounded-pill border border-[rgba(184,122,29,0.3)] bg-[rgba(184,122,29,0.1)] px-3 py-1 text-label uppercase text-semantic-warning"
        >
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
          Internal only — never shown to customer
        </div>
      </div>

      {/* Controls ------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => applySuggestion(suggestions.cheapest.selections)}
        >
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          Select all cheapest
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => applySuggestion(suggestions.fewestVendors.selections)}
        >
          <Users className="h-4 w-4" aria-hidden="true" />
          Minimize vendors
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clearSelection}
          disabled={selectedCount === 0}
        >
          <Eraser className="h-4 w-4" aria-hidden="true" />
          Clear
        </Button>
        <span
          className="ml-1 inline-flex items-center rounded-pill border border-border-base bg-bg-subtle px-3 py-1 text-label uppercase text-text-secondary"
          aria-live="polite"
        >
          <span className="font-mono tabular-nums text-text-primary">
            {selectedCount}
          </span>
          <span className="ml-1">of</span>
          <span className="ml-1 font-mono tabular-nums text-text-primary">
            {totalLines}
          </span>
          <span className="ml-1">lines selected</span>
        </span>
      </div>

      {/* Matrix body ---------------------------------------------------- */}
      <div className="overflow-hidden rounded-md border border-border-base bg-bg-surface shadow-sm">
        <div
          ref={scrollRef}
          role="grid"
          aria-rowcount={rows.length + 1}
          aria-colcount={vendors.length + 3}
          aria-label="Vendor comparison matrix"
          className="relative max-h-[60vh] min-h-[60vh] overflow-auto"
          // `contain: 'content'` = layout + paint + style. `strict` would
          // also imply size containment, which requires explicit dimensions
          // and can cause Safari to collapse the flex container.
          style={{ contain: 'content' }}
        >
          {/* Header row (sticky) */}
          <MatrixHeader
            vendors={vendors}
            coverageByVendor={coverageByVendor}
            totalLines={totalLines}
            totalGridWidth={totalGridWidth}
          />

          {/* Virtualized body */}
          <div
            role="rowgroup"
            style={{
              height: virtualizer.getTotalSize(),
              width: totalGridWidth,
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              const selected = selection.get(row.lineItemId) ?? null;
              return (
                <MatrixRow
                  key={row.lineItemId}
                  row={row}
                  selectedVendorId={selected?.vendorId ?? null}
                  onToggleCell={toggleCell}
                  top={virtualRow.start}
                  height={virtualRow.size}
                  totalGridWidth={totalGridWidth}
                  vendorNameById={vendorNameById}
                />
              );
            })}
          </div>

          {rows.length === 0 && (
            <div className="flex items-center justify-center py-16 text-body-sm text-text-tertiary">
              No line items yet.
            </div>
          )}
        </div>

        {/* Running total bar (sticky at the bottom of the card) ------- */}
        <RunningTotalBar
          selectedTotal={selectedTotal}
          savingsVsHighest={savingsVsHighest}
          vendorCount={vendorCount}
          selectedCount={selectedCount}
          onExport={handleExport}
          canExport={!!onExportSelection && selectedCount > 0}
        />
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Header
// -----------------------------------------------------------------------------

function MatrixHeader({
  vendors,
  coverageByVendor,
  totalLines,
  totalGridWidth,
}: {
  vendors: ComparisonResult['vendors'];
  coverageByVendor: Map<string, { linesPriced: number }>;
  totalLines: number;
  totalGridWidth: number;
}) {
  return (
    <div
      className="sticky top-0 z-20 flex border-b border-border-base bg-bg-surface"
      role="row"
      style={{ width: totalGridWidth }}
    >
      <HeaderCell width={LINE_COL_WIDTH} align="left" className="sticky left-0 z-30 bg-bg-surface">
        Line
      </HeaderCell>
      <HeaderCell width={QTY_COL_WIDTH} align="right">
        Qty
      </HeaderCell>
      {vendors.map((vendor) => {
        const coverage = coverageByVendor.get(vendor.vendorId);
        const linesPriced = coverage?.linesPriced ?? 0;
        return (
          <div
            key={vendor.vendorId}
            role="columnheader"
            className="flex h-9 shrink-0 flex-col items-center justify-center border-l border-border-subtle px-2 text-center"
            style={{ width: VENDOR_COL_WIDTH }}
            title={`${vendor.vendorName} — ${linesPriced} of ${totalLines} lines priced`}
          >
            <span className="w-full truncate text-label uppercase text-text-tertiary">
              {vendor.vendorName}
            </span>
            <span className="mt-0.5 text-[10px] font-mono tabular-nums text-text-tertiary">
              {linesPriced}/{totalLines}
            </span>
          </div>
        );
      })}
      <HeaderCell
        width={SUMMARY_COL_WIDTH}
        align="right"
        className="sticky right-0 z-30 border-l border-border-base bg-bg-surface"
      >
        Best / Spread / Bids
      </HeaderCell>
    </div>
  );
}

function HeaderCell({
  children,
  width,
  align,
  className,
}: {
  children: React.ReactNode;
  width: number;
  align: 'left' | 'right';
  className?: string;
}) {
  return (
    <div
      role="columnheader"
      className={cn(
        'flex h-9 shrink-0 items-center px-3 text-label uppercase text-text-tertiary',
        align === 'right' ? 'justify-end' : 'justify-start',
        className,
      )}
      style={{ width }}
    >
      {children}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Row
// -----------------------------------------------------------------------------

interface MatrixRowProps {
  row: ComparisonRow;
  /** vendorId of the currently-selected cell for this row, or null. */
  selectedVendorId: string | null;
  /**
   * Stable parent callback. Rebuilding the per-cell onClick closure here
   * (instead of in the parent) is safe because React.memo keeps this row
   * from re-rendering when its own props didn't change — so the closure
   * is also reconstructed only when needed.
   */
  onToggleCell: (lineItemId: string, cell: ComparisonCell) => void;
  top: number;
  height: number;
  totalGridWidth: number;
  vendorNameById: Map<string, string>;
}

const MatrixRow = React.memo(function MatrixRow({
  row,
  selectedVendorId,
  onToggleCell,
  top,
  height,
  totalGridWidth,
  vendorNameById,
}: MatrixRowProps) {
  const label = formatLineLabel(row);

  return (
    <div
      role="row"
      // `group` lets the sticky left/right columns (which must be opaque
      // to cover the scrolling vendor cells underneath) still pick up the
      // row-hover tint — otherwise the highlight has a visible seam where
      // the sticky columns sit.
      className="group absolute left-0 flex border-b border-border-subtle hover:bg-bg-subtle"
      style={{
        transform: `translateY(${top}px)`,
        height,
        width: totalGridWidth,
      }}
    >
      {/* Line summary (sticky left) */}
      <div
        role="cell"
        className="sticky left-0 z-10 flex shrink-0 flex-col justify-center border-r border-border-subtle bg-bg-surface px-3 group-hover:bg-bg-subtle"
        style={{ width: LINE_COL_WIDTH, height }}
      >
        <span className="truncate font-mono text-body-sm text-text-primary">
          {label.top}
        </span>
        <span className="truncate text-caption text-text-tertiary">
          {label.bottom}
        </span>
      </div>

      {/* Qty */}
      <div
        role="cell"
        className="flex shrink-0 items-center justify-end px-3 font-mono tabular-nums text-body-sm text-text-secondary"
        style={{ width: QTY_COL_WIDTH, height }}
      >
        {row.lineSummary.quantity.toLocaleString()}{' '}
        <span className="ml-1 text-text-tertiary">{row.lineSummary.unit}</span>
      </div>

      {/* Vendor price cells */}
      {row.cells.map((cell) => {
        const isSelected = selectedVendorId === cell.vendorId;
        const priced = cell.unitPrice !== null && !cell.declined;
        const vendorName = vendorNameById.get(cell.vendorId) ?? cell.vendorId;

        const onClick = () => {
          if (!priced) return;
          onToggleCell(row.lineItemId, cell);
        };

        return (
          <button
            key={cell.vendorId}
            type="button"
            role="cell"
            onClick={onClick}
            aria-label={`Select vendor ${vendorName} for ${row.lineSummary.species} ${row.lineSummary.dimension}`}
            aria-pressed={isSelected}
            disabled={!priced}
            className={cn(
              'flex shrink-0 items-center justify-end border-l border-border-subtle px-3 font-mono tabular-nums text-body-sm transition-colors duration-micro',
              // Visible focus ring — keyboard users must see where they are
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-1 focus-visible:ring-offset-bg-surface',
              priced ? 'cursor-pointer' : 'cursor-default',
              // Base color states
              !priced && !cell.declined && 'text-text-tertiary',
              cell.declined && 'italic text-text-tertiary',
              priced && !isSelected && !cell.isBestPrice && !cell.isWorstPrice && 'text-text-primary',
              // Best / worst tints — selected trumps both
              priced && cell.isBestPrice && !isSelected &&
                'bg-[rgba(29,184,122,0.15)] text-accent-primary font-semibold ring-1 ring-inset ring-[rgba(29,184,122,0.3)] rounded-xs',
              priced && cell.isWorstPrice && !cell.isBestPrice && !isSelected &&
                'bg-[rgba(192,57,43,0.05)] text-[rgba(192,57,43,0.7)]',
              // Selected tint
              isSelected &&
                'bg-[rgba(143,212,74,0.12)] text-accent-warm ring-1 ring-inset ring-[rgba(143,212,74,0.4)] rounded-xs',
            )}
            style={{ width: VENDOR_COL_WIDTH, height }}
          >
            {cell.declined ? (
              'declined'
            ) : cell.unitPrice === null ? (
              '—'
            ) : (
              UNIT.format(cell.unitPrice)
            )}
          </button>
        );
      })}

      {/* Row summary (sticky right) */}
      <div
        role="cell"
        className="sticky right-0 z-10 flex shrink-0 flex-col justify-center border-l border-border-base bg-bg-surface px-3 text-right font-mono tabular-nums group-hover:bg-bg-subtle"
        style={{ width: SUMMARY_COL_WIDTH, height }}
      >
        <span className="text-body-sm text-text-primary">
          {row.bestUnitPrice !== null ? UNIT.format(row.bestUnitPrice) : '—'}
          {row.spreadAmount !== null && (
            <span className="ml-1 text-caption text-text-tertiary">
              ±{SPREAD.format(row.spreadAmount)}
            </span>
          )}
        </span>
        <span className="text-caption text-text-tertiary">
          {row.bidCount} {row.bidCount === 1 ? 'bid' : 'bids'}
        </span>
      </div>
    </div>
  );
});

// -----------------------------------------------------------------------------
// Running total bar
// -----------------------------------------------------------------------------

function RunningTotalBar({
  selectedTotal,
  savingsVsHighest,
  vendorCount,
  selectedCount,
  onExport,
  canExport,
}: {
  selectedTotal: number;
  savingsVsHighest: number;
  vendorCount: number;
  selectedCount: number;
  onExport: () => void;
  canExport: boolean;
}) {
  return (
    <div
      className="flex h-14 items-center gap-4 border-t border-border-strong bg-bg-elevated px-4"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <span className="text-label uppercase text-text-tertiary">Selected</span>
        <span className="font-mono tabular-nums text-h3 text-text-primary">
          {selectedTotal > 0 ? USD.format(selectedTotal) : '$0.00'}
        </span>
      </div>
      <div className="h-6 w-px bg-border-base" aria-hidden="true" />
      <div className="flex items-center gap-2">
        <span className="text-label uppercase text-text-tertiary">Savings vs highest</span>
        <span
          className={cn(
            'font-mono tabular-nums text-body',
            savingsVsHighest > 0 ? 'text-accent-primary' : 'text-text-secondary',
          )}
        >
          {USD.format(savingsVsHighest)}
        </span>
      </div>
      <div className="h-6 w-px bg-border-base" aria-hidden="true" />
      <div className="flex items-center gap-2">
        <span className="text-label uppercase text-text-tertiary">Vendors</span>
        <span className="font-mono tabular-nums text-body text-text-primary">
          {vendorCount}
        </span>
      </div>
      <div className="ml-auto">
        <Button
          type="button"
          variant="primary"
          onClick={onExport}
          disabled={!canExport || selectedCount === 0}
        >
          <DollarSign className="h-4 w-4" aria-hidden="true" />
          Export selection to margin stacking
        </Button>
      </div>
    </div>
  );
}
