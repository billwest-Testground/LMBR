/**
 * MarginStack — flagship margin-stacking workspace (Prompt 07 Part 2).
 *
 * Purpose:  The screen where the buyer / trader_buyer / manager turns
 *           a selected set of vendor prices into a customer quote.
 *           Left panel hosts bulk controls (scope + mode + presets),
 *           the main table shows every line with an editable per-line
 *           margin %, and the right panel surfaces totals, a blended
 *           margin health indicator, and the approval gate.
 *
 *           Live numbers are recomputed entirely client-side using the
 *           same deterministic math as @lmbr/agents pricingAgent. We
 *           deliberately avoid importing pricingAgent itself because the
 *           @lmbr/agents barrel re-exports agents that depend on the
 *           Anthropic SDK — pulling that into the browser bundle is
 *           unnecessary for arithmetic. commodityGroupFor is narrow-
 *           imported from '@lmbr/agents/routing-agent' (pure TS, no SDK)
 *           and the STATE_SALES_TAX / CA_LUMBER_ASSESSMENT tables come
 *           direct from @lmbr/config — the same source the server
 *           pricing-agent reads. On successful Save the summary panel
 *           swaps to the server-authoritative PricingResult; margin
 *           edits after save flag the display back to "unsaved changes".
 *
 *           Vendor-name column carries a permanent "Internal — not on PDF"
 *           chip per CLAUDE.md §"Key Product Rules" rule 1.
 *
 * Inputs:   MarginStackProps (bidId, initialSelections, lines, settings,
 *           jobState, consolidationMode, isManager, onSave).
 * Outputs:  JSX.
 * Agent/API: pricing math mirrored client-side; /api/margin only on save.
 * Imports:  @lmbr/agents (types only), @lmbr/agents/routing-agent
 *           (commodityGroupFor), @lmbr/config (tax tables), lucide-react,
 *           ../ui/button, ../../lib/cn.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Eraser,
  FileText,
  Layers,
  Percent,
  Save,
  Send,
  ShieldAlert,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';

import type {
  MarginInstruction,
  MarginScope,
  MarginType,
  PricingResult,
  PricingSelection,
} from '@lmbr/agents';
// Narrow-import the commodity grouping helper directly from the routing-agent
// submodule (see packages/agents/package.json `exports`). Going through the
// barrel would transitively drag the Anthropic SDK + xlsx into the client
// bundle; the submodule's only runtime dep is `normalizeSpecies` from
// @lmbr/lib (pure function, no SDK).
import { commodityGroupFor } from '@lmbr/agents/routing-agent';
// Authoritative tax tables — shared with the server pricing-agent. Keeping
// the client preview in sync with server math prevents the "saw $0, got real
// tax after Save" surprise that the partial inlined table used to cause.
import { STATE_SALES_TAX, CA_LUMBER_ASSESSMENT } from '@lmbr/config';

import { Button } from '../ui/button';
import { cn } from '../../lib/cn';

// -----------------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------------

export interface MarginStackLine {
  lineItemId: string;
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number;
  unit: 'PCS' | 'MBF' | 'MSF';
  buildingTag: string | null;
  phaseNumber: number | null;
  sortOrder: number;
}

export interface MarginStackSettings {
  approvalThresholdDollars: number;
  minMarginPercent: number;
  /** Array of fractions, e.g. [0.08, 0.10, 0.12, 0.15, 0.18]. */
  marginPresets: number[];
}

export interface MarginStackSaveResult {
  needsApproval: boolean;
  pricing: PricingResult;
  quote: { id: string; status: string };
}

export interface MarginStackProps {
  bidId: string;
  initialSelections: PricingSelection[];
  lines: MarginStackLine[];
  settings: MarginStackSettings;
  jobState: string | null;
  consolidationMode: 'structured' | 'consolidated' | 'phased' | 'hybrid';
  isManager: boolean;
  /** Optional vendor-name lookup (internal display only). */
  vendorNameByVendorId?: Record<string, string>;
  onSave: (
    action: 'draft' | 'submit_for_approval',
    instructions: MarginInstruction[],
  ) => Promise<MarginStackSaveResult>;
}

// -----------------------------------------------------------------------------
// Commodity grouping — imported from @lmbr/agents/routing-agent (see above).
// -----------------------------------------------------------------------------

const COMMODITY_GROUPS: Array<{ id: string; label: string }> = [
  { id: 'All', label: 'All' },
  { id: 'Dimensional', label: 'Dimensional' },
  { id: 'Cedar', label: 'Cedar' },
  { id: 'Engineered', label: 'Engineered' },
  { id: 'Panels', label: 'Panels' },
  { id: 'Treated', label: 'Treated' },
];

// -----------------------------------------------------------------------------
// Tax helpers — STATE_SALES_TAX / CA_LUMBER_ASSESSMENT are imported from
// @lmbr/config (same table pricing-agent consumes server-side). Keeping a
// single source of truth means the preview number the trader sees while
// editing matches the authoritative total returned on Save.
// -----------------------------------------------------------------------------

function previewStateSalesTax(state: string | null): number {
  if (!state) return 0;
  const key = state.trim().toUpperCase();
  return STATE_SALES_TAX[key] ?? 0;
}

// -----------------------------------------------------------------------------
// Rounding
// -----------------------------------------------------------------------------

function r2(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}
function r4(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10_000) / 10_000;
}

// -----------------------------------------------------------------------------
// Formatters
// -----------------------------------------------------------------------------

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const USD_COMPACT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const UNIT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

// -----------------------------------------------------------------------------
// Preview computation (client-side mirror of pricingAgent math)
// -----------------------------------------------------------------------------

interface PreviewLine {
  lineItemId: string;
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number;
  unit: 'PCS' | 'MBF' | 'MSF';
  buildingTag: string | null;
  phaseNumber: number | null;
  commodityGroup: string;
  vendorId: string;
  hasSelection: boolean;
  costUnitPrice: number;
  costTotalPrice: number;
  marginPercent: number;
  sellUnitPrice: number;
  extendedSell: number;
  appliedInstructionIndex: number;
}

interface PreviewTotals {
  totalCost: number;
  totalSell: number;
  marginDollars: number;
  blendedMarginPercent: number;
  lumberTax: number;
  salesTax: number;
  grandTotal: number;
}

interface PreviewResult {
  lines: PreviewLine[];
  totals: PreviewTotals;
  unresolvedLineItemIds: string[];
  needsApproval: boolean;
  belowMinimumMargin: boolean;
}

function computePreview(params: {
  lines: MarginStackLine[];
  selectionByLine: Map<string, PricingSelection>;
  marginInstructions: MarginInstruction[];
  jobState: string | null;
  approvalThresholdDollars: number;
  minMarginPercent: number;
}): PreviewResult {
  const {
    lines,
    selectionByLine,
    marginInstructions,
    jobState,
    approvalThresholdDollars,
    minMarginPercent,
  } = params;

  const state = (jobState ?? '').trim().toUpperCase();
  const salesRate = state ? previewStateSalesTax(state) : 0;
  const lumberRate = state === 'CA' ? CA_LUMBER_ASSESSMENT : 0;

  const sorted = [...lines].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    const at = a.buildingTag ?? '';
    const bt = b.buildingTag ?? '';
    if (at !== bt) return at < bt ? -1 : 1;
    if (a.lineItemId !== b.lineItemId) return a.lineItemId < b.lineItemId ? -1 : 1;
    return 0;
  });

  const previewLines: PreviewLine[] = [];
  const unresolved: string[] = [];
  let totalCost = 0;
  let totalSell = 0;

  for (const line of sorted) {
    const sel = selectionByLine.get(line.lineItemId);
    const group = commodityGroupFor(line.species);
    if (!sel) {
      unresolved.push(line.lineItemId);
      previewLines.push({
        lineItemId: line.lineItemId,
        species: line.species,
        dimension: line.dimension,
        grade: line.grade,
        length: line.length,
        quantity: line.quantity,
        unit: line.unit,
        buildingTag: line.buildingTag,
        phaseNumber: line.phaseNumber,
        commodityGroup: group,
        vendorId: '',
        hasSelection: false,
        costUnitPrice: 0,
        costTotalPrice: 0,
        marginPercent: 0,
        sellUnitPrice: 0,
        extendedSell: 0,
        appliedInstructionIndex: -1,
      });
      continue;
    }

    let appliedIdx = -1;
    let appliedType: MarginType | null = null;
    let appliedValue = 0;

    for (let i = 0; i < marginInstructions.length; i += 1) {
      const inst = marginInstructions[i]!;
      let matches = false;
      if (inst.scope === 'all') matches = true;
      else if (inst.scope === 'commodity')
        matches = inst.targetId !== null && inst.targetId === group;
      else if (inst.scope === 'line')
        matches = inst.targetId !== null && inst.targetId === line.lineItemId;
      if (matches) {
        appliedIdx = i;
        appliedType = inst.marginType;
        appliedValue = inst.marginValue;
      }
    }

    let marginPercent = 0;
    let sellUnitPrice = sel.costUnitPrice;
    if (appliedIdx !== -1 && appliedType !== null) {
      if (appliedType === 'percent') {
        marginPercent = appliedValue;
        sellUnitPrice = sel.costUnitPrice * (1 + appliedValue);
      } else {
        sellUnitPrice = sel.costUnitPrice + appliedValue;
        marginPercent =
          sel.costUnitPrice === 0 ? 0 : appliedValue / sel.costUnitPrice;
      }
    }

    const extendedSell = sellUnitPrice * line.quantity;
    totalCost += sel.costTotalPrice;
    totalSell += extendedSell;

    previewLines.push({
      lineItemId: line.lineItemId,
      species: line.species,
      dimension: line.dimension,
      grade: line.grade,
      length: line.length,
      quantity: line.quantity,
      unit: line.unit,
      buildingTag: line.buildingTag,
      phaseNumber: line.phaseNumber,
      commodityGroup: group,
      vendorId: sel.vendorId,
      hasSelection: true,
      costUnitPrice: r2(sel.costUnitPrice),
      costTotalPrice: r2(sel.costTotalPrice),
      marginPercent: r4(marginPercent),
      sellUnitPrice: r2(sellUnitPrice),
      extendedSell: r2(extendedSell),
      appliedInstructionIndex: appliedIdx,
    });
  }

  const totalCostR = r2(totalCost);
  const totalSellR = r2(totalSell);
  const marginDollars = r2(totalSellR - totalCostR);
  const blendedMarginPercent =
    totalSellR > 0 ? r4(marginDollars / totalSellR) : 0;
  const lumberTax = r2(totalSellR * lumberRate);
  const salesTax = r2(totalSellR * salesRate);
  const grandTotal = r2(totalSellR + lumberTax + salesTax);

  return {
    lines: previewLines,
    totals: {
      totalCost: totalCostR,
      totalSell: totalSellR,
      marginDollars,
      blendedMarginPercent,
      lumberTax,
      salesTax,
      grandTotal,
    },
    unresolvedLineItemIds: unresolved,
    needsApproval: grandTotal > approvalThresholdDollars,
    belowMinimumMargin: blendedMarginPercent < minMarginPercent,
  };
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

export function MarginStack({
  bidId: _bidId,
  initialSelections,
  lines,
  settings,
  jobState,
  consolidationMode,
  isManager,
  vendorNameByVendorId,
  onSave,
}: MarginStackProps) {
  // --- Selection lookup is fixed per component instance --------------------
  const selectionByLine = React.useMemo(() => {
    const m = new Map<string, PricingSelection>();
    for (const s of initialSelections) m.set(s.lineItemId, s);
    return m;
  }, [initialSelections]);

  // --- Margin instruction stack (bulk pushes + per-line overrides) ---------
  // Wrapping setInstructions in a helper so every mutation auto-flips
  // `pristineSinceSave` → false (see below). Keeps the two state slices in
  // sync without spraying extra calls across every control.
  const [instructions, setInstructionsState] = React.useState<
    MarginInstruction[]
  >([]);

  // --- Bulk-panel client state ---------------------------------------------
  const [activeScopeId, setActiveScopeId] = React.useState<string>('All');
  const [marginMode, setMarginMode] = React.useState<MarginType>('percent');
  const [customValue, setCustomValue] = React.useState<string>('');

  // --- Save / submit busy states -------------------------------------------
  const [savingAction, setSavingAction] = React.useState<
    null | 'draft' | 'submit_for_approval'
  >(null);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [savedQuoteStatus, setSavedQuoteStatus] = React.useState<string | null>(
    null,
  );

  // --- Authoritative server result (populated on successful save) ----------
  // The client preview is always recomputed live for immediate feedback while
  // the trader is editing, but the right-side summary swaps to the server's
  // PricingResult once a Save has succeeded *and* no margin mutation has
  // happened since. That's the "pristineSinceSave" flag — it flips false on
  // any margin edit and back to true on every successful save. This means
  // the trader never leaves the page believing the client-estimated total
  // is the authoritative number.
  const [savedPricing, setSavedPricing] = React.useState<PricingResult | null>(
    null,
  );
  const [pristineSinceSave, setPristineSinceSave] =
    React.useState<boolean>(false);

  // Every margin mutation goes through this helper so the "unsaved changes"
  // state flips automatically; the caller never needs to remember.
  const setInstructions = React.useCallback(
    (updater: React.SetStateAction<MarginInstruction[]>) => {
      setInstructionsState(updater);
      setPristineSinceSave(false);
    },
    [],
  );

  // --- Derived preview (re-computed on every state change; cheap) ----------
  const preview = React.useMemo(
    () =>
      computePreview({
        lines,
        selectionByLine,
        marginInstructions: instructions,
        jobState,
        approvalThresholdDollars: settings.approvalThresholdDollars,
        minMarginPercent: settings.minMarginPercent,
      }),
    [
      lines,
      selectionByLine,
      instructions,
      jobState,
      settings.approvalThresholdDollars,
      settings.minMarginPercent,
    ],
  );

  // --- Bulk controls -------------------------------------------------------
  const pushBulkInstruction = React.useCallback(
    (marginType: MarginType, marginValue: number) => {
      const scope: MarginScope = activeScopeId === 'All' ? 'all' : 'commodity';
      const targetId: string | null =
        activeScopeId === 'All' ? null : activeScopeId;
      setInstructions((prev) => [
        ...prev,
        { scope, targetId, marginType, marginValue },
      ]);
    },
    [activeScopeId],
  );

  const applyPreset = React.useCallback(
    (fraction: number) => {
      pushBulkInstruction(marginMode, fraction);
    },
    [marginMode, pushBulkInstruction],
  );

  const applyCustom = React.useCallback(() => {
    const raw = Number(customValue);
    if (!Number.isFinite(raw) || raw === 0) return;
    // Percent inputs are typed as "15" meaning 15% — convert to 0.15.
    // Dollar inputs are a flat $/unit (e.g. 0.50).
    const value = marginMode === 'percent' ? raw / 100 : raw;
    pushBulkInstruction(marginMode, value);
    setCustomValue('');
  }, [customValue, marginMode, pushBulkInstruction]);

  const clearAllMargin = React.useCallback(() => {
    setInstructions([]);
  }, []);

  // --- Per-line margin override --------------------------------------------
  const setLineMargin = React.useCallback(
    (lineItemId: string, percentFraction: number | null) => {
      setInstructions((prev) => {
        // If clearing, filter existing line-scoped instruction for this line.
        if (percentFraction === null) {
          return prev.filter(
            (i) => !(i.scope === 'line' && i.targetId === lineItemId),
          );
        }
        return [
          ...prev,
          {
            scope: 'line',
            targetId: lineItemId,
            marginType: 'percent',
            marginValue: percentFraction,
          },
        ];
      });
    },
    [],
  );

  // --- Keyboard handling for the bulk custom input -------------------------
  const handleCustomKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyCustom();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setActiveScopeId('All');
        setCustomValue('');
      }
    },
    [applyCustom],
  );

  // --- Save handlers -------------------------------------------------------
  const handleSave = React.useCallback(
    async (action: 'draft' | 'submit_for_approval') => {
      setSavingAction(action);
      setServerError(null);
      try {
        const result = await onSave(action, instructions);
        setSavedQuoteStatus(result.quote.status);
        // Replace the displayed summary with the server-authoritative
        // PricingResult and flip pristineSinceSave → true so the right
        // panel renders "Saved totals" instead of the client estimate.
        setSavedPricing(result.pricing);
        setPristineSinceSave(true);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Save failed';
        setServerError(message);
      } finally {
        setSavingAction(null);
      }
    },
    [instructions, onSave],
  );

  // --- Summary copy --------------------------------------------------------
  // Data-source resolution: if we have a saved PricingResult *and* no edits
  // have happened since the save, render the server numbers. Otherwise fall
  // back to the client preview (either initial state or dirty state).
  type TotalsSource = 'saved' | 'dirty' | 'estimated';
  const totalsSource: TotalsSource =
    savedPricing && pristineSinceSave
      ? 'saved'
      : savedPricing
        ? 'dirty'
        : 'estimated';

  const displayTotals =
    totalsSource === 'saved' ? savedPricing!.totals : preview.totals;
  const grandAboveThreshold =
    totalsSource === 'saved'
      ? savedPricing!.flags.needsApproval
      : preview.needsApproval;
  const grandTotal = displayTotals.grandTotal;
  const blended = displayTotals.blendedMarginPercent;
  const minMargin = settings.minMarginPercent;

  // Three-tier health indicator: green > min + 0.02, red < min, yellow in between.
  const healthTier: 'ok' | 'warn' | 'error' =
    blended > minMargin + 0.02
      ? 'ok'
      : blended < minMargin
        ? 'error'
        : 'warn';

  // --- Render --------------------------------------------------------------
  return (
    <div className="flex flex-col gap-4">
      {/* Header ----------------------------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-h2 text-text-primary">Margin Stack</h2>
          <p className="mt-1 text-caption text-text-tertiary">
            Layer bulk margin on all or a commodity group, override per line
            when needed. Totals recompute live; Save persists.{' '}
            <span className="text-text-secondary">
              Mode: {consolidationMode}
            </span>
            {jobState && (
              <>
                {' · '}
                <span className="text-text-secondary">Job state: {jobState}</span>
              </>
            )}
          </p>
        </div>
        <div
          role="note"
          aria-label="Internal only — vendor costs and margin percent never appear on the customer PDF"
          className="inline-flex items-center gap-2 rounded-pill border border-[rgba(184,122,29,0.3)] bg-[rgba(184,122,29,0.1)] px-3 py-1 text-label uppercase text-semantic-warning"
        >
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
          Internal only — costs + vendor context
        </div>
      </div>

      {/* Three-column layout --------------------------------------------- */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[320px_minmax(0,1fr)_340px]">
        {/* Left panel — bulk controls ----------------------------------- */}
        <aside className="flex flex-col gap-4 self-start rounded-md border border-border-base bg-bg-surface p-4 shadow-sm xl:sticky xl:top-4">
          <div>
            <div className="mb-2 text-label uppercase text-text-tertiary">
              Apply to
            </div>
            <div className="flex flex-wrap gap-1.5">
              {COMMODITY_GROUPS.map((g) => {
                const active = activeScopeId === g.id;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setActiveScopeId(g.id)}
                    aria-pressed={active}
                    className={cn(
                      'rounded-pill px-3 py-1 text-label uppercase transition-colors duration-micro',
                      'focus-visible:outline-none focus-visible:shadow-accent',
                      active
                        ? 'bg-[rgba(29,184,122,0.15)] text-accent-primary ring-1 ring-inset ring-[rgba(29,184,122,0.4)]'
                        : 'bg-bg-subtle text-text-secondary hover:bg-bg-elevated hover:text-text-primary',
                    )}
                  >
                    {g.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="mb-2 text-label uppercase text-text-tertiary">
              Mode
            </div>
            <div className="inline-flex overflow-hidden rounded-sm border border-border-base">
              <button
                type="button"
                onClick={() => setMarginMode('percent')}
                aria-pressed={marginMode === 'percent'}
                className={cn(
                  'px-3 py-1.5 text-body-sm transition-colors duration-micro focus-visible:outline-none focus-visible:shadow-accent',
                  marginMode === 'percent'
                    ? 'bg-accent-primary text-text-inverse'
                    : 'bg-transparent text-text-secondary hover:bg-bg-subtle',
                )}
              >
                <Percent className="-mt-0.5 mr-1 inline h-3 w-3" aria-hidden="true" />
                Percent
              </button>
              <button
                type="button"
                onClick={() => setMarginMode('dollar')}
                aria-pressed={marginMode === 'dollar'}
                className={cn(
                  'border-l border-border-base px-3 py-1.5 text-body-sm transition-colors duration-micro focus-visible:outline-none focus-visible:shadow-accent',
                  marginMode === 'dollar'
                    ? 'bg-accent-primary text-text-inverse'
                    : 'bg-transparent text-text-secondary hover:bg-bg-subtle',
                )}
              >
                $/unit
              </button>
            </div>
          </div>

          <div>
            <div className="mb-2 text-label uppercase text-text-tertiary">
              Presets
            </div>
            <div className="flex flex-wrap gap-1.5">
              {settings.marginPresets.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => applyPreset(marginMode === 'dollar' ? p : p)}
                  className="rounded-sm border border-border-base bg-bg-subtle px-3 py-1.5 font-mono text-body-sm tabular-nums text-text-primary transition-colors duration-micro hover:bg-bg-elevated focus-visible:outline-none focus-visible:shadow-accent"
                  aria-label={`Apply ${marginMode === 'percent' ? `${(p * 100).toFixed(0)}%` : `$${p.toFixed(2)}/unit`} to ${activeScopeId}`}
                >
                  {marginMode === 'percent'
                    ? `${(p * 100).toFixed(0)}%`
                    : `$${p.toFixed(2)}`}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label
              htmlFor="margin-stack-custom"
              className="mb-2 block text-label uppercase text-text-tertiary"
            >
              Custom
            </label>
            <div className="flex gap-1.5">
              <input
                id="margin-stack-custom"
                type="number"
                step={marginMode === 'percent' ? '0.5' : '0.01'}
                inputMode="decimal"
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
                onKeyDown={handleCustomKeyDown}
                placeholder={marginMode === 'percent' ? '15' : '0.50'}
                className="h-9 w-full rounded-sm border border-border-base bg-bg-subtle px-3 font-mono text-body tabular-nums text-text-primary placeholder:text-text-tertiary focus:border-accent-primary focus:shadow-accent focus:outline-none"
                aria-label={`Custom margin (${marginMode === 'percent' ? 'percent' : 'dollars per unit'})`}
              />
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={applyCustom}
                disabled={!customValue}
              >
                Apply
              </Button>
            </div>
            <p className="mt-1 text-caption text-text-tertiary">
              Enter 15 for 15% · Esc clears scope
            </p>
          </div>

          <div className="border-t border-border-subtle pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearAllMargin}
              disabled={instructions.length === 0}
              className="w-full"
            >
              <Eraser className="h-3.5 w-3.5" aria-hidden="true" />
              Clear all margin ({instructions.length})
            </Button>
          </div>
        </aside>

        {/* Main panel — line table ------------------------------------- */}
        <section className="min-w-0">
          <MarginLineTable
            previewLines={preview.lines}
            minMarginPercent={minMargin}
            vendorNameByVendorId={vendorNameByVendorId}
            onSetLineMargin={setLineMargin}
            unresolvedLineItemIds={preview.unresolvedLineItemIds}
          />
        </section>

        {/* Right panel — summary --------------------------------------- */}
        <aside className="flex flex-col gap-4 self-start rounded-md border border-border-base bg-bg-surface p-4 shadow-sm xl:sticky xl:top-4">
          <div>
            <div className="flex items-center justify-between gap-2">
              <div className="text-label uppercase text-text-tertiary">
                Grand total
              </div>
              <TotalsSourceChip source={totalsSource} />
            </div>
            <div className="mt-1 font-mono text-[28px] font-semibold leading-none tabular-nums text-text-primary">
              {USD.format(grandTotal)}
            </div>
          </div>

          <SummaryRow
            label="Subtotal (sell)"
            value={USD.format(displayTotals.totalSell)}
          />
          <SummaryRow
            label="Cost (internal)"
            value={USD.format(displayTotals.totalCost)}
            tone="secondary"
          />
          <SummaryRow
            label="Margin $"
            value={USD.format(displayTotals.marginDollars)}
            tone="warm"
          />
          <SummaryRow
            label="Blended margin %"
            value={formatPercent(blended)}
            tone={healthTier === 'ok' ? 'accent' : healthTier === 'warn' ? 'warn' : 'error'}
          />
          <SummaryRow
            label="Lumber assessment"
            value={USD.format(displayTotals.lumberTax)}
            tone="tertiary"
          />
          <SummaryRow
            label="Sales tax"
            value={USD.format(displayTotals.salesTax)}
            tone="tertiary"
          />

          <div className="border-t border-border-subtle pt-3">
            <HealthIndicator
              tier={healthTier}
              blended={blended}
              minMargin={minMargin}
            />
          </div>

          {preview.unresolvedLineItemIds.length > 0 && (
            <div
              role="alert"
              className="rounded-sm border border-[rgba(192,57,43,0.4)] bg-[rgba(192,57,43,0.08)] px-3 py-2 text-caption text-semantic-error"
            >
              {preview.unresolvedLineItemIds.length} line
              {preview.unresolvedLineItemIds.length === 1 ? '' : 's'} without a
              vendor selection — go back to comparison and pick a vendor for
              each line.
            </div>
          )}

          {grandAboveThreshold && (
            <div
              role="status"
              className="inline-flex items-center gap-2 rounded-sm border border-[rgba(184,122,29,0.4)] bg-[rgba(184,122,29,0.1)] px-3 py-2 text-caption text-semantic-warning"
            >
              <ShieldAlert className="h-4 w-4" aria-hidden="true" />
              Above {USD_COMPACT.format(settings.approvalThresholdDollars)} —
              requires manager approval
            </div>
          )}

          {serverError && (
            <div
              role="alert"
              className="rounded-sm border border-[rgba(192,57,43,0.4)] bg-[rgba(192,57,43,0.08)] px-3 py-2 text-caption text-semantic-error"
            >
              {serverError}
            </div>
          )}

          {savedQuoteStatus && (
            <div
              role="status"
              className="inline-flex items-center gap-2 rounded-sm border border-[rgba(29,184,122,0.4)] bg-[rgba(29,184,122,0.1)] px-3 py-2 text-caption text-accent-primary"
            >
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              Saved — quote status:{' '}
              <span className="font-mono tabular-nums text-text-primary">
                {savedQuoteStatus}
              </span>
            </div>
          )}

          <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => handleSave('draft')}
              loading={savingAction === 'draft'}
              disabled={
                savingAction !== null ||
                preview.unresolvedLineItemIds.length === lines.length
              }
            >
              <Save className="h-4 w-4" aria-hidden="true" />
              Save as draft
            </Button>

            {(preview.needsApproval || preview.belowMinimumMargin) && !isManager && (
              <Button
                type="button"
                variant="primary"
                onClick={() => handleSave('submit_for_approval')}
                loading={savingAction === 'submit_for_approval'}
                disabled={
                  savingAction !== null ||
                  preview.unresolvedLineItemIds.length > 0
                }
              >
                <Send className="h-4 w-4" aria-hidden="true" />
                Submit for approval
              </Button>
            )}

            {isManager && (
              <Button
                type="button"
                variant="primary"
                onClick={() => handleSave('submit_for_approval')}
                loading={savingAction === 'submit_for_approval'}
                disabled={
                  savingAction !== null ||
                  preview.unresolvedLineItemIds.length > 0
                }
              >
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                {preview.needsApproval ? 'Approve & submit' : 'Save as approved'}
              </Button>
            )}

            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                if (typeof window !== 'undefined') {
                  window.location.href = `/bids/${_bidId}/quote`;
                }
              }}
              disabled={savingAction !== null}
            >
              <FileText className="h-4 w-4" aria-hidden="true" />
              View quote preview
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Totals source chip
// -----------------------------------------------------------------------------

/**
 * Tiny visual indicator next to the grand total that tells the trader where
 * the number came from: client-side estimate, server-authoritative saved
 * result, or server result now stale because the margin stack was edited
 * after save. Prevents the trader walking away thinking the client preview
 * is the ground truth.
 */
function TotalsSourceChip({
  source,
}: {
  source: 'estimated' | 'saved' | 'dirty';
}) {
  if (source === 'saved') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-pill border border-[rgba(29,184,122,0.4)] bg-[rgba(29,184,122,0.1)] px-2 py-0.5 text-label uppercase text-accent-primary"
        aria-label="Totals are the server-authoritative saved values"
      >
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        Saved totals
      </span>
    );
  }
  if (source === 'dirty') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-pill border border-[rgba(184,122,29,0.4)] bg-[rgba(184,122,29,0.1)] px-2 py-0.5 text-label uppercase text-semantic-warning"
        aria-label="Margin edited after save — totals below are re-estimated client-side; save to refresh"
      >
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        Estimated (unsaved changes)
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-pill border border-border-base bg-bg-subtle px-2 py-0.5 text-label uppercase text-text-tertiary"
      aria-label="Totals are client-side estimates; save for authoritative numbers"
    >
      Estimated totals
    </span>
  );
}

// -----------------------------------------------------------------------------
// Summary row
// -----------------------------------------------------------------------------

function SummaryRow({
  label,
  value,
  tone = 'primary',
}: {
  label: string;
  value: string;
  tone?: 'primary' | 'secondary' | 'tertiary' | 'warm' | 'accent' | 'warn' | 'error';
}) {
  const toneClass =
    tone === 'secondary'
      ? 'text-text-secondary'
      : tone === 'tertiary'
        ? 'text-text-tertiary'
        : tone === 'warm'
          ? 'text-accent-warm'
          : tone === 'accent'
            ? 'text-accent-primary'
            : tone === 'warn'
              ? 'text-semantic-warning'
              : tone === 'error'
                ? 'text-semantic-error'
                : 'text-text-primary';
  return (
    <div className="flex items-center justify-between">
      <span className="text-caption text-text-tertiary">{label}</span>
      <span className={cn('font-mono text-body tabular-nums', toneClass)}>
        {value}
      </span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Health indicator
// -----------------------------------------------------------------------------

function HealthIndicator({
  tier,
  blended,
  minMargin,
}: {
  tier: 'ok' | 'warn' | 'error';
  blended: number;
  minMargin: number;
}) {
  const Icon =
    tier === 'ok' ? TrendingUp : tier === 'error' ? TrendingDown : AlertTriangle;
  const label =
    tier === 'ok'
      ? 'Blended margin above floor'
      : tier === 'warn'
        ? 'Blended margin within 2% of floor'
        : 'Blended margin below floor — override required';
  const tone =
    tier === 'ok'
      ? 'text-accent-primary'
      : tier === 'warn'
        ? 'text-semantic-warning'
        : 'text-semantic-error';
  const bg =
    tier === 'ok'
      ? 'bg-[rgba(29,184,122,0.08)] border-[rgba(29,184,122,0.35)]'
      : tier === 'warn'
        ? 'bg-[rgba(184,122,29,0.08)] border-[rgba(184,122,29,0.4)]'
        : 'bg-[rgba(192,57,43,0.08)] border-[rgba(192,57,43,0.4)]';
  return (
    <div
      role="status"
      aria-label={label}
      title={label}
      className={cn(
        'flex items-start gap-2 rounded-sm border px-3 py-2',
        bg,
      )}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone)} aria-hidden="true" />
      <div className="flex flex-col">
        <span className={cn('text-label uppercase', tone)}>{label}</span>
        <span className="mt-0.5 font-mono text-caption tabular-nums text-text-secondary">
          {formatPercent(blended)} · floor {formatPercent(minMargin)}
        </span>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Line table
// -----------------------------------------------------------------------------

interface MarginLineTableProps {
  previewLines: PreviewLine[];
  minMarginPercent: number;
  vendorNameByVendorId: Record<string, string> | undefined;
  onSetLineMargin: (lineItemId: string, percentFraction: number | null) => void;
  unresolvedLineItemIds: string[];
}

function MarginLineTable({
  previewLines,
  minMarginPercent,
  vendorNameByVendorId,
  onSetLineMargin,
  unresolvedLineItemIds,
}: MarginLineTableProps) {
  const unresolvedSet = React.useMemo(
    () => new Set(unresolvedLineItemIds),
    [unresolvedLineItemIds],
  );

  const grouped = React.useMemo(() => {
    type Group = {
      key: string;
      buildingTag: string | null;
      phaseNumber: number | null;
      rows: PreviewLine[];
    };
    const map = new Map<string, Group>();
    for (const l of previewLines) {
      const key = `${l.buildingTag ?? ''}::${l.phaseNumber ?? ''}`;
      const bucket = map.get(key);
      if (bucket) bucket.rows.push(l);
      else
        map.set(key, {
          key,
          buildingTag: l.buildingTag,
          phaseNumber: l.phaseNumber,
          rows: [l],
        });
    }
    return Array.from(map.values());
  }, [previewLines]);

  return (
    <div className="overflow-hidden rounded-md border border-border-base bg-bg-surface shadow-sm">
      <div className="max-h-[70vh] overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-body-sm">
          <thead className="sticky top-0 z-20">
            <tr className="bg-bg-surface">
              <Th align="left">Line</Th>
              <Th align="right" className="w-20">
                Qty
              </Th>
              <Th align="right" className="w-24">
                Cost / u
              </Th>
              <Th align="right" className="w-28">
                Cost total
              </Th>
              <Th align="right" className="w-24">
                Margin %
              </Th>
              <Th align="right" className="w-24">
                Sell / u
              </Th>
              <Th align="right" className="w-28">
                Extended sell
              </Th>
              <Th align="left" className="w-36">
                Vendor
              </Th>
            </tr>
          </thead>
          <tbody>
            {grouped.map((group) => (
              <React.Fragment key={group.key}>
                <tr>
                  <td
                    colSpan={8}
                    className="border-b border-border-base bg-bg-surface px-3 py-2"
                  >
                    <div className="flex items-center gap-3 border-l-[3px] border-accent-primary pl-3">
                      <Layers
                        className="h-3.5 w-3.5 text-accent-primary"
                        aria-hidden="true"
                      />
                      <span className="text-h4 text-text-primary">
                        {group.buildingTag ?? 'Ungrouped'}
                      </span>
                      {group.phaseNumber !== null && (
                        <span className="text-label uppercase text-text-tertiary">
                          Phase {group.phaseNumber}
                        </span>
                      )}
                      <span className="ml-auto text-caption text-text-tertiary">
                        <span className="font-mono tabular-nums text-text-secondary">
                          {group.rows.length}
                        </span>{' '}
                        line{group.rows.length === 1 ? '' : 's'}
                      </span>
                    </div>
                  </td>
                </tr>
                {group.rows.map((row) => {
                  const belowFloor =
                    row.hasSelection && row.marginPercent < minMarginPercent;
                  return (
                    <MarginLineRow
                      key={row.lineItemId}
                      row={row}
                      belowFloor={belowFloor}
                      unresolved={unresolvedSet.has(row.lineItemId)}
                      vendorName={
                        vendorNameByVendorId?.[row.vendorId] ?? null
                      }
                      onSetLineMargin={onSetLineMargin}
                    />
                  );
                })}
              </React.Fragment>
            ))}
            {previewLines.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-6 py-16 text-center text-body-sm text-text-tertiary"
                >
                  No selections — return to comparison and export.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
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

// -----------------------------------------------------------------------------
// Line row
// -----------------------------------------------------------------------------

interface MarginLineRowProps {
  row: PreviewLine;
  belowFloor: boolean;
  unresolved: boolean;
  vendorName: string | null;
  onSetLineMargin: (lineItemId: string, percentFraction: number | null) => void;
}

const MarginLineRow = React.memo(function MarginLineRow({
  row,
  belowFloor,
  unresolved,
  vendorName,
  onSetLineMargin,
}: MarginLineRowProps) {
  // Local input state so typing feels snappy; commit on blur / Enter.
  // Initialize from the current preview margin (% × 100 as string). When
  // the row's margin changes externally (bulk preset click) keep the
  // input in sync.
  const currentPercent = row.hasSelection
    ? (row.marginPercent * 100).toFixed(2)
    : '';
  const [local, setLocal] = React.useState(currentPercent);
  const lastSyncedRef = React.useRef(currentPercent);
  React.useEffect(() => {
    if (lastSyncedRef.current !== currentPercent) {
      setLocal(currentPercent);
      lastSyncedRef.current = currentPercent;
    }
  }, [currentPercent]);

  const commit = () => {
    const trimmed = local.trim();
    if (trimmed === '') {
      onSetLineMargin(row.lineItemId, null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    onSetLineMargin(row.lineItemId, n / 100);
  };

  const descriptionTop = `${row.species} · ${row.dimension}`;
  const descriptionBottom: string[] = [];
  if (row.grade) descriptionBottom.push(row.grade);
  if (row.length) descriptionBottom.push(`${row.length} ft`);

  return (
    <tr
      className={cn(
        'group transition-colors duration-micro hover:bg-bg-subtle',
        belowFloor && 'border-l-[3px] border-l-semantic-error',
        unresolved && 'bg-[rgba(192,57,43,0.04)]',
      )}
    >
      <td className="border-b border-border-subtle px-3 py-2">
        <div className="flex flex-col">
          <span className="font-mono text-body-sm text-text-primary">
            {descriptionTop}
          </span>
          <span className="text-caption text-text-tertiary">
            {descriptionBottom.join(' · ') || '—'}
          </span>
        </div>
      </td>
      <td className="border-b border-border-subtle px-3 py-2 text-right font-mono tabular-nums text-body-sm text-text-secondary">
        {row.quantity.toLocaleString()}{' '}
        <span className="text-text-tertiary">{row.unit}</span>
      </td>
      <td className="border-b border-border-subtle px-3 py-2 text-right font-mono tabular-nums text-body-sm text-text-primary">
        {row.hasSelection ? UNIT.format(row.costUnitPrice) : '—'}
      </td>
      <td className="border-b border-border-subtle px-3 py-2 text-right font-mono tabular-nums text-body-sm text-text-secondary">
        {row.hasSelection ? USD.format(row.costTotalPrice) : '—'}
      </td>
      <td className="border-b border-border-subtle px-2 py-2 text-right">
        <input
          type="number"
          step="0.25"
          inputMode="decimal"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          disabled={!row.hasSelection}
          placeholder="—"
          aria-label={`Margin percent for ${row.species} ${row.dimension}`}
          className={cn(
            'block h-7 w-full rounded-sm border border-transparent bg-transparent px-1 text-right font-mono text-body-sm tabular-nums text-text-primary',
            'transition-colors duration-micro hover:border-border-base focus:border-accent-primary focus:shadow-accent focus:outline-none',
            belowFloor && 'text-semantic-error',
            !row.hasSelection && 'cursor-not-allowed text-text-tertiary',
          )}
        />
      </td>
      <td className="border-b border-border-subtle px-3 py-2 text-right font-mono tabular-nums text-body-sm text-text-primary">
        {row.hasSelection ? UNIT.format(row.sellUnitPrice) : '—'}
      </td>
      <td className="border-b border-border-subtle px-3 py-2 text-right font-mono tabular-nums text-body-sm text-text-primary">
        {row.hasSelection ? USD.format(row.extendedSell) : '—'}
      </td>
      <td className="border-b border-border-subtle px-3 py-2">
        {row.hasSelection ? (
          <div className="flex flex-col items-start gap-0.5">
            <span
              className="max-w-[10rem] truncate text-body-sm text-text-secondary"
              title={vendorName ?? row.vendorId}
            >
              {vendorName ?? row.vendorId.slice(0, 8)}
            </span>
            <span className="text-[10px] uppercase tracking-[0.04em] text-text-tertiary">
              Internal — not on PDF
            </span>
          </div>
        ) : (
          <span className="text-caption text-semantic-error">
            no vendor selected
          </span>
        )}
      </td>
    </tr>
  );
});
