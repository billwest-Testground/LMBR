/**
 * Bid consolidation workspace.
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { ConsolidationMode } from '@lmbr/types';
import type { ConsolidationLineItem } from '@lmbr/agents';
import { ConsolidationControls } from '../../../../components/bids/consolidation-controls';
import { getSupabaseBrowserClient } from '../../../../lib/supabase/browser';

interface BidRow {
  id: string;
  customer_name: string;
  job_name: string | null;
  consolidation_mode: string;
}

interface LineItemRow {
  id: string;
  bid_id: string;
  company_id: string;
  building_tag: string | null;
  phase_number: number | null;
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number;
  unit: string;
  board_feet: number | null;
  notes: string | null;
  sort_order: number;
  extraction_method: string | null;
  extraction_confidence: number | null;
  cost_cents: number | null;
}

export default function ConsolidatePage({
  params,
}: {
  params: { bidId: string };
}) {
  const router = useRouter();
  const supabase = getSupabaseBrowserClient();
  const [bid, setBid] = useState<{
    id: string;
    customerName: string;
    jobName: string | null;
    consolidationMode: ConsolidationMode;
  } | null>(null);
  const [lineItems, setLineItems] = useState<ConsolidationLineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      const { data: rawBid, error: bidErr } = await supabase
        .from('bids')
        .select('id, customer_name, job_name, consolidation_mode')
        .eq('id', params.bidId)
        .maybeSingle();
      if (bidErr || !rawBid) {
        setError(bidErr?.message ?? 'Bid not found');
        setLoading(false);
        return;
      }
      const bidData = rawBid as unknown as BidRow;
      setBid({
        id: bidData.id,
        customerName: bidData.customer_name,
        jobName: bidData.job_name,
        consolidationMode: bidData.consolidation_mode as ConsolidationMode,
      });

      const { data: items, error: liErr } = await supabase
        .from('line_items')
        .select(
          'id, bid_id, company_id, building_tag, phase_number, species, dimension, ' +
          'grade, length, quantity, unit, board_feet, notes, sort_order, ' +
          'extraction_method, extraction_confidence, cost_cents',
        )
        .eq('bid_id', params.bidId)
        .eq('is_consolidated', false)
        .order('sort_order', { ascending: true });
      if (liErr) {
        setError(liErr.message);
        setLoading(false);
        return;
      }

      const rows = (items ?? []) as unknown as LineItemRow[];
      const mapped: ConsolidationLineItem[] = rows.map((row) => {
        let flags: string[] = [];
        if (row.notes) {
          try {
            const parsed = JSON.parse(row.notes);
            if (Array.isArray(parsed.flags)) flags = parsed.flags;
          } catch { /* ignore */ }
        }
        return {
          id: row.id,
          bidId: row.bid_id,
          companyId: row.company_id,
          buildingTag: row.building_tag,
          phaseNumber: row.phase_number,
          species: row.species,
          dimension: row.dimension,
          grade: row.grade,
          length: row.length,
          quantity: Number(row.quantity),
          unit: row.unit,
          boardFeet: row.board_feet != null ? Number(row.board_feet) : null,
          confidence: row.extraction_confidence,
          flags,
          sortOrder: row.sort_order,
          extractionMethod: row.extraction_method,
          extractionConfidence: row.extraction_confidence,
          costCents: row.cost_cents,
        };
      });

      setLineItems(mapped);
      setLoading(false);
    }
    load();
  }, [params.bidId, supabase]);

  const buildingTags = new Set(
    lineItems.map((li) => li.buildingTag).filter(Boolean),
  );
  const phaseNumbers = [
    ...new Set(
      lineItems
        .map((li) => li.phaseNumber)
        .filter((p): p is number => p != null),
    ),
  ].sort((a, b) => a - b);
  const totalBoardFeet = lineItems.reduce(
    (s, li) => s + (li.boardFeet ?? 0),
    0,
  );

  const handleConfirm = useCallback(
    (_mode: ConsolidationMode) => {
      router.push(`/bids/${params.bidId}/route`);
    },
    [router, params.bidId],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <p className="text-sm text-text-tertiary">Loading bid data...</p>
      </div>
    );
  }

  if (error || !bid) {
    return (
      <div className="flex items-center justify-center p-16">
        <p className="text-sm text-semantic-error">
          {error ?? 'Bid not found'}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-8 p-8">
      <div>
        <h1 className="text-2xl font-semibold text-text-primary">
          Consolidation
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          {bid.customerName}
          {bid.jobName ? ` — ${bid.jobName}` : ''}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Buildings', value: buildingTags.size || '—' },
          { label: 'Phases', value: phaseNumbers.length || '—' },
          { label: 'Line Items', value: lineItems.length.toLocaleString() },
          {
            label: 'Board Feet',
            value:
              totalBoardFeet >= 1000
                ? `${(totalBoardFeet / 1000).toFixed(1)}M`
                : Math.round(totalBoardFeet).toLocaleString(),
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded border border-border-base bg-bg-surface p-4"
          >
            <p className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
              {stat.label}
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-text-primary">
              {stat.value}
            </p>
          </div>
        ))}
      </div>

      <ConsolidationControls
        bidId={bid.id}
        lineItems={lineItems}
        buildingCount={buildingTags.size}
        phaseNumbers={phaseNumbers}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
