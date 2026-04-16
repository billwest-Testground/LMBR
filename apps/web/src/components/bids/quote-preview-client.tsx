/**
 * QuotePreviewClient — client-side controller for the quote preview page.
 *
 * Purpose:  Owns the fetch-to-blob-URL handshake with POST /api/quote
 *           (preview + release actions), renders the <QuotePreview>
 *           iframe, surfaces the current quote status, and exposes the
 *           Release control for managers/owners. Outlook send-via-email
 *           is stubbed today (lands in Prompt 08) behind a modal that
 *           gives the user "copy link" + "download" actions so they can
 *           hand-send.
 *
 * Inputs:   bidId, quote summary, customerName.
 * Outputs:  JSX.
 * Agent/API: POST /api/quote.
 * Imports:  next/navigation, lucide-react, ../ui/button, ./quote-preview.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import {
  CheckCircle2,
  Copy,
  Download,
  FileCheck2,
  Mail,
  RefreshCw,
  X,
} from 'lucide-react';

import { Button } from '../ui/button';
import { cn } from '../../lib/cn';
import { QuotePreview } from './quote-preview';

export interface QuotePreviewClientQuote {
  id: string;
  status:
    | 'draft'
    | 'pending_approval'
    | 'approved'
    | 'sent'
    | 'accepted'
    | 'declined';
  total: number;
  pdfUrl: string | null;
}

export interface QuotePreviewClientProps {
  bidId: string;
  customerName: string;
  quote: QuotePreviewClientQuote | null;
  canRelease: boolean;
}

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function QuotePreviewClient({
  bidId,
  customerName,
  quote,
  canRelease,
}: QuotePreviewClientProps) {
  const [pdfUrl, setPdfUrl] = React.useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = React.useState(false);
  const [releasing, setReleasing] = React.useState(false);
  const [warnings, setWarnings] = React.useState<string[]>([]);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [releasedPdfUrl, setReleasedPdfUrl] = React.useState<string | null>(
    null,
  );
  const [releasedQuoteNumber, setReleasedQuoteNumber] = React.useState<
    string | null
  >(null);
  const [sendModalOpen, setSendModalOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const activeBlobRef = React.useRef<string | null>(null);

  const fetchPreview = React.useCallback(async () => {
    if (!quote?.id) return;
    setLoadingPreview(true);
    setServerError(null);
    try {
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bidId, action: 'preview' }),
      });
      if (!res.ok) {
        let msg = `Preview failed (${res.status})`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) msg = body.error;
        } catch {
          // default msg
        }
        throw new Error(msg);
      }
      const warnHeader = res.headers.get('X-Quote-Warnings');
      if (warnHeader) {
        try {
          const parsed = JSON.parse(warnHeader) as {
            invalidUnitLineItemIds?: string[];
          };
          setWarnings(parsed.invalidUnitLineItemIds ?? []);
        } catch {
          setWarnings([]);
        }
      } else {
        setWarnings([]);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (activeBlobRef.current) URL.revokeObjectURL(activeBlobRef.current);
      activeBlobRef.current = url;
      setPdfUrl(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Preview failed';
      setServerError(msg);
    } finally {
      setLoadingPreview(false);
    }
  }, [bidId, quote?.id]);

  // Trigger initial preview on mount when a quote exists.
  React.useEffect(() => {
    if (quote?.id) {
      void fetchPreview();
    }
    return () => {
      if (activeBlobRef.current) {
        URL.revokeObjectURL(activeBlobRef.current);
        activeBlobRef.current = null;
      }
    };
  }, [fetchPreview, quote?.id]);

  const handleRelease = React.useCallback(async () => {
    setReleasing(true);
    setServerError(null);
    try {
      const res = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bidId, action: 'release' }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        pdfUrl?: string;
        quoteNumber?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? body.message ?? `Release failed (${res.status})`);
      }
      setReleasedPdfUrl(body.pdfUrl ?? null);
      setReleasedQuoteNumber(body.quoteNumber ?? null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Release failed';
      setServerError(msg);
    } finally {
      setReleasing(false);
    }
  }, [bidId]);

  const handleDownload = React.useCallback(() => {
    if (!pdfUrl) return;
    const a = document.createElement('a');
    a.href = pdfUrl;
    a.download = `${customerName || 'quote'}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [customerName, pdfUrl]);

  const handleCopyLink = React.useCallback(async () => {
    if (!releasedPdfUrl) return;
    try {
      await navigator.clipboard.writeText(releasedPdfUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be denied (non-secure context); no-op.
    }
  }, [releasedPdfUrl]);

  const statusStyle = QUOTE_STATUS_STYLES[quote?.status ?? 'draft'];
  const isDraft = quote?.status === 'draft';
  const releaseDisabled = !canRelease || isDraft || releasing || !quote;

  return (
    <div className="flex flex-col gap-4">
      {/* Meta + status + actions ---------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border-base bg-bg-surface p-4 shadow-sm">
        <div>
          <div className="text-label uppercase text-text-tertiary">
            Quote status
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center rounded-pill px-2 py-0.5 text-label uppercase',
                statusStyle.bg,
                statusStyle.text,
              )}
            >
              {quote?.status ?? 'no quote'}
            </span>
            {quote && (
              <span className="font-mono tabular-nums text-body text-text-primary">
                {USD.format(quote.total)}
              </span>
            )}
          </div>
          {releasedQuoteNumber && (
            <div className="mt-1 text-caption text-accent-primary">
              Released as{' '}
              <span className="font-mono tabular-nums">
                {releasedQuoteNumber}
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={fetchPreview}
            loading={loadingPreview}
            disabled={loadingPreview || !quote}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Re-preview
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleDownload}
            disabled={!pdfUrl}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Download
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleRelease}
            loading={releasing}
            disabled={releaseDisabled}
            title={
              !canRelease
                ? 'Release requires manager or owner role'
                : isDraft
                  ? 'Quote is a draft — submit for approval first'
                  : undefined
            }
          >
            <FileCheck2 className="h-4 w-4" aria-hidden="true" />
            Release to customer
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setSendModalOpen(true)}
            disabled={!releasedPdfUrl && !pdfUrl}
          >
            <Mail className="h-4 w-4" aria-hidden="true" />
            Send via Outlook
          </Button>
        </div>
      </div>

      {serverError && (
        <div
          role="alert"
          className="rounded-md border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.08)] px-3 py-2 text-body-sm text-semantic-error"
        >
          {serverError}
        </div>
      )}

      {isDraft && (
        <div
          role="status"
          className="rounded-md border border-[rgba(232,168,50,0.4)] bg-[rgba(232,168,50,0.08)] px-3 py-2 text-body-sm text-semantic-warning"
        >
          This quote is a draft. Open the margin stack and submit for approval
          to unlock release.
        </div>
      )}

      <QuotePreview
        pdfUrl={pdfUrl}
        downloading={loadingPreview}
        warnings={warnings}
      />

      {sendModalOpen && (
        <SendModal
          pdfUrl={releasedPdfUrl}
          quoteNumber={releasedQuoteNumber}
          onClose={() => setSendModalOpen(false)}
          onCopy={handleCopyLink}
          onDownload={handleDownload}
          copied={copied}
        />
      )}
    </div>
  );
}

function SendModal({
  pdfUrl,
  quoteNumber,
  onClose,
  onCopy,
  onDownload,
  copied,
}: {
  pdfUrl: string | null;
  quoteNumber: string | null;
  onClose: () => void;
  onCopy: () => void;
  onDownload: () => void;
  copied: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Send via Outlook"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.7)] backdrop-blur-[4px]"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[calc(100vw-2rem)] rounded-lg border border-border-strong bg-bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-border-subtle px-6 pb-4 pt-5">
          <div>
            <h3 className="text-h3 text-text-primary">Send via Outlook</h3>
            <p className="mt-1 text-caption text-text-tertiary">
              Email hand-off lands in Prompt 08.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-sm p-1 text-text-tertiary transition-colors duration-micro hover:bg-bg-elevated hover:text-text-primary"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="px-6 py-5 text-body-sm text-text-secondary">
          <p>
            Outlook integration is scheduled for Prompt 08 — it will send from
            the user&apos;s own mailbox via Microsoft Graph. In the meantime,
            copy the signed link below (or download the PDF) and hand-send
            from Outlook.
          </p>
          {pdfUrl ? (
            <div className="mt-4 rounded-md border border-border-base bg-bg-subtle px-3 py-2">
              <div className="text-label uppercase text-text-tertiary">
                Released link {quoteNumber ? `(${quoteNumber})` : ''}
              </div>
              <div className="mt-1 break-all font-mono text-caption text-text-primary">
                {pdfUrl}
              </div>
            </div>
          ) : (
            <div className="mt-4 rounded-md border border-border-base bg-bg-subtle px-3 py-2 text-caption text-text-tertiary">
              Release the quote first to generate a shareable link.
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border-subtle px-6 py-4">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onDownload}
          >
            <Download className="h-4 w-4" aria-hidden="true" />
            Download PDF
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={onCopy}
            disabled={!pdfUrl}
          >
            {copied ? (
              <>
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" aria-hidden="true" />
                Copy link
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

const QUOTE_STATUS_STYLES: Record<
  QuotePreviewClientQuote['status'] | 'draft',
  { bg: string; text: string }
> = {
  draft: {
    bg: 'bg-bg-subtle',
    text: 'text-text-secondary',
  },
  pending_approval: {
    bg: 'bg-[rgba(232,168,50,0.15)]',
    text: 'text-semantic-warning',
  },
  approved: {
    bg: 'bg-[rgba(29,184,122,0.15)]',
    text: 'text-accent-primary',
  },
  sent: {
    bg: 'bg-[rgba(74,158,232,0.15)]',
    text: 'text-semantic-info',
  },
  accepted: {
    bg: 'bg-[rgba(29,184,122,0.15)]',
    text: 'text-accent-primary',
  },
  declined: {
    bg: 'bg-[rgba(232,84,72,0.15)]',
    text: 'text-semantic-error',
  },
};
