/**
 * QuotePreview — iframe embed for the rendered customer quote PDF.
 *
 * Purpose:  Pure presentational client component that embeds the PDF
 *           bytes produced by POST /api/quote (action: 'preview') inside
 *           an <iframe>. Also surfaces any unit-validation warnings
 *           forwarded by the client bridge. The wrapper surface stays
 *           dark per design system; only the PDF interior is light
 *           (it's the customer-facing document).
 *
 *           Vendor names / costs / margin do NOT flow into this
 *           component — the PDF is rendered server-side from
 *           QuotePdfInput which is already vendor-structurally free.
 *
 * Inputs:   pdfUrl (blob URL), downloading?, warnings?.
 * Outputs:  JSX.
 * Agent/API: none — PDF is fetched upstream in QuotePreviewClient.
 * Imports:  lucide-react.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { AlertTriangle, FileText } from 'lucide-react';

export interface QuotePreviewProps {
  pdfUrl: string | null;
  downloading?: boolean;
  warnings?: string[];
}

export function QuotePreview({
  pdfUrl,
  downloading,
  warnings,
}: QuotePreviewProps) {
  const hasWarnings = warnings && warnings.length > 0;

  return (
    <div className="flex flex-col gap-3">
      {hasWarnings && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-[rgba(232,168,50,0.4)] bg-[rgba(232,168,50,0.08)] px-3 py-2 text-body-sm text-semantic-warning"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div>
            <div className="text-label uppercase">Preview warnings</div>
            <div className="mt-0.5 text-caption text-text-secondary">
              {warnings.length} line{warnings.length === 1 ? '' : 's'} with
              unsupported units. Release will fail until extraction is fixed.
            </div>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-border-base bg-bg-surface shadow-sm">
        <div className="flex items-center justify-between border-b border-border-subtle bg-bg-elevated px-3 py-2">
          <div className="inline-flex items-center gap-2 text-label uppercase text-text-tertiary">
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            Customer PDF preview
          </div>
          <div className="text-caption text-text-tertiary">
            {downloading
              ? 'Rendering…'
              : pdfUrl
                ? 'Rendered'
                : 'Awaiting render'}
          </div>
        </div>

        <div className="min-h-[640px] w-full bg-bg-base">
          {pdfUrl ? (
            <iframe
              key={pdfUrl}
              src={pdfUrl}
              title="Customer quote preview"
              className="h-[80vh] w-full"
            />
          ) : (
            <div className="flex h-[640px] items-center justify-center text-body-sm text-text-tertiary">
              {downloading ? 'Rendering preview…' : 'No preview loaded yet.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
