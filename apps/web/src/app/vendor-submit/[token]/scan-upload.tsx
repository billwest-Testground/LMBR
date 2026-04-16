/**
 * ScanUpload — client component for the paper-workflow upload path.
 *
 * Purpose:  Sibling of SubmitForm on the public /vendor-submit/[token]
 *           page. Vendors who prefer paper printed the Task 4 tally PDF,
 *           hand-wrote prices, and scanned the sheet — this component
 *           lets them upload that image/PDF back. It multipart-POSTs to
 *           /api/extract with the vendor's token and the chosen file.
 *           On success the server has already written prices to
 *           vendor_bid_line_items and flipped submission_method='scan',
 *           so the UI just renders a confirmation banner showing how
 *           many lines were matched and which (if any) need manual
 *           follow-up on the form path.
 *
 *           Accessibility:
 *           - File input has a visible label + aria-label.
 *           - Upload button is disabled while pending, with aria-busy.
 *           - Result and error blocks use role="status" / role="alert"
 *             so screen readers announce them immediately.
 *
 *           Security note: the token is a prop because it's already in
 *           the URL path of the parent server component. We don't send
 *           cookies or session data — the server re-authenticates by
 *           verifying the HMAC signature on every request.
 *
 * Inputs:   { token: string, expectedLineCount: number }.
 * Outputs:  JSX upload panel + result banner.
 * Agent/API: POSTs multipart to /api/extract.
 * Imports:  react, ../../../components/ui/button.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';

import { Button } from '../../../components/ui/button';

// Accepted types must mirror the server-side whitelist in /api/extract.
// Listed explicitly (not just "image/*,application/pdf") so the browser
// file picker filters to the exact same formats Azure can OCR.
const ACCEPT_ATTR = 'image/png,image/jpeg,image/webp,application/pdf';
const MAX_FILE_MB = 25;

interface ScanUploadProps {
  token: string;
  /** Number of lines the vendor was asked to price — shown in the banner. */
  expectedLineCount: number;
}

interface ExtractSuccessBody {
  success: true;
  status: 'submitted' | 'partial';
  pricedCount: number;
  expectedCount: number;
  unmatchedLineItemIds: string[];
  extractionCostCents: number;
  ocrConfidence: number;
  ocrPages?: number;
}

interface ExtractErrorBody {
  error: string;
}

type ExtractResponse = ExtractSuccessBody | ExtractErrorBody;

function isSuccess(body: ExtractResponse): body is ExtractSuccessBody {
  return 'success' in body && body.success === true;
}

export function ScanUpload({
  token,
  expectedLineCount,
}: ScanUploadProps): React.ReactElement {
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ExtractSuccessBody | null>(null);

  function onChooseFile(ev: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    setResult(null);
    const file = ev.target.files?.[0] ?? null;
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      setError(`File is too large. Max ${MAX_FILE_MB} MB.`);
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
  }

  async function onUpload() {
    if (!selectedFile) {
      setError('Choose a file first.');
      return;
    }
    setError(null);
    setResult(null);
    setPending(true);

    const body = new FormData();
    body.append('token', token);
    body.append('file', selectedFile);

    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        body,
      });
      let parsed: ExtractResponse;
      try {
        parsed = (await res.json()) as ExtractResponse;
      } catch {
        setError('Server returned an unreadable response. Please try again.');
        setPending(false);
        return;
      }
      if (!res.ok || !isSuccess(parsed)) {
        setError(
          !isSuccess(parsed) && parsed.error
            ? parsed.error
            : 'Upload failed. Please try again.',
        );
        setPending(false);
        return;
      }
      setResult(parsed);
      setPending(false);
      // Clear the picker so the user can re-upload a revised scan without
      // first having to click "Cancel". Without this the file input keeps
      // the same name and a second pick with the same filename won't fire
      // onChange.
      if (fileInputRef.current) fileInputRef.current.value = '';
      setSelectedFile(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
      setPending(false);
    }
  }

  // Derive the banner flavour. 'submitted' = every line matched; 'partial'
  // = some lines matched, some still need attention on the form path.
  const banner = result
    ? result.status === 'submitted'
      ? {
          tone: 'success' as const,
          text: `All ${result.expectedCount} line${result.expectedCount === 1 ? '' : 's'} matched from your scan. The buyer has been notified.`,
        }
      : {
          tone: 'warning' as const,
          text: `Matched ${result.pricedCount} of ${result.expectedCount} lines from your scan. ${result.unmatchedLineItemIds.length} line${result.unmatchedLineItemIds.length === 1 ? '' : 's'} could not be read — you can fill those in on the form tab, or re-upload a clearer scan.`,
        }
    : null;

  return (
    <section
      aria-labelledby="scan-upload-heading"
      className="rounded-lg border border-border-base bg-bg-surface p-6 shadow-sm"
    >
      <h2
        id="scan-upload-heading"
        className="text-h4 text-text-primary"
      >
        Upload scanned sheet
      </h2>
      <p className="mt-2 text-body-sm text-text-secondary">
        Printed the tally, wrote prices by hand? Upload a scan or phone
        photo of the page and we will read the prices back automatically.
        PNG, JPEG, WEBP, or PDF — up to {MAX_FILE_MB} MB.
      </p>
      <p className="mt-1 text-body-sm text-text-tertiary">
        {expectedLineCount.toLocaleString()} line
        {expectedLineCount === 1 ? '' : 's'} expected on this sheet.
      </p>

      {banner && (
        <div
          role="status"
          className={
            'mt-4 rounded-md px-4 py-3 text-body-sm ' +
            (banner.tone === 'success'
              ? 'border border-[rgba(29,184,122,0.4)] bg-[rgba(29,184,122,0.08)] text-semantic-success'
              : 'border border-[rgba(219,155,65,0.4)] bg-[rgba(219,155,65,0.10)] text-semantic-warning')
          }
        >
          {banner.text}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.10)] px-4 py-3 text-body-sm text-semantic-error"
        >
          {error}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label
          htmlFor="scan-upload-file"
          className="text-label uppercase text-text-tertiary"
        >
          Choose file
        </label>
        <input
          ref={fileInputRef}
          id="scan-upload-file"
          type="file"
          accept={ACCEPT_ATTR}
          onChange={onChooseFile}
          disabled={pending}
          aria-label="Choose scanned price sheet"
          className="block text-body-sm text-text-secondary file:mr-3 file:cursor-pointer file:rounded-sm file:border file:border-border-strong file:bg-transparent file:px-3 file:py-1.5 file:text-body-sm file:text-text-primary file:transition-colors hover:file:bg-bg-elevated disabled:opacity-40"
        />
      </div>

      <div className="mt-4">
        <Button
          type="button"
          onClick={() => {
            void onUpload();
          }}
          disabled={!selectedFile || pending}
          loading={pending}
        >
          {pending ? 'Extracting prices…' : 'Upload and extract'}
        </Button>
      </div>
    </section>
  );
}
