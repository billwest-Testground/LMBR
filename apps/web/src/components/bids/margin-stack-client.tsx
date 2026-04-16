/**
 * MarginStackClient — RSC→client bridge for <MarginStack>.
 *
 * Purpose:  The margin page is a server component that loads bid / line
 *           / settings data; the margin stack itself is a client
 *           component because of its dense interactive state. This
 *           bridge reads the selection stash (written by the comparison
 *           export), renders an empty-state panel if no selection is
 *           found, and owns the onSave fetch to POST /api/margin.
 *
 *           On successful Submit-for-approval we route the trader to
 *           /bids/[bidId]/quote so they can preview + release; on draft
 *           saves we stay on the margin page so they can keep iterating.
 *
 * Inputs:   bidId + MarginStackProps minus onSave / initialSelections.
 * Outputs:  JSX.
 * Agent/API: POST /api/margin.
 * Imports:  next/navigation, ./margin-stack, ../../lib/margin/selection-stash.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Inbox } from 'lucide-react';

import type {
  MarginInstruction,
  PricingResult,
  PricingSelection,
} from '@lmbr/agents';

import { Button } from '../ui/button';
import {
  readMarginSelection,
  clearMarginSelection,
  type MarginStashSelection,
} from '../../lib/margin/selection-stash';
import {
  MarginStack,
  type MarginStackLine,
  type MarginStackSaveResult,
  type MarginStackSettings,
} from './margin-stack';

export interface MarginStackClientProps {
  bidId: string;
  lines: MarginStackLine[];
  settings: MarginStackSettings;
  jobState: string | null;
  consolidationMode: 'structured' | 'consolidated' | 'phased' | 'hybrid';
  isManager: boolean;
  vendorNameByVendorId?: Record<string, string>;
  /**
   * If the bid already has a persisted quote with selections, the server
   * passes them in here so the trader can re-edit margin without going
   * through compare again.
   */
  persistedSelections?: PricingSelection[];
}

export function MarginStackClient({
  bidId,
  lines,
  settings,
  jobState,
  consolidationMode,
  isManager,
  vendorNameByVendorId,
  persistedSelections,
}: MarginStackClientProps) {
  const router = useRouter();
  const [stash, setStash] = React.useState<MarginStashSelection[] | null>(null);
  const [stashChecked, setStashChecked] = React.useState(false);

  React.useEffect(() => {
    const existing = readMarginSelection(bidId);
    setStash(existing);
    setStashChecked(true);
  }, [bidId]);

  const initialSelections: PricingSelection[] = React.useMemo(() => {
    if (stash && stash.length > 0) {
      return stash.map((s) => ({
        lineItemId: s.lineItemId,
        vendorBidLineItemId: s.vendorBidLineItemId,
        vendorId: s.vendorId,
        costUnitPrice: s.unitPrice,
        costTotalPrice: s.totalPrice,
      }));
    }
    if (persistedSelections && persistedSelections.length > 0) {
      return persistedSelections;
    }
    return [];
  }, [persistedSelections, stash]);

  const onSave = React.useCallback(
    async (
      action: 'draft' | 'submit_for_approval',
      instructions: MarginInstruction[],
    ): Promise<MarginStackSaveResult> => {
      const res = await fetch('/api/margin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bidId,
          selections: initialSelections,
          marginInstructions: instructions,
          action,
        }),
      });

      if (!res.ok) {
        let msg = `Margin save failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) msg = body.error;
        } catch {
          // fall through with default message
        }
        throw new Error(msg);
      }

      const body = (await res.json()) as {
        success: boolean;
        quote: { id: string; status: string };
        pricing: PricingResult;
        needsApproval: boolean;
        belowMinimumMargin: boolean;
      };

      // Persisted — clear the stash so a back-and-forth through compare
      // doesn't resurrect stale selections next time.
      clearMarginSelection(bidId);

      // On submit_for_approval we route to the quote preview page so
      // the trader (or manager) can preview + release.
      if (
        action === 'submit_for_approval' &&
        (body.quote.status === 'pending_approval' ||
          body.quote.status === 'approved')
      ) {
        router.push(`/bids/${bidId}/quote`);
      }

      return {
        needsApproval: body.needsApproval,
        pricing: body.pricing,
        quote: body.quote,
      };
    },
    [bidId, initialSelections, router],
  );

  // --- Render states -------------------------------------------------------

  if (!stashChecked) {
    return (
      <div className="flex items-center justify-center rounded-md border border-border-base bg-bg-surface p-12 text-body-sm text-text-tertiary shadow-sm">
        Loading selection…
      </div>
    );
  }

  if (initialSelections.length === 0) {
    return <EmptyPanel bidId={bidId} />;
  }

  return (
    <MarginStack
      bidId={bidId}
      initialSelections={initialSelections}
      lines={lines}
      settings={settings}
      jobState={jobState}
      consolidationMode={consolidationMode}
      isManager={isManager}
      vendorNameByVendorId={vendorNameByVendorId}
      onSave={onSave}
    />
  );
}

function EmptyPanel({ bidId }: { bidId: string }) {
  return (
    <div className="mx-auto mt-8 flex max-w-md flex-col items-center gap-3 rounded-md border border-border-base bg-bg-surface px-6 py-12 text-center shadow-sm">
      <Inbox className="h-12 w-12 text-text-tertiary" aria-hidden="true" />
      <h2 className="text-h3 text-text-secondary">No selection found</h2>
      <p className="text-body-sm text-text-tertiary">
        Pick vendor prices on the comparison matrix, then export the selection
        to carry it into the margin stack.
      </p>
      <Button asChild variant="primary">
        <Link href={`/bids/${bidId}/compare`}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to comparison
        </Link>
      </Button>
    </div>
  );
}
