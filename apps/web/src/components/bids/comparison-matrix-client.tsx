/**
 * ComparisonMatrixClient — client-side wrapper that owns the
 * onExportSelection callback for the server-rendered compare page.
 *
 * Purpose:  The compare page is a Next.js server component (auth + data
 *           loading live there), but <ComparisonMatrix> is a client
 *           component with interactive selection state. This thin wrapper
 *           lives in its own file so the page can pass the serialized
 *           `result` prop across the RSC boundary and hand the interactive
 *           callback off to a real client-side function.
 *
 *           Prompt 07 hand-off: when the margin-stacking endpoint lands,
 *           replace the console.info with a POST to the selection-save
 *           route. Today we log + `window.alert` so the trader gets
 *           tangible feedback the click was received.
 *
 * Inputs:   { result }.
 * Outputs:  JSX.
 * Agent/API: none — logs a stub "saved" action until Prompt 07 ships the
 *           margin-stacking persistence endpoint.
 * Imports:  ./comparison-matrix.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';

import type { ComparisonResult } from '@lmbr/agents';

import {
  ComparisonMatrix,
  type ExportedSelection,
} from './comparison-matrix';

export interface ComparisonMatrixClientProps {
  result: ComparisonResult;
}

export function ComparisonMatrixClient({ result }: ComparisonMatrixClientProps) {
  const handleExport = React.useCallback((selection: ExportedSelection[]) => {
    // Prompt 07 hand-off — replace with a fetch('/api/margin/stacking',
    // { method: 'POST', body: JSON.stringify({ bidId, selection }) }) when
    // the margin-stacking route lands. For now, surface the payload so
    // the trader knows the click was captured and QA has a console trail.
    // eslint-disable-next-line no-console
    console.info('[compare] export selection', {
      bidId: result.bidId,
      count: selection.length,
      selection,
    });
    if (typeof window !== 'undefined') {
      window.alert(
        `Selection captured — ${selection.length} line${
          selection.length === 1 ? '' : 's'
        }. ` +
          'Margin-stacking persistence lands in Prompt 07. See console for the full payload.',
      );
    }
  }, [result.bidId]);

  return <ComparisonMatrix result={result} onExportSelection={handleExport} />;
}
