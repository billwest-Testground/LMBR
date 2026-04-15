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

export interface IngestResponse {
  bid_id: string;
  extraction: ExtractionOutput;
  qa_report: QaReport;
  raw_file_url: string | null;
}

export interface BidUploaderProps {
  onIngested?: (result: IngestResponse) => void;
}

type UploadMode = 'file' | 'paste';

const ACCEPTED_MIMES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-excel': ['.xls'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'text/plain': ['.txt'],
  'message/rfc822': ['.eml'],
  'application/vnd.ms-outlook': ['.msg'],
};

const STATUS_REEL = [
  'Reading your list…',
  'Identifying species and grades…',
  'Parsing dimensions and lengths…',
  'Calculating board feet…',
  'Grouping by building / phase…',
  'Running quality check…',
] as const;

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

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

  // Rotate status messages while upload is in flight — README §9.
  React.useEffect(() => {
    if (!loading) {
      setStatusIndex(0);
      return;
    }
    const interval = window.setInterval(() => {
      setStatusIndex((prev) => (prev + 1) % STATUS_REEL.length);
    }, 1800);
    return () => window.clearInterval(interval);
  }, [loading]);

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

      onIngested?.(body as IngestResponse);
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
                  PDF · XLSX · PNG · JPG · TXT · EML · MSG · up to 25 MB
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
          <span className="text-body text-text-primary">{STATUS_REEL[statusIndex]}</span>
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
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return FileSpreadsheet;
  if (/\.(png|jpe?g|gif|webp)$/.test(name)) return ImageIcon;
  if (name.endsWith('.eml') || name.endsWith('.msg')) return Mail;
  return FileText;
}
