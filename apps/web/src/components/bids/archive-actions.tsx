/**
 * ArchiveActions — inline archive / reactivate controls for a bid.
 *
 * Purpose:  Two client islands in one file, mounted on the bid detail
 *           server component:
 *             - <ArchiveActionButton /> — the "Archive bid" button +
 *               inline confirm dialog (not a modal). Shown only when
 *               canArchive is true and the bid is not already archived.
 *             - <ArchivedBanner /> — the amber "This bid is archived"
 *               banner with a Reactivate link that opens a modal
 *               (continue / fresh).
 *
 *           Archive success redirects to /archive so the trader lands
 *           on the archived tab with the just-archived bid at the top.
 *           Reactivate success refreshes the current page so the
 *           banner disappears and status/consolidation updates (for
 *           fresh mode) land without a hard reload.
 *
 * Inputs:   bidId, bidLabel (job or customer name — for modal copy),
 *           archivedAt (null = active), canArchive (role gate computed
 *           server-side).
 * Outputs:  JSX.
 * Agent/API: POST /api/bids/[bidId]/archive
 *            POST /api/bids/[bidId]/reactivate
 * Imports:  react, next/navigation, lucide-react, ../ui/button, ../../lib/cn.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Archive as ArchiveIcon, AlertTriangle, X } from 'lucide-react';

import { Button } from '../ui/button';
import { cn } from '../../lib/cn';

// ---------------------------------------------------------------------------
// Archive action button (+ inline confirm)
// ---------------------------------------------------------------------------

export function ArchiveActionButton({ bidId }: { bidId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function archive() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/bids/${bidId}/archive`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Archive failed (${res.status}).`);
        return;
      }
      // Route string is fine here — /archive exists in the file tree so
      // typedRoutes resolves it.
      router.push('/archive');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Archive failed.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        onClick={() => setConfirming(true)}
        aria-label="Archive bid"
      >
        <ArchiveIcon className="h-4 w-4" aria-hidden="true" />
        Archive
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-sm border border-border-subtle bg-bg-subtle p-2">
      <span className="text-body-sm text-text-secondary">
        Archive this bid? It will be removed from your active pipeline but
        can be reactivated at any time.
      </span>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => void archive()}
        loading={submitting}
      >
        Archive
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(false)}
        disabled={submitting}
      >
        Cancel
      </Button>
      {error ? (
        <span className="text-body-sm text-semantic-error">{error}</span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Archived banner + reactivate modal
// ---------------------------------------------------------------------------

export function ArchivedBanner({
  bidId,
  bidLabel,
  archivedAt,
  canReactivate,
}: {
  bidId: string;
  bidLabel: string;
  archivedAt: string;
  canReactivate: boolean;
}) {
  const [modalOpen, setModalOpen] = React.useState(false);
  return (
    <>
      <div className="flex items-start gap-2 rounded-sm border border-[rgba(232,172,72,0.3)] bg-[rgba(232,172,72,0.08)] px-3 py-2 text-body-sm text-semantic-warning">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 flex-none"
          aria-hidden="true"
        />
        <span className="flex-1">This bid is archived.</span>
        {canReactivate ? (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="font-medium underline-offset-2 hover:underline"
          >
            Reactivate →
          </button>
        ) : null}
      </div>
      {modalOpen ? (
        <ReactivationModal
          bidId={bidId}
          bidLabel={bidLabel}
          archivedAt={archivedAt}
          onClose={() => setModalOpen(false)}
        />
      ) : null}
    </>
  );
}

function ReactivationModal({
  bidId,
  bidLabel,
  archivedAt,
  onClose,
}: {
  bidId: string;
  bidLabel: string;
  archivedAt: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState<
    null | 'continue' | 'fresh'
  >(null);
  const [error, setError] = React.useState<string | null>(null);

  async function call(mode: 'continue' | 'fresh') {
    setSubmitting(mode);
    setError(null);
    try {
      const res = await fetch(`/api/bids/${bidId}/reactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Reactivate failed (${res.status}).`);
        return;
      }
      // Refresh the server component so the banner disappears and the
      // status/consolidation updates land.
      router.refresh();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reactivate failed.');
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(10,14,12,0.7)] p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bd-reactivate-title"
    >
      <div className="w-full max-w-lg rounded-md border border-border-base bg-bg-surface p-5 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <h2 id="bd-reactivate-title" className="text-h3 text-text-primary">
            Reactivate this bid
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm p-1 text-text-tertiary hover:bg-bg-subtle hover:text-text-primary"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-2 text-body text-text-secondary">
          <span className="text-text-primary">{bidLabel}</span> was archived{' '}
          {formatRelative(archivedAt)}. How would you like to bring it back?
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <Option
            title="Continue where you left off"
            body="Restores the bid as-is — same status, same consolidation, same routing. Use this when you're resuming work."
            onClick={() => void call('continue')}
            loading={submitting === 'continue'}
            disabled={submitting !== null}
            variant="primary"
          />
          <Option
            title="Start fresh"
            body="Resets the bid to 'received', clears routing, and sets consolidation to structured. Line items and vendor pricing history are kept."
            onClick={() => void call('fresh')}
            loading={submitting === 'fresh'}
            disabled={submitting !== null}
            variant="secondary"
          />
        </div>
        {error ? (
          <p className="mt-3 text-body-sm text-semantic-error">{error}</p>
        ) : null}
        <div className="mt-4 flex justify-end">
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={submitting !== null}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function Option({
  title,
  body,
  onClick,
  loading,
  disabled,
  variant,
}: {
  title: string;
  body: string;
  onClick: () => void;
  loading: boolean;
  disabled: boolean;
  variant: 'primary' | 'secondary';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'group flex flex-col gap-1 rounded-sm border px-3 py-3 text-left transition-colors duration-micro',
        variant === 'primary'
          ? 'border-[rgba(29,184,122,0.3)] bg-[rgba(29,184,122,0.06)] hover:bg-[rgba(29,184,122,0.12)]'
          : 'border-border-subtle bg-bg-subtle hover:bg-bg-elevated',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span
        className={cn(
          'text-body font-medium',
          variant === 'primary' ? 'text-accent-primary' : 'text-text-primary',
        )}
      >
        {loading ? `${title}…` : title}
      </span>
      <span className="text-body-sm text-text-secondary">{body}</span>
    </button>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'some time ago';
  const diffMs = Date.now() - t;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
