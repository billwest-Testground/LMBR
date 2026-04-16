/**
 * Bid margin page — server shell for the margin-stacking workspace.
 *
 * Purpose:  Auth + role gate + data loader for /bids/[bidId]/margin.
 *           Pure traders are blocked (they can't see vendor costs);
 *           buyer, trader_buyer, manager, and owner roles proceed. We
 *           load the bid, all line items, company settings, a vendor
 *           name map, and any previously-persisted quote + quote line
 *           items so a manager can re-edit margin without redoing the
 *           comparison pass. The interactive client bridge is
 *           <MarginStackClient> which reads the sessionStorage stash
 *           written by /bids/[bidId]/compare on export.
 *
 * Inputs:   params.bidId (uuid).
 * Outputs:  Margin-stack JSX.
 * Agent/API: Supabase RLS reads; the margin agent itself fires via the
 *           client bridge POSTing /api/margin.
 * Imports:  next/navigation, next/link, lucide-react,
 *           ../../../../lib/supabase/server,
 *           ../../../../components/bids/margin-stack-client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, ShieldOff } from 'lucide-react';

import type { PricingSelection } from '@lmbr/agents';

import { getSupabaseRSCClient } from '../../../../lib/supabase/server';
import {
  MarginStackClient,
  type MarginStackClientProps,
} from '../../../../components/bids/margin-stack-client';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { bidId: string };
}

/** Roles that can drive the margin stack. Pure traders are excluded
 *  because costs + vendor names cannot cross that role boundary. */
const MARGIN_ROLES = new Set(['buyer', 'trader_buyer', 'manager', 'owner']);
const MANAGER_ROLES = new Set(['manager', 'owner']);

export default async function MarginPage({ params }: PageProps) {
  const supabase = getSupabaseRSCClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  const [profileResult, rolesResult] = await Promise.all([
    supabase
      .from('users')
      .select('id, company_id')
      .eq('id', session.user.id)
      .maybeSingle(),
    supabase.from('roles').select('role_type').eq('user_id', session.user.id),
  ]);

  const profile = profileResult.data;
  if (!profile?.company_id) notFound();

  const roles = (rolesResult.data ?? []).map((r) => r.role_type as string);
  const hasAllowedRole = roles.some((r) => MARGIN_ROLES.has(r));
  if (!hasAllowedRole) {
    return <RoleGate bidId={params.bidId} />;
  }
  const isManager = roles.some((r) => MANAGER_ROLES.has(r));

  const [bidResult, linesResult, settingsResult, vendorsResult, quoteResult] =
    await Promise.all([
      supabase
        .from('bids')
        .select(
          'id, company_id, customer_name, job_name, job_state, consolidation_mode, status',
        )
        .eq('id', params.bidId)
        .maybeSingle(),
      supabase
        .from('line_items')
        .select(
          'id, building_tag, phase_number, species, dimension, grade, length, quantity, unit, sort_order',
        )
        .eq('bid_id', params.bidId)
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true }),
      supabase
        .from('companies')
        .select('approval_threshold_dollars, min_margin_percent, margin_presets')
        .eq('id', profile.company_id)
        .maybeSingle(),
      supabase
        .from('vendors')
        .select('id, name')
        .eq('company_id', profile.company_id),
      supabase
        .from('quotes')
        .select('id, status')
        .eq('bid_id', params.bidId)
        .eq('company_id', profile.company_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  const bid = bidResult.data;
  if (!bid) notFound();
  if (bid.company_id !== profile.company_id) notFound();

  const settings = settingsResult.data;
  if (!settings) {
    return (
      <ErrorPanel
        bidId={params.bidId}
        message="Company quote settings missing — ask your admin to open Settings and save defaults."
      />
    );
  }

  const lines: MarginStackClientProps['lines'] = (linesResult.data ?? []).map(
    (row) => ({
      lineItemId: row.id as string,
      species: row.species as string,
      dimension: row.dimension as string,
      grade: (row.grade as string | null) ?? null,
      length: (row.length as string | null) ?? null,
      quantity: Number(row.quantity),
      unit: row.unit as 'PCS' | 'MBF' | 'MSF',
      buildingTag: (row.building_tag as string | null) ?? null,
      phaseNumber: (row.phase_number as number | null) ?? null,
      sortOrder: Number(row.sort_order ?? 0),
    }),
  );

  // Vendor name lookup is internal-only (rendered with the "not on PDF" chip).
  const vendorNameByVendorId: Record<string, string> = {};
  for (const v of vendorsResult.data ?? []) {
    vendorNameByVendorId[v.id as string] = v.name as string;
  }

  // --- Rehydrate persisted selections when the bid already has a quote ---
  // Manager re-edit flow: the stash may be empty (trader visited via
  // bookmark, not the comparison export). Pull whatever the last quote
  // persisted so the manager sees costs + vendor attribution without a
  // compare round-trip.
  let persistedSelections: PricingSelection[] | undefined;
  const quote = quoteResult.data;
  if (quote?.id) {
    const [qliResult, vbliResult] = await Promise.all([
      supabase
        .from('quote_line_items')
        .select(
          'line_item_id, vendor_bid_line_item_id, cost_price, sort_order',
        )
        .eq('quote_id', quote.id)
        .eq('company_id', profile.company_id),
      // second query deferred — we need the vendor_bid_line_item rows to
      // recover vendor_id + total_price; issue it sequentially below
      Promise.resolve({
        data: null as null,
        error: null as null,
      }),
    ]);
    // We intentionally await qliResult first so vbli knows which ids to
    // fetch. The parallel-looking Promise.all above is structural; the
    // second slot is a no-op.
    void vbliResult;
    const qli = qliResult.data ?? [];
    const vbliIds = qli
      .map((r) => r.vendor_bid_line_item_id as string | null)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (vbliIds.length > 0) {
      const { data: vbliRows } = await supabase
        .from('vendor_bid_line_items')
        .select(
          'id, vendor_bid_id, unit_price, total_price',
        )
        .in('id', vbliIds);
      const vbById = new Map(
        (vbliRows ?? []).map((r) => [r.id as string, r] as const),
      );
      // We still need vendor_id — read it off vendor_bids in a second hop.
      const vbIds = [
        ...new Set(
          (vbliRows ?? [])
            .map((r) => r.vendor_bid_id as string | null)
            .filter((v): v is string => typeof v === 'string' && v.length > 0),
        ),
      ];
      const vendorIdByVbId = new Map<string, string>();
      if (vbIds.length > 0) {
        const { data: vbRows } = await supabase
          .from('vendor_bids')
          .select('id, vendor_id')
          .in('id', vbIds);
        for (const r of vbRows ?? []) {
          vendorIdByVbId.set(r.id as string, r.vendor_id as string);
        }
      }
      persistedSelections = qli
        .map((row): PricingSelection | null => {
          const vbliId = row.vendor_bid_line_item_id as string | null;
          if (!vbliId) return null;
          const vbli = vbById.get(vbliId);
          if (!vbli) return null;
          const vendorId = vendorIdByVbId.get(
            vbli.vendor_bid_id as string,
          );
          if (!vendorId) return null;
          return {
            lineItemId: row.line_item_id as string,
            vendorBidLineItemId: vbliId,
            vendorId,
            costUnitPrice: Number(vbli.unit_price),
            costTotalPrice: Number(vbli.total_price),
          };
        })
        .filter((r): r is PricingSelection => r !== null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="min-w-0">
        <Link
          href={`/bids/${bid.id}/compare`}
          className="inline-flex items-center gap-1 text-caption text-text-tertiary transition-colors duration-micro hover:text-text-secondary"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden="true" />
          Back to comparison
        </Link>
        <h1 className="mt-2 text-h1 text-text-primary">
          Margin — {(bid.customer_name as string) ?? 'Customer'}
        </h1>
        {bid.job_name && (
          <p className="mt-1 text-body text-text-secondary">
            {bid.job_name as string}
          </p>
        )}
      </header>

      <MarginStackClient
        bidId={params.bidId}
        lines={lines}
        settings={{
          approvalThresholdDollars: Number(settings.approval_threshold_dollars),
          minMarginPercent: Number(settings.min_margin_percent),
          marginPresets: parsePresets(settings.margin_presets),
        }}
        jobState={(bid.job_state as string | null) ?? null}
        consolidationMode={
          ((bid.consolidation_mode as
            | 'structured'
            | 'consolidated'
            | 'phased'
            | 'hybrid'
            | null) ?? 'structured')
        }
        isManager={isManager}
        vendorNameByVendorId={vendorNameByVendorId}
        persistedSelections={persistedSelections}
      />
    </div>
  );
}

function parsePresets(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [0.08, 0.1, 0.12, 0.15, 0.18];
  const nums = raw
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return nums.length > 0 ? nums : [0.08, 0.1, 0.12, 0.15, 0.18];
}

function RoleGate({ bidId }: { bidId: string }) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href={`/bids/${bidId}`}
          className="inline-flex items-center gap-1 text-caption text-text-tertiary transition-colors duration-micro hover:text-text-secondary"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden="true" />
          Back to bid
        </Link>
        <h1 className="mt-2 text-h1 text-text-primary">Margin</h1>
      </header>
      <div className="mx-auto mt-8 flex max-w-md flex-col items-center gap-3 rounded-md border border-border-base bg-bg-surface px-6 py-12 text-center shadow-sm">
        <ShieldOff className="h-12 w-12 text-text-tertiary" aria-hidden="true" />
        <h2 className="text-h3 text-text-secondary">
          Vendor pricing requires buyer role
        </h2>
        <p className="text-body-sm text-text-tertiary">
          Margin stacking shows internal costs and vendor attribution, so it
          is restricted to buyer, trader-buyer, manager, and owner roles.
        </p>
      </div>
    </div>
  );
}

function ErrorPanel({ bidId, message }: { bidId: string; message: string }) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href={`/bids/${bidId}`}
          className="inline-flex items-center gap-1 text-caption text-text-tertiary transition-colors duration-micro hover:text-text-secondary"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden="true" />
          Back to bid
        </Link>
        <h1 className="mt-2 text-h1 text-text-primary">Margin</h1>
      </header>
      <div className="rounded-md border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.08)] px-6 py-5 text-body-sm text-semantic-error">
        {message}
      </div>
    </div>
  );
}
