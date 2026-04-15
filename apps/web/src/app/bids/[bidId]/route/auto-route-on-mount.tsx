/**
 * AutoRouteOnMount — fires POST /api/route-bid once on first render.
 *
 * Purpose:  The /bids/[bidId]/route page renders this tiny client
 *           component when there are no bid_routings yet for the bid.
 *           On mount it POSTs to /api/route-bid with the bid id, then
 *           asks the router to refresh so the server component re-runs
 *           and the RoutingMap shows the newly-persisted assignments.
 *           Guarded by a ref to make sure React Strict Mode's double
 *           invoke doesn't fire two routing passes back-to-back.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

export function AutoRouteOnMount({ bidId }: { bidId: string }) {
  const router = useRouter();
  const [status, setStatus] = React.useState<'idle' | 'running' | 'error'>(
    'running',
  );
  const [error, setError] = React.useState<string | null>(null);
  const fired = React.useRef(false);

  React.useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    (async () => {
      try {
        const res = await fetch('/api/route-bid', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bid_id: bidId }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          throw new Error(body.error ?? `Routing failed (${res.status})`);
        }
        setStatus('idle');
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Routing failed');
        setStatus('error');
      }
    })();
  }, [bidId, router]);

  if (status === 'running') {
    return (
      <div className="flex items-center gap-3 rounded-sm border border-border-base bg-gradient-accent px-4 py-3">
        <span className="loading-dots">
          <span />
          <span />
          <span />
        </span>
        <span className="text-body text-text-primary">
          Routing this bid to the right buyers…
        </span>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div
        role="alert"
        className="rounded-sm border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.10)] px-3 py-2 text-body-sm text-semantic-error"
      >
        {error}
      </div>
    );
  }

  return null;
}
