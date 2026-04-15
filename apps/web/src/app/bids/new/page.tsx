/**
 * /bids/new — Ingest a new customer RFQ.
 *
 * Purpose:  Wires <BidUploader /> to <LineItemTable /> for the full
 *           ingest → review flow. The page keeps the ingest response
 *           in local state; when the uploader fires `onIngested`, the
 *           table takes over with the extracted rows and lets the
 *           trader correct any flagged lines before pushing the bid
 *           into routing. Save hits PATCH /api/bids/[bidId]/line-items
 *           with the dirty rows; Proceed navigates to /bids/[bidId]/route
 *           (routing engine lives in PROMPT 03).
 *
 * Inputs:   authenticated session (middleware-guarded).
 * Outputs:  JSX.
 * Agent/API: POST /api/ingest (uploader), PATCH /api/bids/[bidId]/line-items
 *           (save).
 * Imports:  BidUploader, LineItemTable, design-system primitives,
 *           next/navigation.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import {
  BidUploader,
  type IngestResponse,
} from '../../../components/bids/bid-uploader';
import {
  LineItemTable,
  type EditableLineItem,
} from '../../../components/bids/line-item-table';
import { Button } from '../../../components/ui/button';

export default function NewBidPage() {
  const router = useRouter();
  const [ingested, setIngested] = React.useState<IngestResponse | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  async function handleSave(rows: EditableLineItem[]) {
    if (!ingested) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = rows.map((row) => ({
        // localId is stable per row; the server dedupes against
        // (bid_id, building_tag, species, dimension, grade, length,
        // quantity, sort_order). See /api/bids/[bidId]/line-items.
        localId: row.localId,
        buildingTag: row.buildingTag,
        phaseNumber: row.phaseNumber,
        species: row.species,
        dimension: row.dimension,
        grade: row.grade,
        length: row.length,
        quantity: row.quantity,
        unit: row.unit,
        boardFeet: row.boardFeet,
        confidence: row.confidence,
        flags: row.flags,
        originalText: row.originalText,
      }));

      const res = await fetch(`/api/bids/${ingested.bid_id}/line-items`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lineItems: payload }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function handleProceed() {
    if (!ingested) return;
    router.push(`/bids/${ingested.bid_id}/route`);
  }

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-8 py-10">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="text-label uppercase text-text-tertiary">New bid</div>
          <h1 className="mt-1 text-h1 text-text-primary">Ingest a lumber list</h1>
          <p className="mt-2 max-w-xl text-body text-text-secondary">
            Drop a PDF, Excel, photographed list, or paste a forwarded email.
            LMBR extracts every line item, calculates board feet, and flags
            anything ambiguous for your review before routing to buyers.
          </p>
        </div>
        {ingested && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setIngested(null);
              setSaveError(null);
            }}
          >
            Upload another
          </Button>
        )}
      </header>

      {!ingested ? (
        <div className="rounded-lg border border-border-base bg-bg-surface p-6 shadow-md sm:p-8">
          <BidUploader onIngested={setIngested} />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {saveError && (
            <div
              role="alert"
              className="rounded-sm border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.10)] px-3 py-2 text-body-sm text-semantic-error"
            >
              {saveError}
            </div>
          )}
          <LineItemTable
            extraction={ingested.extraction}
            qaReport={ingested.qa_report}
            onSave={handleSave}
            onProceed={handleProceed}
            saving={saving}
          />
        </div>
      )}
    </div>
  );
}
