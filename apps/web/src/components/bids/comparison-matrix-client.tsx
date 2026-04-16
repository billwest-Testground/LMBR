/**
 * ComparisonMatrixClient — client-side wrapper that routes exported
 * vendor selections into the margin-stacking workspace.
 *
 * Purpose:  The compare page is a Next.js server component (auth + data
 *           loading live there), but <ComparisonMatrix> is a client
 *           component with interactive selection state. This thin wrapper
 *           lives in its own file so the page can pass the serialized
 *           `result` prop across the RSC boundary and hand the interactive
 *           callback off to a real client-side function.
 *
 *           On export we stash the selection in sessionStorage (via
 *           lib/margin/selection-stash) under a bidId-scoped key, then
 *           navigate to /bids/[bidId]/margin. The margin page reads it
 *           on mount so we don't burn a server round-trip for a payload
 *           that only needs to live for ~30 seconds.
 *
 * Inputs:   { result }.
 * Outputs:  JSX.
 * Agent/API: none — client-side navigation + sessionStorage.
 * Imports:  next/navigation, ./comparison-matrix, ../../lib/margin/selection-stash.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import type { ComparisonResult } from '@lmbr/agents';

import {
  ComparisonMatrix,
  type ExportedSelection,
} from './comparison-matrix';
import { writeMarginSelection } from '../../lib/margin/selection-stash';

export interface ComparisonMatrixClientProps {
  result: ComparisonResult;
}

export function ComparisonMatrixClient({ result }: ComparisonMatrixClientProps) {
  const router = useRouter();

  const handleExport = React.useCallback(
    (selection: ExportedSelection[]) => {
      // Stash the client-side selection so the margin page can read it on
      // mount without a server round-trip, then push the trader forward.
      writeMarginSelection(
        result.bidId,
        selection.map((s) => ({
          lineItemId: s.lineItemId,
          vendorId: s.vendorId,
          vendorBidLineItemId: s.vendorBidLineItemId,
          unitPrice: s.unitPrice,
          totalPrice: s.totalPrice,
        })),
      );
      router.push(`/bids/${result.bidId}/margin`);
    },
    [result.bidId, router],
  );

  return <ComparisonMatrix result={result} onExportSelection={handleExport} />;
}
