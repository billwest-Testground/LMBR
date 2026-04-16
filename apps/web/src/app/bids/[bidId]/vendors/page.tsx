/**
 * Buyer vendor status board — /bids/[bidId]/vendors.
 *
 * Purpose:  Once the buyer has dispatched a bid to vendors (Task 2), this
 *           is the page they live on. Lists every `vendor_bids` row for the
 *           bid, grouped into a responsive grid of status tiles that
 *           refresh on demand. Each tile surfaces enough information to
 *           act without drilling into a detail view: vendor identity,
 *           current status, dispatch time, due-by, priced-vs-expected
 *           progress, the submit URL (copyable), the printable PDF URL,
 *           and a "Nudge" action that posts to the stubbed endpoint.
 *
 *           The priced-vs-expected progress indicator pulls from two
 *           separate counts:
 *             - expected = rows of line_items that match the bid's
 *               consolidation_mode via vendorVisibleIsConsolidatedFlag()
 *               (the same rule applied on the submit form + PDF tally).
 *             - priced   = vendor_bid_line_items rows with a non-null
 *               unit_price for this vendor_bid.
 *           We fetch both through the RLS-scoped browser client — no
 *           service-role escape hatch needed on this page because the
 *           tenant gate applies to both tables.
 *
 *           Empty state (no vendor_bids yet) deep-links into the current
 *           workspace step (consolidate) with a TODO pointing Task 8 to
 *           wire the eventual vendor-selector route.
 *
 * Inputs:   params: { bidId }.
 * Outputs:  React client component.
 * Agent/API: GET via Supabase browser client; POST /api/vendors/nudge.
 * Imports:  lucide-react, Supabase browser client, VendorBidCard,
 *           @lmbr/lib/vendorVisibleIsConsolidatedFlag, @lmbr/types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Inbox } from 'lucide-react';

import { vendorVisibleIsConsolidatedFlag } from '@lmbr/lib';
import type { ConsolidationMode, VendorBidStatus } from '@lmbr/types';

import {
  VendorBidCard,
  STATUS_STYLES,
  type VendorBidCardVb,
  type VendorBidCardVendor,
} from '../../../../components/vendors/vendor-bid-card';
import { getSupabaseBrowserClient } from '../../../../lib/supabase/browser';

interface BidSummary {
  id: string;
  customerName: string;
  jobName: string | null;
  consolidationMode: ConsolidationMode;
  status: string;
}

interface VendorBidRow {
  id: string;
  vendor_id: string;
  status: VendorBidStatus;
  submission_method: string;
  sent_at: string | null;
  due_by: string | null;
  submitted_at: string | null;
  token: string | null;
  token_expires_at: string | null;
  raw_response_url: string | null;
}

interface VendorRow {
  id: string;
  name: string;
  vendor_type: string | null;
  min_order_mbf: number | null;
}

interface VendorBidLineItemRow {
  vendor_bid_id: string;
  unit_price: number | null;
}

interface NudgeToast {
  kind: 'success' | 'error';
  message: string;
}

/**
 * Build the two vendor-facing URLs from a dispatch token. Uses the same
 * NEXT_PUBLIC_APP_URL prefix pattern as the dispatch route; if unset, we
 * fall back to relative URLs so local dev still works.
 */
function buildVendorUrls(token: string | null): {
  submitUrl: string | null;
  printUrl: string | null;
} {
  if (!token) return { submitUrl: null, printUrl: null };
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '') ?? '';
  return {
    submitUrl: `${base}/vendor-submit/${token}`,
    printUrl: `${base}/vendor-submit/${token}/print`,
  };
}

export default function VendorStatusBoardPage({
  params,
}: {
  params: { bidId: string };
}) {
  const supabase = getSupabaseBrowserClient();

  const [bid, setBid] = useState<BidSummary | null>(null);
  const [vendorBids, setVendorBids] = useState<VendorBidRow[]>([]);
  const [vendorsById, setVendorsById] = useState<Map<string, VendorRow>>(
    new Map(),
  );
  const [pricedCountByVbId, setPricedCountByVbId] = useState<Map<string, number>>(
    new Map(),
  );
  const [expectedCount, setExpectedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nudgingId, setNudgingId] = useState<string | null>(null);
  const [toast, setToast] = useState<NudgeToast | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadAll() {
      setLoading(true);
      setError(null);

      // 1) Bid summary (RLS-scoped).
      const { data: bidRow, error: bidErr } = await supabase
        .from('bids')
        .select('id, customer_name, job_name, consolidation_mode, status')
        .eq('id', params.bidId)
        .maybeSingle();
      if (cancelled) return;
      if (bidErr || !bidRow) {
        setError(bidErr?.message ?? 'Bid not found');
        setLoading(false);
        return;
      }
      const bidData = bidRow as unknown as {
        id: string;
        customer_name: string;
        job_name: string | null;
        consolidation_mode: string;
        status: string;
      };
      const summary: BidSummary = {
        id: bidData.id,
        customerName: bidData.customer_name,
        jobName: bidData.job_name,
        consolidationMode: bidData.consolidation_mode as ConsolidationMode,
        status: bidData.status,
      };
      setBid(summary);

      // 2) Vendor bids for this bid. No joins — vendor lookup is separate
      //    (see CLAUDE.md query conventions).
      const { data: vbRows, error: vbErr } = await supabase
        .from('vendor_bids')
        .select(
          'id, vendor_id, status, submission_method, sent_at, due_by, ' +
            'submitted_at, token, token_expires_at, raw_response_url',
        )
        .eq('bid_id', params.bidId)
        .order('sent_at', { ascending: false });
      if (cancelled) return;
      if (vbErr) {
        setError(vbErr.message);
        setLoading(false);
        return;
      }
      const vbs = (vbRows ?? []) as unknown as VendorBidRow[];
      setVendorBids(vbs);

      // 3) Vendors referenced by those vendor_bids.
      const vendorIds = [...new Set(vbs.map((v) => v.vendor_id))];
      const vendorMap = new Map<string, VendorRow>();
      if (vendorIds.length > 0) {
        const { data: vendorRows, error: vendorErr } = await supabase
          .from('vendors')
          .select('id, name, vendor_type, min_order_mbf')
          .in('id', vendorIds);
        if (cancelled) return;
        if (vendorErr) {
          setError(vendorErr.message);
          setLoading(false);
          return;
        }
        for (const v of (vendorRows ?? []) as unknown as VendorRow[]) {
          vendorMap.set(v.id, v);
        }
      }
      setVendorsById(vendorMap);

      // 4) Priced-count per vendor_bid. Pull only the unit_price column so
      //    we can bucket rows with a non-null price as "priced". RLS on
      //    vendor_bid_line_items restricts this to buyer-aligned roles.
      const vbIds = vbs.map((v) => v.id);
      const priced = new Map<string, number>();
      for (const id of vbIds) priced.set(id, 0);
      if (vbIds.length > 0) {
        const { data: vbliRows, error: vbliErr } = await supabase
          .from('vendor_bid_line_items')
          .select('vendor_bid_id, unit_price')
          .in('vendor_bid_id', vbIds);
        if (cancelled) return;
        if (vbliErr) {
          setError(vbliErr.message);
          setLoading(false);
          return;
        }
        for (const row of (vbliRows ?? []) as unknown as VendorBidLineItemRow[]) {
          if (row.unit_price == null) continue;
          priced.set(row.vendor_bid_id, (priced.get(row.vendor_bid_id) ?? 0) + 1);
        }
      }
      setPricedCountByVbId(priced);

      // 5) Expected count = vendor-visible line_items rows for this bid.
      //    Same filter the submit form, PDF tally, and scan-back agent use.
      const visibleFlag = vendorVisibleIsConsolidatedFlag(summary.consolidationMode);
      const { count: expected, error: expectedErr } = await supabase
        .from('line_items')
        .select('id', { count: 'exact', head: true })
        .eq('bid_id', params.bidId)
        .eq('is_consolidated', visibleFlag);
      if (cancelled) return;
      if (expectedErr) {
        setError(expectedErr.message);
        setLoading(false);
        return;
      }
      setExpectedCount(expected ?? 0);

      setLoading(false);
    }

    loadAll();
    return () => {
      cancelled = true;
    };
  }, [params.bidId, supabase]);

  // ----- Status summary counts ------------------------------------------------
  const statusCounts = useMemo(() => {
    const counts: Record<VendorBidStatus, number> = {
      pending: 0,
      submitted: 0,
      partial: 0,
      declined: 0,
      expired: 0,
    };
    for (const vb of vendorBids) counts[vb.status]++;
    return counts;
  }, [vendorBids]);

  // ----- Nudge handler --------------------------------------------------------
  const handleNudge = useCallback(async (vendorBidId: string) => {
    setNudgingId(vendorBidId);
    setToast(null);
    try {
      const res = await fetch('/api/vendors/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vendorBidId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setToast({
          kind: 'error',
          message: data?.error ?? 'Nudge failed. Please retry.',
        });
        return;
      }
      setToast({
        kind: 'success',
        message: 'Nudge queued — email will be sent via Outlook (Prompt 08).',
      });
    } catch (err) {
      setToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Network error',
      });
    } finally {
      setNudgingId(null);
      // Auto-dismiss the toast after a few seconds so it doesn't linger.
      setTimeout(() => setToast(null), 4500);
    }
  }, []);

  // ----- Loading / error shells ----------------------------------------------
  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <p className="text-body-sm text-text-tertiary">Loading vendor status…</p>
      </div>
    );
  }

  if (error || !bid) {
    return (
      <div className="flex items-center justify-center p-16">
        <p className="text-body-sm text-semantic-error">
          {error ?? 'Bid not found'}
        </p>
      </div>
    );
  }

  // ----- Render ---------------------------------------------------------------
  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-8">
      {/* Header */}
      <div>
        <h1 className="text-h1 text-text-primary">Vendor status</h1>
        <p className="mt-1 text-body text-text-secondary">
          {bid.customerName}
          {bid.jobName ? ` — ${bid.jobName}` : ''}
        </p>
      </div>

      {/* Summary counts */}
      <StatusSummaryRow total={vendorBids.length} counts={statusCounts} />

      {/* Body */}
      {vendorBids.length === 0 ? (
        <EmptyState bidId={bid.id} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {vendorBids.map((vb) => {
            const vendor = vendorsById.get(vb.vendor_id) ?? null;
            const { submitUrl, printUrl } = buildVendorUrls(vb.token);
            const cardVendor: VendorBidCardVendor | null = vendor
              ? {
                  id: vendor.id,
                  name: vendor.name,
                  vendorType: vendor.vendor_type,
                  minOrderMbf:
                    vendor.min_order_mbf != null
                      ? Number(vendor.min_order_mbf)
                      : null,
                }
              : null;
            const cardVb: VendorBidCardVb = {
              id: vb.id,
              status: vb.status,
              submissionMethod: vb.submission_method,
              sentAt: vb.sent_at,
              dueBy: vb.due_by,
              submittedAt: vb.submitted_at,
              token: vb.token,
              tokenExpiresAt: vb.token_expires_at,
              rawResponseUrl: vb.raw_response_url,
            };
            return (
              <VendorBidCard
                key={vb.id}
                vendorBid={cardVb}
                vendor={cardVendor}
                pricedCount={pricedCountByVbId.get(vb.id) ?? 0}
                expectedCount={expectedCount}
                submitUrl={submitUrl}
                printUrl={printUrl}
                onNudge={handleNudge}
                nudging={nudgingId === vb.id}
              />
            );
          })}
        </div>
      )}

      {/* Transient toast — fixed to the bottom-right of the viewport. */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={
            toast.kind === 'success'
              ? 'fixed bottom-6 right-6 z-50 max-w-sm rounded-md border border-accent-primary/40 bg-bg-elevated px-4 py-3 text-body-sm text-accent-primary shadow-lg'
              : 'fixed bottom-6 right-6 z-50 max-w-sm rounded-md border border-semantic-error/40 bg-bg-elevated px-4 py-3 text-body-sm text-semantic-error shadow-lg'
          }
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

/**
 * Summary row — one inline pill per status plus a "total" anchor on the
 * left. Pulls its colors from the same STATUS_STYLES map the cards use so
 * the two surfaces never drift out of sync.
 */
function StatusSummaryRow({
  total,
  counts,
}: {
  total: number;
  counts: Record<VendorBidStatus, number>;
}) {
  const ordered: VendorBidStatus[] = [
    'submitted',
    'partial',
    'pending',
    'declined',
    'expired',
  ];
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-border-base bg-bg-surface px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-h3 tabular-nums text-text-primary">
          {total}
        </span>
        <span className="text-label uppercase tracking-wider text-text-tertiary">
          total
        </span>
      </div>
      <span className="h-6 w-px bg-border-base" aria-hidden="true" />
      {ordered.map((status) => {
        const style = STATUS_STYLES[status];
        const count = counts[status];
        return (
          <div
            key={status}
            className="flex items-baseline gap-1.5"
            aria-label={`${count} ${style.label}`}
          >
            <span
              className={`font-mono text-body tabular-nums ${style.badgeText}`}
            >
              {count}
            </span>
            <span className="text-label uppercase tracking-wider text-text-tertiary">
              {style.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Empty state — no vendor_bids yet. TODO (Task 8): replace the link with
 * the real vendor-selector workspace route once it exists.
 */
function EmptyState({ bidId }: { bidId: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border-base bg-bg-surface px-8 py-16 text-center">
      <Inbox className="h-8 w-8 text-text-tertiary" aria-hidden="true" />
      <h2 className="text-h3 text-text-primary">No vendors dispatched yet</h2>
      <p className="max-w-md text-body-sm text-text-secondary">
        Once the buyer selects vendors and dispatches this bid, their status
        will appear here — one tile per vendor, with live priced counts and a
        nudge action.
      </p>
      <Link
        href={`/bids/${bidId}/consolidate`}
        className="mt-2 inline-flex items-center gap-2 rounded-sm border border-accent-primary bg-accent-primary/10 px-3 py-1.5 text-body-sm font-medium text-accent-primary transition-colors duration-micro hover:bg-accent-primary/20"
      >
        Back to bid workspace
      </Link>
    </div>
  );
}
