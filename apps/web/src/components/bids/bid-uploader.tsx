/**
 * BidUploader — drag-and-drop ingest surface.
 *
 * Purpose:  Front-door component for the LMBR.ai ingest pipeline. Accepts
 *           PDFs, Excel workbooks, photographed lumber lists, raw email
 *           text, or Outlook .msg files and POSTs them to /api/ingest
 *           which runs the extraction → QA pipeline. Shows a live status
 *           reel while the agents run (per README §9 — "loading states
 *           tell a story") and hands the parsed result back to its
 *           parent via `onIngested`.
 *
 * Inputs:   drag/drop, file picker, or pasted email text. Optional
 *           customer name + job name metadata.
 * Outputs:  JSX surface + onIngested({ bidId, extraction, qaReport })
 *           callback.
 * Agent/API: POST /api/ingest → ingest-agent → extraction-agent →
 *           qa-agent.
 * Imports:  react-dropzone, lucide-react icons, design-system primitives.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import {
  UploadCloud,
  FileText,
  Image as ImageIcon,
  Mail,
  X,
  FileSpreadsheet,
} from 'lucide-react';

import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { cn } from '../../lib/cn';
import type { ExtractionOutput } from '@lmbr/types';
import type { QaReport } from '@lmbr/agents';

/**
 * Extraction method badge the route returns on the inline path. Matches
 * the `methodUsed` field of ProcessIngestResult: either a raw analyzer
 * method (free paths + OCR) or one of the Claude-assisted modes.
 */
export type IngestMethodUsed =
  | 'excel_parse'
  | 'csv_parse'
  | 'docx_parse'
  | 'pdf_direct'
  | 'ocr'
  | 'email_text'
  | 'direct_text'
  | 'claude_extraction'
  | 'claude_mode_a'
  | 'claude_mode_b';

export interface IngestExtractionReport {
  method_used: IngestMethodUsed;
  total_cost_cents: number;
  total_line_items: number;
  overall_confidence: number;
  qa_passed: boolean;
}

export interface IngestResponse {
  bid_id: string;
  extraction: ExtractionOutput;
  qa_report: QaReport;
  raw_file_url: string | null;
  extraction_report?: IngestExtractionReport;
}

export interface BidUploaderProps {
  onIngested?: (result: IngestResponse) => void;
}

type UploadMode = 'file' | 'paste';

const ACCEPTED_MIMES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-excel': ['.xls'],
  'text/csv': ['.csv'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    '.docx',
  ],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/tiff': ['.tiff', '.tif'],
  'image/bmp': ['.bmp'],
  'text/plain': ['.txt'],
  'message/rfc822': ['.eml'],
  'application/vnd.ms-outlook': ['.msg'],
};

/**
 * Tiered status reels (Session Prompt 04). We don't get real progress
 * events from the server, so the reel is chosen by source type — the
 * trader sees messages that match the extraction path their file will
 * actually take, which also educates them about why an Excel upload is
 * essentially free while a scanned photo costs real money.
 */
const REEL_EXCEL = [
  'Analyzing file format…',
  'Parsing Excel columns…',
  'Grouping by building / phase…',
  'Running quality check…',
] as const;

const REEL_CSV = [
  'Analyzing file format…',
  'Parsing CSV rows…',
  'Grouping by building / phase…',
  'Running quality check…',
] as const;

const REEL_PDF = [
  'Analyzing file format…',
  'Extracting text from PDF…',
  'Grouping by building / phase…',
  'Running quality check…',
] as const;

const REEL_DOCX = [
  'Analyzing file format…',
  'Extracting text from document…',
  'Grouping by building / phase…',
  'Running quality check…',
] as const;

const REEL_OCR = [
  'Analyzing file format…',
  'Running OCR scan…',
  'Cleaning up with AI…',
  'Running quality check…',
] as const;

const REEL_TEXT = [
  'Reading pasted text…',
  'Parsing lines…',
  'Grouping by building / phase…',
  'Running quality check…',
] as const;

const REEL_GENERIC = [
  'Analyzing file format…',
  'Extracting lumber list…',
  'Grouping by building / phase…',
  'Running quality check…',
] as const;

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

function pickStatusReel(
  mode: 'file' | 'paste',
  file: File | null,
): readonly string[] {
  if (mode === 'paste') return REEL_TEXT;
  if (!file) return REEL_GENERIC;
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return REEL_EXCEL;
  if (name.endsWith('.csv')) return REEL_CSV;
  if (name.endsWith('.pdf')) return REEL_PDF;
  if (name.endsWith('.docx')) return REEL_DOCX;
  if (/\.(png|jpe?g|tiff?|bmp)$/.test(name)) return REEL_OCR;
  if (name.endsWith('.txt') || name.endsWith('.eml') || name.endsWith('.msg')) {
    return REEL_TEXT;
  }
  return REEL_GENERIC;
}

/**
 * Dev-only cost badge — only rendered in non-production builds so
 * traders don't see the sub-cent breakdown on a live tenant. Matches
 * the Session Prompt 04 spec for "small badge showing extraction cost".
 */
const COST_BADGE_ENABLED =
  process.env['NEXT_PUBLIC_APP_ENV'] !== 'production';

function formatCostCents(cents: number): string {
  if (cents < 0.1) return '< 0.1¢';
  if (cents < 1) return `${cents.toFixed(2)}¢`;
  return `${cents.toFixed(1)}¢`;
}

// -----------------------------------------------------------------------------

export function BidUploader({ onIngested }: BidUploaderProps) {
  const [mode, setMode] = React.useState<UploadMode>('file');
  const [file, setFile] = React.useState<File | null>(null);
  const [pastedText, setPastedText] = React.useState('');
  const [customerName, setCustomerName] = React.useState('');
  const [jobName, setJobName] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [statusIndex, setStatusIndex] = React.useState(0);
  // Dev-only cost badge surfaced briefly after a successful inline
  // ingest. Cleared when the parent unmounts this component or the
  // trader uploads another file.
  const [lastCostBadge, setLastCostBadge] =
    React.useState<IngestExtractionReport | null>(null);

  const statusReel = React.useMemo(
    () => pickStatusReel(mode, file),
    [mode, file],
  );

  // Rotate status messages while upload is in flight — README §9.
  React.useEffect(() => {
    if (!loading) {
      setStatusIndex(0);
      return;
    }
    const interval = window.setInterval(() => {
      setStatusIndex((prev) => (prev + 1) % statusReel.length);
    }, 1800);
    return () => window.clearInterval(interval);
  }, [loading, statusReel.length]);

  const onDrop = React.useCallback(
    (accepted: File[], rejected: FileRejection[]) => {
      setError(null);
      if (rejected.length > 0) {
        const reason = rejected[0].errors[0]?.code;
        if (reason === 'file-too-large') {
          setError('That file is over 25 MB — compress or split it.');
        } else if (reason === 'file-invalid-type') {
          setError('Unsupported file type. Try PDF, XLSX, PNG, JPG, or TXT.');
        } else {
          setError('Could not read that file. Try another.');
        }
        return;
      }
      if (accepted[0]) setFile(accepted[0]);
    },
    [],
  );

  const {
    getRootProps,
    getInputProps,
    isDragActive,
    isDragReject,
  } = useDropzone({
    onDrop,
    accept: ACCEPTED_MIMES,
    multiple: false,
    maxSize: MAX_FILE_BYTES,
    disabled: loading,
  });

  async function handleSubmit() {
    setError(null);

    if (mode === 'file' && !file) {
      setError('Drop a lumber list first.');
      return;
    }
    if (mode === 'paste' && pastedText.trim().length < 10) {
      setError('Paste the lumber list text above (at least a few lines).');
      return;
    }

    setLoading(true);
    try {
      let res: Response;
      if (mode === 'file' && file) {
        const form = new FormData();
        form.append('file', file);
        if (customerName.trim()) form.append('customerName', customerName.trim());
        if (jobName.trim()) form.append('jobName', jobName.trim());
        res = await fetch('/api/ingest', { method: 'POST', body: form });
      } else {
        res = await fetch('/api/ingest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            rawText: pastedText,
            customerName: customerName.trim() || undefined,
            jobName: jobName.trim() || undefined,
          }),
        });
      }

      const body = (await res.json().catch(() => ({}))) as
        | IngestResponse
        | { error?: string };

      if (!res.ok) {
        const message =
          (body as { error?: string }).error ?? 'Ingest failed. Try again.';
        setError(message);
        return;
      }

      const response = body as IngestResponse;
      if (COST_BADGE_ENABLED && response.extraction_report) {
        setLastCostBadge(response.extraction_report);
      }
      onIngested?.(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error during ingest.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Mode toggle ------------------------------------------------------ */}
      <div className="inline-flex self-start rounded-pill border border-border-base bg-bg-subtle p-1">
        <ModeButton
          active={mode === 'file'}
          onClick={() => setMode('file')}
          disabled={loading}
        >
          <UploadCloud className="h-3.5 w-3.5" aria-hidden="true" />
          Upload file
        </ModeButton>
        <ModeButton
          active={mode === 'paste'}
          onClick={() => setMode('paste')}
          disabled={loading}
        >
          <Mail className="h-3.5 w-3.5" aria-hidden="true" />
          Paste email text
        </ModeButton>
      </div>

      {/* Customer metadata ------------------------------------------------- */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <Label htmlFor="customer-name">Customer name</Label>
          <Input
            id="customer-name"
            placeholder="Mt. Hood Builders LLC"
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            disabled={loading}
          />
        </div>
        <div>
          <Label htmlFor="job-name">Job / project name (optional)</Label>
          <Input
            id="job-name"
            placeholder="Phase 3 — Building 7"
            value={jobName}
            onChange={(e) => setJobName(e.target.value)}
            disabled={loading}
          />
        </div>
      </div>

      {/* File dropzone ----------------------------------------------------- */}
      {mode === 'file' && (
        <div>
          <Label>Lumber list file</Label>
          <div
            {...getRootProps()}
            className={cn(
              'group relative flex min-h-[200px] cursor-pointer flex-col items-center justify-center gap-3 rounded-md border border-dashed px-6 py-8 text-center transition-colors duration-standard',
              isDragActive
                ? 'border-accent-primary bg-[rgba(29,184,122,0.06)]'
                : 'border-border-base bg-bg-subtle hover:border-border-strong hover:bg-bg-elevated',
              isDragReject && 'border-semantic-error bg-[rgba(232,84,72,0.08)]',
              loading && 'pointer-events-none opacity-60',
            )}
          >
            <input {...getInputProps()} />
            {file ? (
              <FilePreview file={file} onClear={() => setFile(null)} disabled={loading} />
            ) : (
              <>
                <UploadCloud
                  className={cn(
                    'h-10 w-10 text-text-tertiary transition-colors duration-micro',
                    isDragActive && 'text-accent-primary',
                  )}
                  aria-hidden="true"
                />
                <div className="text-body text-text-secondary">
                  <span className="text-text-primary">Drop your lumber list</span>{' '}
                  or click to browse
                </div>
                <div className="text-caption text-text-tertiary">
                  PDF · XLSX · CSV · DOCX · PNG · JPG · TIFF · TXT · EML · MSG · up to 25 MB
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Paste textarea ---------------------------------------------------- */}
      {mode === 'paste' && (
        <div>
          <Label htmlFor="paste">Pasted email / text</Label>
          <textarea
            id="paste"
            placeholder={'Paste the forwarded RFQ text here.\nHeader lines like "House 1" or "Phase 2" will be preserved as building groups.'}
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            disabled={loading}
            rows={10}
            className={cn(
              'block w-full rounded-sm border border-border-base bg-bg-subtle px-3 py-2',
              'text-body text-text-primary placeholder:text-text-tertiary',
              'font-mono', // treat free-form lumber text as monospace for alignment
              'focus:border-accent-primary focus:bg-bg-elevated focus:shadow-accent focus:outline-none',
              'disabled:opacity-40',
            )}
          />
        </div>
      )}

      {/* Live status reel ------------------------------------------------- */}
      {loading && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 rounded-sm border border-border-base bg-gradient-accent px-4 py-3"
        >
          <span className="loading-dots">
            <span />
            <span />
            <span />
          </span>
          <span className="text-body text-text-primary">
            {statusReel[statusIndex] ?? statusReel[0]}
          </span>
        </div>
      )}

      {/* Dev-only cost badge ---------------------------------------------- */}
      {COST_BADGE_ENABLED && lastCostBadge && !loading && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-sm border border-border-base bg-bg-subtle px-3 py-2 text-caption text-text-tertiary"
          aria-label="Extraction cost (dev only)"
        >
          <span className="font-semibold uppercase tracking-wide text-text-secondary">
            dev · cost
          </span>
          <span>{formatCostCents(lastCostBadge.total_cost_cents)}</span>
          <span aria-hidden="true">·</span>
          <span>{lastCostBadge.method_used}</span>
          <span aria-hidden="true">·</span>
          <span>{lastCostBadge.total_line_items} lines</span>
          <span aria-hidden="true">·</span>
          <span>
            {Math.round(lastCostBadge.overall_confidence * 100)}% confidence
          </span>
        </div>
      )}

      {/* Error surface ----------------------------------------------------- */}
      {error && (
        <div
          role="alert"
          className="rounded-sm border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.10)] px-3 py-2 text-body-sm text-semantic-error"
        >
          {error}
        </div>
      )}

      {/* Submit ------------------------------------------------------------ */}
      <div className="flex items-center justify-end">
        <Button
          type="button"
          size="lg"
          onClick={handleSubmit}
          loading={loading}
          disabled={loading || (mode === 'file' ? !file : pastedText.trim().length === 0)}
        >
          Ingest lumber list
        </Button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Subcomponents
// -----------------------------------------------------------------------------

function ModeButton({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-pill px-3 text-caption uppercase tracking-wide transition-colors duration-micro',
        active
          ? 'bg-accent-primary text-text-inverse shadow-accent'
          : 'text-text-tertiary hover:text-text-primary',
        disabled && 'opacity-40',
      )}
    >
      {children}
    </button>
  );
}

function FilePreview({
  file,
  onClear,
  disabled,
}: {
  file: File;
  onClear: () => void;
  disabled?: boolean;
}) {
  const Icon = iconForFile(file);
  const sizeKb = Math.max(1, Math.round(file.size / 1024));
  return (
    <div className="flex w-full max-w-md items-center justify-between gap-3 rounded-sm border border-border-base bg-bg-surface px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <Icon className="h-5 w-5 text-accent-primary" aria-hidden="true" />
        <div className="min-w-0 text-left">
          <div className="truncate text-body text-text-primary">{file.name}</div>
          <div className="text-caption text-text-tertiary">
            {sizeKb.toLocaleString()} KB · {file.type || 'unknown'}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClear();
        }}
        disabled={disabled}
        aria-label="Remove file"
        className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-text-tertiary transition-colors duration-micro hover:bg-bg-elevated hover:text-text-primary disabled:opacity-40"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function iconForFile(file: File) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return FileText;
  if (
    name.endsWith('.xlsx') ||
    name.endsWith('.xls') ||
    name.endsWith('.csv')
  ) {
    return FileSpreadsheet;
  }
  if (/\.(png|jpe?g|gif|webp|tiff?|bmp)$/.test(name)) return ImageIcon;
  if (name.endsWith('.eml') || name.endsWith('.msg')) return Mail;
  return FileText;
}
