/**
 * ApprovalRowActions — in-table verdict buttons for the manager dashboard.
 *
 * Purpose:  Client island mounted inside the server-rendered manager
 *           approval queue. Gives a manager three single-click paths to
 *           clear a row without navigating away:
 *             - Approve      → primary small button
 *             - Request changes → ghost button, opens an inline note field
 *             - Reject       → destructive ghost, requires a confirm
 *           Plus a kebab overflow that still routes to /bids/[bidId]/margin
 *           for the "open the full margin stack" case.
 *
 *           All three verdicts hit POST /api/manager/approvals with the
 *           same { quoteId, action, notes? } payload. On success we call
 *           router.refresh() so the server component re-reads the queue
 *           and the row disappears. The note for `request_changes` is
 *           included in the POST body for logging but not persisted —
 *           approval_notes column ships in Prompt 08 per the plan.
 *
 *           Kept deliberately small (no modal lib, no portal) so it
 *           layers into the existing server-rendered table with zero
 *           structural changes to the parent.
 *
 * Inputs:   { quoteId, bidId }.
 * Outputs:  JSX.
 * Agent/API: POST /api/manager/approvals.
 * Imports:  next/link, next/navigation, lucide-react, ../ui/button,
 *           ../../lib/cn.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  MessageSquareWarning,
  MoreVertical,
  ShieldCheck,
  XCircle,
} from 'lucide-react';

import { Button } from '../ui/button';
import { cn } from '../../lib/cn';

type Action = 'approve' | 'request_changes' | 'reject';

type Mode =
  | { kind: 'idle' }
  | { kind: 'confirming_reject' }
  | { kind: 'requesting_changes'; note: string };

interface ApprovalRowActionsProps {
  quoteId: string;
  bidId: string;
}

export function ApprovalRowActions({ quoteId, bidId }: ApprovalRowActionsProps) {
  const router = useRouter();
  const [mode, setMode] = React.useState<Mode>({ kind: 'idle' });
  const [submittingAction, setSubmittingAction] = React.useState<Action | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = React.useState(false);

  // Auto-clear an error banner after a few seconds so the table isn't
  // cluttered with stale warnings on retries. Clears if the component
  // unmounts mid-timeout.
  React.useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4500);
    return () => clearTimeout(t);
  }, [error]);

  // Close the overflow menu on Escape / outside click. The menu is a
  // relatively positioned panel inside the table cell so we don't need a
  // portal / focus trap for this small surface.
  const overflowRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!overflowOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverflowOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (!overflowRef.current) return;
      if (!overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [overflowOpen]);

  const postVerdict = React.useCallback(
    async (action: Action, notes?: string): Promise<void> => {
      setSubmittingAction(action);
      setError(null);
      try {
        const res = await fetch('/api/manager/approvals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quoteId,
            action,
            ...(notes && notes.trim() ? { notes: notes.trim() } : {}),
          }),
        });
        if (!res.ok) {
          let msg = `Verdict failed (${res.status})`;
          try {
            const body = (await res.json()) as { error?: string };
            if (body?.error) msg = body.error;
          } catch {
            // swallow — the default message is fine
          }
          throw new Error(msg);
        }
        // Reset all local UI state; router.refresh re-reads the queue on
        // the server and this row drops out.
        setMode({ kind: 'idle' });
        setSubmittingAction(null);
        router.refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Verdict failed';
        setError(msg);
        setSubmittingAction(null);
      }
    },
    [quoteId, router],
  );

  // --- Inline note form for request-changes --------------------------------
  if (mode.kind === 'requesting_changes') {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={mode.note}
            onChange={(e) =>
              setMode({ kind: 'requesting_changes', note: e.target.value })
            }
            onKeyDown={(e) => {
              if (e.key === 'Escape') setMode({ kind: 'idle' });
              if (e.key === 'Enter') {
                e.preventDefault();
                void postVerdict('request_changes', mode.note);
              }
            }}
            placeholder="Reason (optional)"
            aria-label="Reason for requesting changes"
            autoFocus
            className="h-8 w-48 rounded-sm border border-border-base bg-bg-subtle px-2 text-body-sm text-text-primary placeholder:text-text-tertiary focus:border-accent-primary focus:shadow-accent focus:outline-none"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void postVerdict('request_changes', mode.note)}
            loading={submittingAction === 'request_changes'}
            disabled={submittingAction !== null}
          >
            Send
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setMode({ kind: 'idle' })}
            disabled={submittingAction !== null}
            aria-label="Cancel request changes"
          >
            Cancel
          </Button>
        </div>
        {error && <ErrorLine message={error} />}
      </div>
    );
  }

  // --- Reject confirm -------------------------------------------------------
  if (mode.kind === 'confirming_reject') {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1">
          <span className="text-caption text-semantic-error">
            Reject quote?
          </span>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => void postVerdict('reject')}
            loading={submittingAction === 'reject'}
            disabled={submittingAction !== null}
          >
            Confirm reject
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setMode({ kind: 'idle' })}
            disabled={submittingAction !== null}
          >
            Cancel
          </Button>
        </div>
        {error && <ErrorLine message={error} />}
      </div>
    );
  }

  // --- Idle: three actions + overflow --------------------------------------
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => void postVerdict('approve')}
          loading={submittingAction === 'approve'}
          disabled={submittingAction !== null}
        >
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Approve
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setMode({ kind: 'requesting_changes', note: '' })}
          disabled={submittingAction !== null}
          aria-label="Request changes"
          title="Request changes"
        >
          <MessageSquareWarning className="h-3.5 w-3.5" aria-hidden="true" />
          Request changes
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => setMode({ kind: 'confirming_reject' })}
          disabled={submittingAction !== null}
          aria-label="Reject"
          title="Reject"
        >
          <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
          Reject
        </Button>
        <div ref={overflowRef} className="relative">
          <Button
            type="button"
            variant="icon"
            size="sm"
            onClick={() => setOverflowOpen((v) => !v)}
            disabled={submittingAction !== null}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
          >
            <MoreVertical className="h-4 w-4" aria-hidden="true" />
          </Button>
          {overflowOpen && (
            <div
              role="menu"
              className={cn(
                'absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-sm',
                'border border-border-base bg-bg-elevated shadow-lg',
              )}
            >
              <Link
                role="menuitem"
                href={`/bids/${bidId}/margin`}
                className="flex items-center gap-2 px-3 py-2 text-body-sm text-text-primary transition-colors duration-micro hover:bg-bg-subtle"
                onClick={() => setOverflowOpen(false)}
              >
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                Review full stack
              </Link>
            </div>
          )}
        </div>
      </div>
      {error && <ErrorLine message={error} />}
    </div>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <span
      role="alert"
      className="inline-flex items-center gap-1 text-caption text-semantic-error"
    >
      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
      {message}
    </span>
  );
}
