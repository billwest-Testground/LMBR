/**
 * /bids/[bidId]/vendors/select — vendor dispatch workspace.
 *
 * Purpose:  The Buyer's "pick who gets this RFQ" page. Dedicated route
 *           (not a modal) so the URL is shareable, the state survives
 *           reloads, and the page can grow a "New vendor" side drawer
 *           in a later prompt without fighting z-index against the
 *           status board. Loads the bid + its vendor-visible line items
 *           (respecting the bid's consolidation_mode, same rule as the
 *           Task 6 status board uses) and renders VendorSelector with
 *           the needed context. On successful dispatch, redirects back
 *           to /bids/[bidId]/vendors so the Buyer lands on the live
 *           status board.
 *
 * Inputs:   params: { bidId }.
 * Outputs:  React client component.
 * Agent/API: Supabase browser client (RLS-scoped).
 * Imports:  VendorSelector, @lmbr/config (routeBidToRegion, RegionId),
 *           @lmbr/lib (vendorVisibleIsConsolidatedFlag), @lmbr/types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import {
  routeBidToRegion,
  type RegionId,
} from '@lmbr/config';
import { vendorVisibleIsConsolidatedFlag } from '@lmbr/lib';
import type { ConsolidationMode } from '@lmbr/types';

import {
  VendorSelector,
  type VendorSelectorBidLineItem,
} from '../../../../../components/vendors/vendor-selector';
import { getSupabaseBrowserClient } from '../../../../../lib/supabase/browser';

interface BidSummary {
  id: string;
  customerName: string;
  jobName: string | null;
  jobState: string | null;
  jobRegion: string | null;
  consolidationMode: ConsolidationMode;
}

interface LineItemRow {
  id: string;
  species: string;
  dimension: string;
  length: string | null;
  quantity: number | string;
  unit: string;
  board_feet: number | string | null;
}

const VALID_REGIONS: readonly RegionId[] = [
  'west',
  'mountain',
  'midwest',
  'south',
  'northeast',
];

/** Narrow an arbitrary string to a RegionId, or null if it doesn't match. */
function toRegionId(value: string | null): RegionId | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  return VALID_REGIONS.find((r) => r === lower) ?? null;
}

export default function VendorSelectPage({
  params,
}: {
  params: { bidId: string };
}) {
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();

  const [bid, setBid] = React.useState<BidSummary | null>(null);
  const [lineItems, setLineItems] = React.useState<VendorSelectorBidLineItem[]>(
    [],
  );
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      const { data: bidRow, error: bidErr } = await supabase
        .from('bids')
        .select(
          'id, customer_name, job_name, job_state, job_region, consolidation_mode',
        )
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
        job_state: string | null;
        job_region: string | null;
        consolidation_mode: string;
      };
      const summary: BidSummary = {
        id: bidData.id,
        customerName: bidData.customer_name,
        jobName: bidData.job_name,
        jobState: bidData.job_state,
        jobRegion: bidData.job_region,
        consolidationMode: bidData.consolidation_mode as ConsolidationMode,
      };
      setBid(summary);

      // Vendor-visible slice of the bid — same filter the submit form, PDF
      // tally, and Task 6 status board use.
      const visibleFlag = vendorVisibleIsConsolidatedFlag(
        summary.consolidationMode,
      );
      const { data: liRows, error: liErr } = await supabase
        .from('line_items')
        .select('id, species, dimension, length, quantity, unit, board_feet')
        .eq('bid_id', params.bidId)
        .eq('is_consolidated', visibleFlag)
        .order('sort_order', { ascending: true });
      if (cancelled) return;
      if (liErr) {
        setError(liErr.message);
        setLoading(false);
        return;
      }
      const rows = (liRows ?? []) as unknown as LineItemRow[];
      const mapped: VendorSelectorBidLineItem[] = rows.map((row) => ({
        lineItemId: row.id,
        quantity: Number(row.quantity),
        unit: row.unit,
        boardFeet: row.board_feet != null ? Number(row.board_feet) : null,
        species: row.species,
        dimension: row.dimension,
        length: row.length,
      }));
      setLineItems(mapped);

      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [params.bidId, supabase]);

  // Derive a RegionId. Prefer job_region (persisted at routing time). Fall
  // back to routeBidToRegion(job_state) for older bids where the column
  // wasn't populated. Null means "no region constraint" in Task 7's logic.
  const region = React.useMemo<RegionId | null>(() => {
    if (!bid) return null;
    const fromRegion = toRegionId(bid.jobRegion);
    if (fromRegion) return fromRegion;
    const routed = routeBidToRegion(bid.jobState);
    return toRegionId(routed);
  }, [bid]);

  // Extract distinct species tokens for per-commodity ranking. The primary
  // commodity is items[0]; a richer multi-commodity UI is a later task.
  const commodities = React.useMemo<string[]>(() => {
    const seen = new Set<string>();
    for (const li of lineItems) {
      const token = li.species?.trim();
      if (!token) continue;
      if (seen.has(token)) continue;
      seen.add(token);
    }
    return [...seen];
  }, [lineItems]);

  const handleDispatchSuccess = React.useCallback(() => {
    // Bounce back to the live status board — the new rows will be present
    // there, rendered through VendorBidCard tiles.
    router.push(`/bids/${params.bidId}/vendors`);
  }, [params.bidId, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <p className="text-body-sm text-text-tertiary">Loading bid…</p>
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

  return (
    <div className="mx-auto max-w-[1200px] space-y-6 p-8">
      <div>
        <Link
          href={`/bids/${bid.id}/vendors`}
          className="inline-flex items-center gap-1 text-caption text-text-tertiary transition-colors duration-micro hover:text-text-secondary"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden="true" />
          Back to vendor status
        </Link>
        <h1 className="mt-2 text-h1 text-text-primary">Dispatch vendors</h1>
        <p className="mt-1 text-body text-text-secondary">
          {bid.customerName}
          {bid.jobName ? ` — ${bid.jobName}` : ''}
        </p>
      </div>

      <VendorSelector
        bidId={bid.id}
        region={region}
        commodities={commodities}
        bidLineItems={lineItems}
        onDispatchSuccess={handleDispatchSuccess}
      />
    </div>
  );
}
