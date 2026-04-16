/**
 * selection-stash — client-only hand-off between comparison and margin.
 *
 * Purpose:  The comparison matrix captures a trader's vendor selections
 *           as pure client state; the margin stack needs that selection
 *           on first render. Instead of round-tripping through the
 *           server (adds a DB table + RLS policies for a payload that
 *           exists for ~30 seconds between two pages), we stash it in
 *           sessionStorage under a bidId-scoped key. The margin page
 *           reads it on mount and then clears it.
 *
 *           This module is the single source of truth for the storage
 *           key + shape so the compare → margin handshake can't drift.
 *
 * Inputs:   bidId + selection payload.
 * Outputs:  write / read / clear helpers (SSR-safe).
 * Agent/API: none — pure sessionStorage.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export interface MarginStashSelection {
  lineItemId: string;
  vendorId: string;
  vendorBidLineItemId: string;
  unitPrice: number;
  totalPrice: number;
}

const KEY_PREFIX = 'lmbr:margin-selection:';

function keyFor(bidId: string): string {
  return `${KEY_PREFIX}${bidId}`;
}

function hasSessionStorage(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.sessionStorage !== 'undefined'
  );
}

export function writeMarginSelection(
  bidId: string,
  selections: MarginStashSelection[],
): void {
  if (!hasSessionStorage()) return;
  try {
    window.sessionStorage.setItem(keyFor(bidId), JSON.stringify(selections));
  } catch (err) {
    // Quota / privacy mode / disabled storage — non-fatal.
    // eslint-disable-next-line no-console
    console.warn('[margin] selection stash write failed', err);
  }
}

export function readMarginSelection(
  bidId: string,
): MarginStashSelection[] | null {
  if (!hasSessionStorage()) return null;
  try {
    const raw = window.sessionStorage.getItem(keyFor(bidId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        lineItemId: String(r.lineItemId ?? ''),
        vendorId: String(r.vendorId ?? ''),
        vendorBidLineItemId: String(r.vendorBidLineItemId ?? ''),
        unitPrice: Number(r.unitPrice ?? 0),
        totalPrice: Number(r.totalPrice ?? 0),
      };
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[margin] selection stash read failed', err);
    return null;
  }
}

export function clearMarginSelection(bidId: string): void {
  if (!hasSessionStorage()) return;
  try {
    window.sessionStorage.removeItem(keyFor(bidId));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[margin] selection stash clear failed', err);
  }
}
