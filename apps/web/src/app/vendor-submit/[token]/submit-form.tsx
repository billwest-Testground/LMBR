/**
 * SubmitForm — interactive client component for the public vendor submission page.
 *
 * Purpose:  Render the pricing form the vendor fills in. Header banner shows
 *           the requesting company + vendor + job context for trust. The
 *           body is an accessible table of line items with two input fields
 *           per row (unit price, notes). Submit and "Decline to bid" buttons
 *           below.
 *
 *           State is managed by react-hook-form (already a dependency). Zod
 *           is used to shape-check the POST body before sending, giving a
 *           typed outbound request that matches the server schema exactly.
 *           The only authentication the server sees is the `token` prop
 *           passed into the POST — actual validation always happens on the
 *           server.
 *
 *           After a successful submit the component switches to an in-place
 *           banner + freshly-read existing-prices view instead of navigating
 *           away; the vendor can still correct a price if needed.
 *
 * Inputs:   token, companyName, vendorName, bidSummary, dueBy, lineItems,
 *           existingPrices.
 * Outputs:  JSX form.
 * Agent/API: POSTs to /api/vendor-submit.
 * Imports:  react, react-hook-form, zod, ../../../components/ui/*.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { formatDueByLabel } from '../../../lib/format-datetime';

export interface SubmitFormLineItem {
  id: string;
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number;
  unit: string;
  boardFeet: number | null;
  buildingTag: string | null;
  phaseNumber: number | null;
}

export interface SubmitFormExistingPrice {
  unitPrice: number | null;
  notes: string;
}

interface BidSummary {
  jobName: string | null;
  customerName: string;
  jobAddress: string | null;
  dueDate: string | null;
  lineCount: number;
}

interface SubmitFormProps {
  token: string;
  companyName: string;
  vendorName: string;
  bidSummary: BidSummary;
  dueBy: string | null;
  lineItems: SubmitFormLineItem[];
  existingPrices: Record<string, SubmitFormExistingPrice>;
}

// Wire-format shape the API expects. Kept in lockstep with
// /api/vendor-submit/route.ts BodySchema — any divergence is a bug.
const PriceEntrySchema = z.object({
  lineItemId: z.string().uuid(),
  unitPrice: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});

const SubmitBodySchema = z.object({
  token: z.string().min(1),
  action: z.enum(['submit', 'decline']),
  prices: z.array(PriceEntrySchema),
});

type FormRow = {
  unitPrice: string; // raw text from <input>; parsed at submit
  notes: string;
};

interface FormValues {
  rows: Record<string, FormRow>;
}

interface SubmitResponse {
  success?: boolean;
  status?: 'submitted' | 'partial' | 'declined';
  pricedCount?: number;
  expectedCount?: number;
  error?: string;
}

export function SubmitForm({
  token,
  companyName,
  vendorName,
  bidSummary,
  dueBy,
  lineItems,
  existingPrices,
}: SubmitFormProps): React.ReactElement {
  const initialRows = React.useMemo<Record<string, FormRow>>(() => {
    const out: Record<string, FormRow> = {};
    for (const li of lineItems) {
      const existing = existingPrices[li.id];
      out[li.id] = {
        unitPrice:
          existing && existing.unitPrice != null ? String(existing.unitPrice) : '',
        notes: existing?.notes ?? '',
      };
    }
    return out;
  }, [lineItems, existingPrices]);

  const { register, handleSubmit, getValues } = useForm<FormValues>({
    defaultValues: { rows: initialRows },
  });

  const [submitting, setSubmitting] = React.useState<false | 'submit' | 'decline'>(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<{
    status: 'submitted' | 'partial' | 'declined';
    pricedCount: number;
    expectedCount: number;
  } | null>(null);

  const title = bidSummary.jobName || bidSummary.customerName;

  async function postToServer(action: 'submit' | 'decline'): Promise<void> {
    setError(null);
    setSubmitting(action);

    const values = getValues();

    const prices = lineItems
      .map((li) => {
        const row = values.rows?.[li.id] ?? { unitPrice: '', notes: '' };
        const trimmedPrice = row.unitPrice.trim();
        const trimmedNotes = row.notes.trim();

        let unitPrice: number | undefined;
        if (trimmedPrice !== '') {
          const parsed = Number(trimmedPrice);
          if (!Number.isFinite(parsed) || parsed < 0) {
            return { invalid: true as const, lineItemId: li.id };
          }
          unitPrice = parsed;
        }
        const entry: { lineItemId: string; unitPrice?: number; notes?: string } = {
          lineItemId: li.id,
        };
        if (unitPrice !== undefined) entry.unitPrice = unitPrice;
        if (trimmedNotes !== '') entry.notes = trimmedNotes;
        return entry;
      })
      .filter((e): e is { lineItemId: string; unitPrice?: number; notes?: string } => {
        if ('invalid' in e && e.invalid) return false;
        return true;
      });

    // Detect any invalid raw prices before firing the request.
    const hasInvalid = lineItems.some((li) => {
      const raw = values.rows?.[li.id]?.unitPrice?.trim() ?? '';
      if (raw === '') return false;
      const parsed = Number(raw);
      return !Number.isFinite(parsed) || parsed < 0;
    });
    if (action === 'submit' && hasInvalid) {
      setSubmitting(false);
      setError('One or more prices are not valid non-negative numbers.');
      return;
    }

    const parsed = SubmitBodySchema.safeParse({
      token,
      action,
      prices: action === 'decline' ? [] : prices,
    });
    if (!parsed.success) {
      setSubmitting(false);
      setError('Could not prepare the submission. Refresh the page and try again.');
      return;
    }

    try {
      const res = await fetch('/api/vendor-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.data),
      });
      const body = (await res.json()) as SubmitResponse;
      if (!res.ok || !body.success || !body.status) {
        setError(body.error ?? 'Submission failed. Please try again.');
        setSubmitting(false);
        return;
      }
      setSuccess({
        status: body.status,
        pricedCount: body.pricedCount ?? 0,
        expectedCount: body.expectedCount ?? lineItems.length,
      });
      setSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed.');
      setSubmitting(false);
    }
  }

  // ----- Render -----------------------------------------------------------
  return (
    <div>
      <header className="mb-6">
        <div className="text-label uppercase text-text-tertiary">
          Pricing request from {companyName}
        </div>
        <h1 className="mt-1 text-h2 text-text-primary">{title}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm text-text-secondary">
          <span>
            Vendor: <span className="text-text-primary">{vendorName}</span>
          </span>
          <span>
            · Customer:{' '}
            <span className="text-text-primary">{bidSummary.customerName}</span>
          </span>
          {bidSummary.jobAddress && <span>· {bidSummary.jobAddress}</span>}
          {dueBy && (
            <span>
              · Reply by{' '}
              <span className="text-text-primary">
                {formatDueByLabel(dueBy)}
              </span>
            </span>
          )}
          <span>
            · {bidSummary.lineCount.toLocaleString()} line
            {bidSummary.lineCount === 1 ? '' : 's'}
          </span>
        </div>
      </header>

      {success && (
        <div
          role="status"
          className="mb-6 rounded-md border border-[rgba(29,184,122,0.4)] bg-[rgba(29,184,122,0.08)] px-4 py-3 text-body-sm text-semantic-success"
        >
          {success.status === 'declined'
            ? 'Thank you — your decline has been recorded.'
            : success.status === 'submitted'
              ? `Thank you — all ${success.expectedCount} lines received. The buyer has been notified.`
              : `Saved ${success.pricedCount} of ${success.expectedCount} lines. You can return to this link anytime to finish.`}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-[rgba(192,57,43,0.4)] bg-[rgba(192,57,43,0.10)] px-4 py-3 text-body-sm text-semantic-error"
        >
          {error}
        </div>
      )}

      <form
        onSubmit={handleSubmit(() => {
          void postToServer('submit');
        })}
        noValidate
      >
        <div className="overflow-hidden rounded-lg border border-border-base bg-bg-surface shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border-base">
              <thead className="bg-bg-subtle">
                <tr>
                  <ColHeader>#</ColHeader>
                  <ColHeader>Species</ColHeader>
                  <ColHeader>Dimension</ColHeader>
                  <ColHeader>Grade</ColHeader>
                  <ColHeader>Length</ColHeader>
                  <ColHeader align="right">Qty</ColHeader>
                  <ColHeader align="right">Unit Price (USD)</ColHeader>
                  <ColHeader>Notes</ColHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-base">
                {lineItems.map((li, idx) => {
                  const ariaLabel = buildAriaLabel(li);
                  const priceId = `price-${li.id}`;
                  const notesId = `notes-${li.id}`;
                  return (
                    <tr key={li.id} aria-label={ariaLabel}>
                      <Cell>{idx + 1}</Cell>
                      <Cell>{li.species}</Cell>
                      <Cell>{li.dimension}</Cell>
                      <Cell>{li.grade ?? '—'}</Cell>
                      <Cell>{li.length ?? '—'}</Cell>
                      <Cell align="right">
                        {li.quantity.toLocaleString()} {li.unit}
                      </Cell>
                      <td className="px-3 py-2">
                        <label htmlFor={priceId} className="sr-only">
                          Unit price for {ariaLabel}
                        </label>
                        <Input
                          id={priceId}
                          type="text"
                          inputMode="decimal"
                          variant="price"
                          placeholder="—"
                          autoComplete="off"
                          aria-label={`Unit price for ${ariaLabel}`}
                          disabled={!!submitting || !!success}
                          {...register(`rows.${li.id}.unitPrice` as const)}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <label htmlFor={notesId} className="sr-only">
                          Notes for {ariaLabel}
                        </label>
                        <Input
                          id={notesId}
                          type="text"
                          placeholder="Optional note"
                          autoComplete="off"
                          aria-label={`Notes for ${ariaLabel}`}
                          disabled={!!submitting || !!success}
                          {...register(`rows.${li.id}.notes` as const)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <p className="text-body-sm text-text-tertiary">
            Leave a price blank if you cannot supply that item. You can save,
            close the tab, and return to this link later — any prices you
            entered will be preserved.
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (confirmDecline()) void postToServer('decline');
              }}
              disabled={!!submitting || !!success}
              loading={submitting === 'decline'}
            >
              Decline to bid
            </Button>
            <Button
              type="submit"
              size="lg"
              disabled={!!success}
              loading={submitting === 'submit'}
            >
              Submit pricing
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

function confirmDecline(): boolean {
  if (typeof window === 'undefined') return true;
  return window.confirm(
    'Decline to bid on this request? The buyer will see that you declined.',
  );
}

function buildAriaLabel(li: SubmitFormLineItem): string {
  const parts = [li.species, li.dimension];
  if (li.grade) parts.push(li.grade);
  if (li.length) parts.push(`${li.length}`);
  parts.push(`${li.quantity.toLocaleString()} ${li.unit}`);
  return parts.join(' · ');
}

function ColHeader({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 text-label uppercase text-text-tertiary ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

function Cell({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <td
      className={`px-3 py-2 text-body-sm text-text-secondary ${
        align === 'right' ? 'text-right font-mono tabular-nums' : ''
      }`}
    >
      {children}
    </td>
  );
}
