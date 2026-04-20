/**
 * RoutingMap — visual routing review for a single bid.
 *
 * Purpose:  The trader's review surface between the ingest table and the
 *           vendor-dispatch step. Shows every routing decision in the
 *           bid_routings table grouped by buyer + commodity_group,
 *           surfaces unrouted line items in a dedicated bucket at the
 *           top with an inline "Assign to buyer" control, and exposes
 *           a "Confirm routing" button that advances bids.status from
 *           'routing' to 'quoting'. Confirm is disabled while any item
 *           is still unrouted.
 *
 *           This component expects server-fetched initial data — it
 *           does NOT trigger the auto-routing call itself; the wrapping
 *           page.tsx is responsible for posting to /api/route-bid first
 *           if no routings exist yet. That keeps the component simple
 *           and testable without any network setup.
 *
 * Inputs:   initial line items, initial bid_routings, list of tenant
 *           buyers (for the assign dropdown), bid id, bid customer name.
 * Outputs:  JSX + side-effects via /api/route-bid/[bidId]/assign + /confirm.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, AlertTriangle, UserPlus } from 'lucide-react';

import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { cn } from '../../lib/cn';

export interface RoutingMapLineItem {
  id: string;
  building_tag: string | null;
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number;
  unit: string;
  board_feet: number | null;
}

export interface RoutingMapRouting {
  id: string;
  buyer_user_id: string;
  commodity_group: string;
  line_item_ids: string[];
  status: string;
}

export interface RoutingMapBuyerOption {
  userId: string;
  fullName: string;
  roleType: 'buyer' | 'trader_buyer';
}

export interface RoutingMapProps {
  bidId: string;
  customerName: string;
  lineItems: RoutingMapLineItem[];
  initialRoutings: RoutingMapRouting[];
  buyerOptions: RoutingMapBuyerOption[];
}

export function RoutingMap({
  bidId,
  customerName,
  lineItems,
  initialRoutings,
  buyerOptions,
}: RoutingMapProps) {
  const router = useRouter();
  const [routings, setRoutings] = React.useState<RoutingMapRouting[]>(
    initialRoutings,
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedUnrouted, setSelectedUnrouted] = React.useState<Set<string>>(
    new Set(),
  );
  const [assignBuyer, setAssignBuyer] = React.useState<string>(
    buyerOptions[0]?.userId ?? '',
  );

  // Sync local state when the parent re-fetches after re-routing or
  // after the auto-route mount fires router.refresh().
  React.useEffect(() => {
    setRoutings(initialRoutings);
  }, [initialRoutings]);

  // --- Derived state -------------------------------------------------------
  const lineItemMap = React.useMemo(() => {
    const map = new Map<string, RoutingMapLineItem>();
    for (const li of lineItems) map.set(li.id, li);
    return map;
  }, [lineItems]);

  const routedIds = React.useMemo(() => {
    const set = new Set<string>();
    routings.forEach((r) => r.line_item_ids.forEach((id) => set.add(id)));
    return set;
  }, [routings]);

  const unroutedLineItems = React.useMemo(
    () => lineItems.filter((li) => !routedIds.has(li.id)),
    [lineItems, routedIds],
  );

  const buyerMap = React.useMemo(() => {
    const map = new Map<string, RoutingMapBuyerOption>();
    for (const b of buyerOptions) map.set(b.userId, b);
    return map;
  }, [buyerOptions]);

  // --- Handlers ------------------------------------------------------------
  function toggleSelected(id: string, selected: boolean) {
    setSelectedUnrouted((current) => {
      const next = new Set(current);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function selectAllUnrouted() {
    setSelectedUnrouted(new Set(unroutedLineItems.map((li) => li.id)));
  }

  function clearSelection() {
    setSelectedUnrouted(new Set());
  }

  async function handleAssignSelected() {
    if (selectedUnrouted.size === 0 || !assignBuyer) return;
    // Derive a commodity_group from the first selected item's species.
    const firstItem = lineItemMap.get(Array.from(selectedUnrouted)[0]);
    const commodityGroup = firstItem
      ? commodityGroupFor(firstItem.species)
      : 'Other';

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/route-bid/${bidId}/assign`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          lineItemIds: Array.from(selectedUnrouted),
          buyerUserId: assignBuyer,
          commodityGroup,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        routings?: RoutingMapRouting[];
      };
      if (!res.ok) {
        throw new Error(body.error ?? `Assign failed (${res.status})`);
      }
      setRoutings(body.routings ?? []);
      clearSelection();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assign failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/route-bid/${bidId}/confirm`, {
        method: 'POST',
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? `Confirm failed (${res.status})`);
      }
      // Bid advances into 'quoting' — send the user back to their
      // dashboard where the pipeline card moves to the next column.
      // Bid-detail page lands in a later prompt.
      router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirm failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleRerunRouting() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/route-bid', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bid_id: bidId }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? `Re-route failed (${res.status})`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-route failed');
    } finally {
      setBusy(false);
    }
  }

  // --- Render --------------------------------------------------------------
  const buyersCount = new Set(routings.map((r) => r.buyer_user_id)).size;
  const allConfirmBlocked = unroutedLineItems.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <div className="text-label uppercase text-text-tertiary">Routing</div>
        <h1 className="mt-1 text-h1 text-text-primary">{customerName}</h1>
        <p className="mt-2 text-body text-text-secondary">
          Review how LMBR auto-routed this bid. Assign any unrouted lines to
          the correct buyer, then confirm to hand off to vendor dispatch.
        </p>
      </header>

      {/* Summary strip ------------------------------------------------------ */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total lines" value={lineItems.length.toLocaleString()} />
        <Stat
          label="Routed"
          value={(lineItems.length - unroutedLineItems.length).toLocaleString()}
          tone="accent"
        />
        <Stat
          label="Unrouted"
          value={unroutedLineItems.length.toLocaleString()}
          tone={unroutedLineItems.length > 0 ? 'warn' : 'default'}
        />
        <Stat label="Buyers" value={buyersCount.toLocaleString()} />
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-sm border border-[rgba(192,57,43,0.4)] bg-[rgba(192,57,43,0.10)] px-3 py-2 text-body-sm text-semantic-error"
        >
          {error}
        </div>
      )}

      {/* Unrouted bucket ---------------------------------------------------- */}
      {unroutedLineItems.length > 0 && (
        <section className="rounded-md border border-[rgba(184,122,29,0.35)] bg-[rgba(184,122,29,0.06)] p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-semantic-warning" aria-hidden="true" />
              <h2 className="text-h3 text-text-primary">
                Unrouted lines
              </h2>
              <span className="text-label uppercase text-text-tertiary">
                {unroutedLineItems.length} of {lineItems.length}
              </span>
            </div>
            <div className="flex items-center gap-2 text-caption">
              <button
                type="button"
                onClick={selectAllUnrouted}
                className="text-accent-primary hover:text-accent-secondary"
              >
                Select all
              </button>
              <span className="text-text-tertiary">·</span>
              <button
                type="button"
                onClick={clearSelection}
                disabled={selectedUnrouted.size === 0}
                className="text-accent-primary hover:text-accent-secondary disabled:opacity-40"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="mb-4 max-h-[280px] overflow-auto rounded-sm border border-border-base bg-bg-surface">
            <table className="w-full border-separate border-spacing-0 text-body-sm">
              <thead className="sticky top-0 bg-bg-surface">
                <tr>
                  <Th className="w-8" />
                  <Th>Building</Th>
                  <Th>Species</Th>
                  <Th>Dimension</Th>
                  <Th>Grade</Th>
                  <Th>Length</Th>
                  <Th align="right">Qty</Th>
                  <Th align="right">BF</Th>
                </tr>
              </thead>
              <tbody>
                {unroutedLineItems.map((li) => {
                  const checked = selectedUnrouted.has(li.id);
                  return (
                    <tr
                      key={li.id}
                      className={cn(
                        'hover:bg-bg-subtle',
                        checked && 'bg-[rgba(29,184,122,0.06)]',
                      )}
                    >
                      <Td className="text-center">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            toggleSelected(li.id, e.target.checked)
                          }
                          aria-label={`Select ${li.species} ${li.dimension}`}
                          className="h-3.5 w-3.5 accent-accent-primary"
                        />
                      </Td>
                      <Td>{li.building_tag ?? '—'}</Td>
                      <Td className="text-text-primary">{li.species}</Td>
                      <Td className="font-mono text-text-primary">{li.dimension}</Td>
                      <Td>{li.grade ?? '—'}</Td>
                      <Td>{li.length ?? '—'}</Td>
                      <Td align="right" className="font-mono text-text-primary">
                        {li.quantity.toLocaleString()}
                      </Td>
                      <Td align="right" className="font-mono text-text-primary">
                        {(li.board_feet ?? 0).toLocaleString(undefined, {
                          maximumFractionDigits: 0,
                        })}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[220px] flex-1">
              <Label htmlFor="assign-buyer">Assign to buyer</Label>
              <select
                id="assign-buyer"
                value={assignBuyer}
                onChange={(e) => setAssignBuyer(e.target.value)}
                disabled={busy || buyerOptions.length === 0}
                className="block h-9 w-full rounded-sm border border-border-base bg-bg-subtle px-3 text-body text-text-primary focus:border-accent-primary focus:bg-bg-elevated focus:shadow-accent focus:outline-none"
              >
                {buyerOptions.length === 0 && (
                  <option value="">No buyers configured</option>
                )}
                {buyerOptions.map((b) => (
                  <option key={b.userId} value={b.userId}>
                    {b.fullName} · {b.roleType === 'trader_buyer' ? 'Trader + Buyer' : 'Buyer'}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              onClick={handleAssignSelected}
              loading={busy}
              disabled={selectedUnrouted.size === 0 || !assignBuyer || busy}
            >
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              Assign {selectedUnrouted.size > 0 ? `${selectedUnrouted.size} ` : ''}line
              {selectedUnrouted.size === 1 ? '' : 's'}
            </Button>
          </div>
        </section>
      )}

      {/* Routed groups ------------------------------------------------------ */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-h3 text-text-primary">Routed to buyers</h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRerunRouting}
            disabled={busy}
          >
            Re-run auto-routing
          </Button>
        </div>

        {routings.length === 0 ? (
          <div className="rounded-md border border-dashed border-border-base bg-bg-surface px-6 py-8 text-center text-body text-text-tertiary">
            Nothing is routed yet. Use the unrouted bucket above to assign lines
            to a buyer, or click "Re-run auto-routing".
          </div>
        ) : (
          routings.map((routing) => {
            const buyer = buyerMap.get(routing.buyer_user_id);
            const items = routing.line_item_ids
              .map((id) => lineItemMap.get(id))
              .filter((x): x is RoutingMapLineItem => Boolean(x));
            const groupBF = items.reduce(
              (s, li) => s + (li.board_feet ?? 0),
              0,
            );
            return (
              <div
                key={routing.id}
                className="rounded-md border border-border-base bg-bg-surface p-4 shadow-sm"
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <CheckCircle2
                        className="h-4 w-4 text-accent-primary"
                        aria-hidden="true"
                      />
                      <span className="text-h4 text-text-primary">
                        {buyer?.fullName ?? 'Unknown buyer'}
                      </span>
                      <span className="rounded-pill bg-[rgba(29,184,122,0.12)] px-2 py-0.5 text-label uppercase text-accent-primary">
                        {routing.commodity_group}
                      </span>
                    </div>
                    <div className="mt-1 text-caption text-text-tertiary">
                      {items.length} line{items.length === 1 ? '' : 's'} ·{' '}
                      <span className="font-mono tabular-nums text-text-secondary">
                        {groupBF.toLocaleString(undefined, {
                          maximumFractionDigits: 0,
                        })}
                      </span>{' '}
                      BF
                    </div>
                  </div>
                </div>

                <details className="group">
                  <summary className="cursor-pointer text-caption text-text-tertiary hover:text-text-secondary">
                    View lines
                  </summary>
                  <div className="mt-3 max-h-[280px] overflow-auto rounded-sm border border-border-base">
                    <table className="w-full border-separate border-spacing-0 text-body-sm">
                      <thead className="sticky top-0 bg-bg-subtle">
                        <tr>
                          <Th>Building</Th>
                          <Th>Species</Th>
                          <Th>Dimension</Th>
                          <Th>Grade</Th>
                          <Th>Length</Th>
                          <Th align="right">Qty</Th>
                          <Th align="right">BF</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((li) => (
                          <tr key={li.id} className="hover:bg-bg-subtle">
                            <Td>{li.building_tag ?? '—'}</Td>
                            <Td className="text-text-primary">{li.species}</Td>
                            <Td className="font-mono text-text-primary">
                              {li.dimension}
                            </Td>
                            <Td>{li.grade ?? '—'}</Td>
                            <Td>{li.length ?? '—'}</Td>
                            <Td align="right" className="font-mono text-text-primary">
                              {li.quantity.toLocaleString()}
                            </Td>
                            <Td align="right" className="font-mono text-text-primary">
                              {(li.board_feet ?? 0).toLocaleString(undefined, {
                                maximumFractionDigits: 0,
                              })}
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            );
          })
        )}
      </section>

      {/* Footer actions ----------------------------------------------------- */}
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-5">
        <div className="text-caption text-text-tertiary">
          {allConfirmBlocked
            ? `${unroutedLineItems.length} line${unroutedLineItems.length === 1 ? '' : 's'} still unrouted — assign them above to continue.`
            : 'All lines routed. Confirm to move this bid into vendor dispatch.'}
        </div>
        <Button
          type="button"
          size="lg"
          disabled={allConfirmBlocked || busy}
          loading={busy}
          onClick={handleConfirm}
        >
          Confirm routing → Quoting
        </Button>
      </footer>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Subcomponents
// -----------------------------------------------------------------------------

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'accent' | 'warn';
}) {
  const toneClass =
    tone === 'accent'
      ? 'text-accent-primary'
      : tone === 'warn'
        ? 'text-semantic-warning'
        : 'text-text-primary';
  return (
    <div className="rounded-md border border-border-base bg-bg-surface px-4 py-3 shadow-sm">
      <div className="text-label uppercase text-text-tertiary">{label}</div>
      <div className={cn('mt-1 text-h3 font-mono tabular-nums', toneClass)}>
        {value}
      </div>
    </div>
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
        'border-b border-border-base bg-bg-subtle px-3 py-2 text-label uppercase text-text-tertiary',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
  className,
}: {
  children?: React.ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  return (
    <td
      className={cn(
        'border-b border-border-subtle px-3 py-2 text-text-secondary',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </td>
  );
}

function commodityGroupFor(species: string): string {
  const s = (species ?? '').trim();
  if (['SPF', 'DF', 'HF', 'SYP'].includes(s)) return 'Dimensional';
  if (s === 'Cedar') return 'Cedar';
  if (s === 'LVL') return 'Engineered';
  if (s === 'OSB' || s === 'Plywood') return 'Panels';
  if (s === 'Treated') return 'Treated';
  return s || 'Other';
}
