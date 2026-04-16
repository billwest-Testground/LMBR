/**
 * VendorSelector — Buyer's dispatch-time multi-select.
 *
 * Purpose:  The surface a Buyer stands in front of right before firing a
 *           bid out to suppliers. Lists every active vendor in the tenant,
 *           ranks the primary-commodity/region shortlist above the rest
 *           via `preferredVendorsForRegion()` (Task 7), lets the Buyer
 *           toggle each vendor on/off, warns on min-order shortfalls per
 *           line item, and posts the final selection to
 *           POST /api/vendors/dispatch (Task 2).
 *
 *           Ranking rule: the UI is deliberately two-bucket. The top
 *           bucket ("Suggested") is the frozen id list returned by
 *           `preferredVendorsForRegion(region, commodities[0], vendors)`
 *           — rendered in that exact order so the Buyer sees the same
 *           priority the routing heuristic would have chosen. Every
 *           other active vendor in the tenant falls into a second
 *           ("Other vendors") block, alphabetical. We pick the first
 *           commodity in the bid's species list as the primary; a richer
 *           per-commodity UI is a later task.
 *
 *           Min-order warning: some vendors (typically mills) will not
 *           accept small orders. `min_order_mbf` is compared against
 *           every line item's `boardFeet` — any line under that floor
 *           surfaces a warning naming the vendor's threshold, the
 *           shortfall, and the specific line (species / dimension /
 *           length). We warn only; we don't block — the Buyer may still
 *           choose to send knowing the vendor will cherry-pick larger
 *           items from the tally.
 *
 *           Due-by defaults to "3 business days from now at 5pm local",
 *           which is the most common quote validity window for wholesale
 *           lumber. The Buyer can override before dispatching.
 *
 * Inputs:   VendorSelectorProps.
 * Outputs:  JSX (form-shaped — checkboxes, due-by picker, submit).
 * Agent/API: GET /api/vendors, POST /api/vendors/dispatch.
 * Imports:  @lmbr/types, @lmbr/config, lucide-react, ../../ui/button, cn.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { AlertTriangle, MapPin, Send } from 'lucide-react';

import {
  preferredVendorsForRegion,
  type PreferredVendorCandidate,
  type RegionId,
} from '@lmbr/config';
import type { Vendor } from '@lmbr/types';

import { Button } from '../ui/button';
import { cn } from '../../lib/cn';

export interface VendorSelectorBidLineItem {
  lineItemId: string;
  quantity: number;
  unit: string; // 'PCS' | 'MBF' | 'MSF'
  boardFeet: number | null;
  species: string;
  dimension: string;
  length?: string | null;
}

export interface VendorSelectorDispatchResult {
  dispatched: Array<{ vendorId: string; vendorName: string }>;
  skipped: unknown[];
}

export interface VendorSelectorProps {
  bidId: string;
  region: RegionId | null;
  commodities: string[];
  bidLineItems: VendorSelectorBidLineItem[];
  onDispatchSuccess?: (result: VendorSelectorDispatchResult) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Default due-by — 3 business days from now at 17:00 local time. Returns a
 * `datetime-local`-shaped string (yyyy-MM-ddTHH:mm) so the input can load
 * with the value pre-selected. 72 hours is the floor guaranteed by the
 * task spec ("at least 72 hours"); 3 business days overshoots that
 * comfortably without running past most quote validity windows.
 */
function defaultDueByLocal(now: Date = new Date()): string {
  const d = new Date(now);
  let added = 0;
  while (added < 3) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  d.setHours(17, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/**
 * Convert a `datetime-local` string back into an ISO timestamp. The
 * browser's local tz is baked in when new Date(...) parses the input —
 * that's fine; the dispatch route only checks that the result is in the
 * future, and storage is always UTC.
 */
function localDatetimeToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Flag matching CLAUDE.md's minimum-order convention (MBF → BF). */
function bfShortfall(
  boardFeet: number | null,
  minOrderMbf: number | null | undefined,
): number | null {
  if (!minOrderMbf || minOrderMbf <= 0) return null;
  if (boardFeet == null) return null;
  const minBf = minOrderMbf * 1000;
  if (boardFeet >= minBf) return null;
  return minBf - boardFeet;
}

/** One-line shortfall warning message for a vendor against every bid line. */
function collectMinOrderWarnings(
  vendor: Vendor,
  lines: VendorSelectorBidLineItem[],
): Array<{ lineItemId: string; message: string }> {
  if (!vendor.minOrderMbf || vendor.minOrderMbf <= 0) return [];
  const out: Array<{ lineItemId: string; message: string }> = [];
  for (const line of lines) {
    const shortfall = bfShortfall(line.boardFeet, vendor.minOrderMbf);
    if (shortfall == null) continue;
    const actualMbf = (line.boardFeet ?? 0) / 1000;
    const desc = [line.dimension, line.species, line.length ? `${line.length}-foot` : null]
      .filter(Boolean)
      .join(' ');
    out.push({
      lineItemId: line.lineItemId,
      message: `${vendor.name} min ${vendor.minOrderMbf} MBF — this line is ${actualMbf.toFixed(
        2,
      )} MBF (${desc})`,
    });
  }
  return out;
}

/** Narrow a full `Vendor` into the shape `preferredVendorsForRegion` takes. */
function toCandidate(v: Vendor): PreferredVendorCandidate {
  return {
    id: v.id,
    name: v.name,
    vendorType: v.vendorType,
    regions: v.regions,
    commodities: v.commodities,
    active: v.active,
    minOrderMbf: v.minOrderMbf,
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MinOrderWarningBlock({
  warnings,
}: {
  warnings: Array<{ lineItemId: string; message: string }>;
}) {
  if (warnings.length === 0) return null;
  return (
    <div
      role="alert"
      className="mt-2 space-y-1 rounded-sm border border-semantic-warning/30 bg-[rgba(232,168,50,0.08)] p-2 text-caption text-semantic-warning"
    >
      {warnings.slice(0, 4).map((w) => (
        <div key={w.lineItemId} className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{w.message}</span>
        </div>
      ))}
      {warnings.length > 4 && (
        <div className="pl-[18px] text-caption text-semantic-warning/80">
          +{warnings.length - 4} more line{warnings.length - 4 === 1 ? '' : 's'} below min order
        </div>
      )}
    </div>
  );
}

function VendorRow({
  vendor,
  checked,
  onToggle,
  warnings,
  suggested,
}: {
  vendor: Vendor;
  checked: boolean;
  onToggle: (id: string) => void;
  warnings: Array<{ lineItemId: string; message: string }>;
  suggested: boolean;
}) {
  const inputId = `vendor-${vendor.id}`;
  return (
    <div
      className={cn(
        'rounded-sm border p-3 transition-colors duration-micro',
        checked
          ? 'border-accent-primary bg-[rgba(29,184,122,0.06)]'
          : 'border-border-base bg-bg-surface hover:border-border-strong',
      )}
    >
      <label htmlFor={inputId} className="flex cursor-pointer items-start gap-3">
        <input
          id={inputId}
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(vendor.id)}
          className="mt-1 h-4 w-4 shrink-0 accent-accent-primary"
          aria-describedby={warnings.length > 0 ? `${inputId}-warnings` : undefined}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-body font-medium text-text-primary">{vendor.name}</span>
            <span className="rounded-pill border border-border-base bg-bg-elevated px-2 py-0.5 text-caption uppercase tracking-wider text-text-secondary">
              {vendor.vendorType}
            </span>
            {suggested && (
              <span className="rounded-pill border border-accent-primary/40 bg-[rgba(29,184,122,0.12)] px-2 py-0.5 text-caption uppercase tracking-wider text-accent-primary">
                Suggested
              </span>
            )}
            {vendor.minOrderMbf > 0 && (
              <span className="text-caption text-text-tertiary">
                min {vendor.minOrderMbf} MBF
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text-tertiary">
            {vendor.regions.length > 0 ? (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" aria-hidden="true" />
                {vendor.regions.join(', ')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-text-tertiary">
                <MapPin className="h-3 w-3" aria-hidden="true" />
                all regions
              </span>
            )}
            {vendor.commodities.length > 0 && (
              <span>{vendor.commodities.slice(0, 6).join(' · ')}</span>
            )}
          </div>
          {warnings.length > 0 && (
            <div id={`${inputId}-warnings`}>
              <MinOrderWarningBlock warnings={warnings} />
            </div>
          )}
        </div>
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function VendorSelector({
  bidId,
  region,
  commodities,
  bidLineItems,
  onDispatchSuccess,
}: VendorSelectorProps) {
  const [vendors, setVendors] = React.useState<Vendor[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [dueByLocal, setDueByLocal] = React.useState<string>(() => defaultDueByLocal());
  const [dispatching, setDispatching] = React.useState(false);
  const [dispatchError, setDispatchError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<VendorSelectorDispatchResult | null>(null);

  // Fetch vendors once. We don't narrow by commodity at the API level so the
  // buyer sees the full picture — we only re-rank the list client-side.
  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch('/api/vendors');
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err?.error ?? `Failed to load vendors (${res.status})`);
        }
        const data = (await res.json()) as { vendors: Vendor[] };
        if (cancelled) return;
        setVendors(data.vendors ?? []);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load vendors');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Build shortlist (Suggested) + leftover (Other) groups. We call
  // preferredVendorsForRegion() with the bid's primary commodity. Vendors
  // that don't match on that commodity fall into "Other".
  const { suggested, others } = React.useMemo(() => {
    const primary = commodities[0] ?? '';
    const candidates = vendors.map(toCandidate);
    const rankedIds = primary
      ? preferredVendorsForRegion(region, primary, candidates)
      : [];
    const byId = new Map(vendors.map((v) => [v.id, v]));
    const rankedSet = new Set(rankedIds);
    const suggestedList = rankedIds
      .map((id) => byId.get(id))
      .filter((v): v is Vendor => v != null);
    const othersList = vendors
      .filter((v) => !rankedSet.has(v.id))
      .sort((a, b) =>
        a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
      );
    return { suggested: suggestedList, others: othersList };
  }, [vendors, region, commodities]);

  const toggleVendor = React.useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const warningsByVendor = React.useMemo(() => {
    const m = new Map<string, Array<{ lineItemId: string; message: string }>>();
    for (const v of vendors) m.set(v.id, collectMinOrderWarnings(v, bidLineItems));
    return m;
  }, [vendors, bidLineItems]);

  const dueByValid = React.useMemo(() => {
    const iso = localDatetimeToIso(dueByLocal);
    if (!iso) return false;
    return new Date(iso).getTime() > Date.now();
  }, [dueByLocal]);

  const canDispatch = selectedIds.size > 0 && dueByValid && !dispatching;

  const handleDispatch = React.useCallback(async () => {
    setDispatching(true);
    setDispatchError(null);
    setResult(null);
    try {
      const iso = localDatetimeToIso(dueByLocal);
      if (!iso) {
        setDispatchError('Select a valid due-by datetime.');
        return;
      }
      const res = await fetch('/api/vendors/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bidId,
          vendorIds: [...selectedIds],
          dueBy: iso,
          submissionMethod: 'form',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDispatchError(data?.error ?? `Dispatch failed (${res.status})`);
        return;
      }
      const dispatched = (data?.dispatched ?? []) as Array<{
        vendorId: string;
        vendorName: string;
      }>;
      const skipped = (data?.skipped ?? []) as unknown[];
      const summary: VendorSelectorDispatchResult = { dispatched, skipped };
      setResult(summary);
      onDispatchSuccess?.(summary);
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : 'Dispatch failed');
    } finally {
      setDispatching(false);
    }
  }, [bidId, dueByLocal, onDispatchSuccess, selectedIds]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-md border border-border-base bg-bg-surface p-12">
        <p className="text-body-sm text-text-tertiary">Loading vendors…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-md border border-semantic-error/40 bg-[rgba(232,84,72,0.08)] p-4">
        <p className="text-body-sm text-semantic-error">{loadError}</p>
      </div>
    );
  }

  if (vendors.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border-base bg-bg-surface p-12 text-center">
        <h2 className="text-h3 text-text-primary">No vendors yet</h2>
        <p className="mt-1 text-body-sm text-text-secondary">
          Add vendors from the vendor roster before dispatching a bid.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header: bid context */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border-base bg-bg-surface px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-h3 tabular-nums text-text-primary">
            {selectedIds.size}
          </span>
          <span className="text-label uppercase tracking-wider text-text-tertiary">
            selected
          </span>
        </div>
        <span className="h-6 w-px bg-border-base" aria-hidden="true" />
        <span className="text-body-sm text-text-secondary">
          Region: <span className="text-text-primary">{region ?? 'wildcard'}</span>
        </span>
        <span className="text-body-sm text-text-secondary">
          Primary commodity:{' '}
          <span className="text-text-primary">{commodities[0] ?? '—'}</span>
        </span>
        <span className="text-body-sm text-text-secondary">
          Line items: <span className="text-text-primary">{bidLineItems.length}</span>
        </span>
      </div>

      {/* Suggested bucket */}
      {suggested.length > 0 && (
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-h4 text-text-primary">
              Suggested vendors ({suggested.length})
            </h2>
            <p className="text-caption text-text-tertiary">
              Ranked by region match + vendor type for {commodities[0] ?? '—'}
            </p>
          </div>
          <div className="space-y-2">
            {suggested.map((v) => (
              <VendorRow
                key={v.id}
                vendor={v}
                checked={selectedIds.has(v.id)}
                onToggle={toggleVendor}
                warnings={warningsByVendor.get(v.id) ?? []}
                suggested
              />
            ))}
          </div>
        </section>
      )}

      {/* Others bucket */}
      {others.length > 0 && (
        <section>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="text-h4 text-text-primary">
              Other vendors ({others.length})
            </h2>
            <p className="text-caption text-text-tertiary">
              All remaining active vendors in the tenant
            </p>
          </div>
          <div className="space-y-2">
            {others.map((v) => (
              <VendorRow
                key={v.id}
                vendor={v}
                checked={selectedIds.has(v.id)}
                onToggle={toggleVendor}
                warnings={warningsByVendor.get(v.id) ?? []}
                suggested={false}
              />
            ))}
          </div>
        </section>
      )}

      {/* Dispatch bar */}
      <div className="sticky bottom-4 z-10 rounded-md border border-border-strong bg-bg-elevated p-4 shadow-lg">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-[220px]">
            <label
              htmlFor="dispatch-due-by"
              className="block text-label uppercase tracking-wider text-text-tertiary"
            >
              Due by
            </label>
            <input
              id="dispatch-due-by"
              type="datetime-local"
              value={dueByLocal}
              onChange={(e) => setDueByLocal(e.target.value)}
              required
              className="mt-1 h-9 w-full rounded-sm border border-border-base bg-bg-surface px-3 text-body text-text-primary focus:border-accent-primary focus:outline-none focus:shadow-accent"
            />
            {!dueByValid && (
              <p className="mt-1 text-caption text-semantic-warning">
                Due-by must be a valid future datetime.
              </p>
            )}
          </div>
          <Button
            variant="primary"
            size="md"
            loading={dispatching}
            disabled={!canDispatch}
            onClick={handleDispatch}
            aria-busy={dispatching || undefined}
          >
            {!dispatching && <Send className="h-4 w-4" aria-hidden="true" />}
            {dispatching
              ? 'Dispatching…'
              : `Dispatch to ${selectedIds.size} vendor${selectedIds.size === 1 ? '' : 's'}`}
          </Button>
        </div>

        {dispatchError && (
          <div
            role="alert"
            className="mt-3 rounded-sm border border-semantic-error/40 bg-[rgba(232,84,72,0.08)] p-3 text-body-sm text-semantic-error"
          >
            {dispatchError}
          </div>
        )}

        {result && (
          <div
            role="status"
            aria-live="polite"
            className="mt-3 rounded-sm border border-accent-primary/40 bg-[rgba(29,184,122,0.08)] p-3 text-body-sm text-accent-primary"
          >
            Dispatched to {result.dispatched.length} vendor
            {result.dispatched.length === 1 ? '' : 's'}
            {result.skipped.length > 0
              ? ` — ${result.skipped.length} skipped`
              : ''}
            .
          </div>
        )}
      </div>
    </div>
  );
}
