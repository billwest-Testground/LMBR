/**
 * Bid detail page — canonical single-bid workspace.
 *
 * Purpose:  Read-only review of one bid's current state: customer +
 *           job metadata, overall status chip, line-item table grouped
 *           by building with per-row confidence dots and flag icons,
 *           and a link back into the routing flow if the bid is still
 *           in the routing stage. This is the surface traders open
 *           to audit an extraction against the source document.
 *
 *           Future prompts will extend this with the comparison matrix,
 *           margin stack, and quote preview tabs (PROMPTS 05–07). The
 *           line-items view rendered here is stable enough to remain
 *           the core of the page.
 *
 * Inputs:   params.bidId (uuid).
 * Outputs:  JSX.
 * Agent/API: Supabase (bids, line_items) via the RLS-backed SSR client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Route as RouteIcon, FileDown } from 'lucide-react';

import { getSupabaseRSCClient } from '../../../lib/supabase/server';
import { Button } from '../../../components/ui/button';
import { StatusBadge } from '../../../components/bids/status-badge';
import {
  BidLinesView,
  type BidLinesRow,
} from '../../../components/bids/bid-lines-view';
import {
  ArchiveActionButton,
  ArchivedBanner,
} from '../../../components/bids/archive-actions';

const ARCHIVE_PRIVILEGED_ROLES = new Set([
  'trader_buyer',
  'manager',
  'owner',
]);

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { bidId: string };
}

export default async function BidDetailPage({ params }: PageProps) {
  const supabase = getSupabaseRSCClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  const { data: bid } = await supabase
    .from('bids')
    .select(
      'id, customer_name, customer_email, job_name, job_address, job_state, job_region, status, due_date, raw_file_url, created_at, updated_at, archived_at, archived_by, assigned_trader_id, created_by',
    )
    .eq('id', params.bidId)
    .maybeSingle();
  if (!bid) notFound();

  // Role gate for the archive / reactivate actions. Mirrors the
  // in-code gate on /api/bids/[bidId]/archive + /reactivate so the
  // UI hides actions the server would reject.
  const { data: roleRows } = await supabase
    .from('roles')
    .select('role_type')
    .eq('user_id', session.user.id);
  const callerRoles = (roleRows ?? []).map((r) => r.role_type as string);
  const isPrivileged = callerRoles.some((r) =>
    ARCHIVE_PRIVILEGED_ROLES.has(r),
  );
  const isTraderOnBid =
    callerRoles.includes('trader') &&
    (bid.assigned_trader_id === session.user.id ||
      bid.created_by === session.user.id);
  const canArchive = isPrivileged || isTraderOnBid;

  const { data: lineItems } = await supabase
    .from('line_items')
    .select(
      'id, building_tag, phase_number, species, dimension, grade, length, quantity, unit, board_feet, notes, sort_order',
    )
    .eq('bid_id', bid.id)
    .order('sort_order', { ascending: true });

  const rows: BidLinesRow[] = (lineItems ?? []).map((li) => ({
    id: li.id,
    building_tag: li.building_tag,
    phase_number: li.phase_number,
    species: li.species,
    dimension: li.dimension,
    grade: li.grade,
    length: li.length,
    quantity: Number(li.quantity),
    unit: li.unit,
    board_feet: li.board_feet != null ? Number(li.board_feet) : null,
    notes: li.notes,
    sort_order: li.sort_order,
  }));

  const totalBF = rows.reduce((s, r) => s + (r.board_feet ?? 0), 0);
  const buildingCount = new Set(
    rows.map((r) => `${r.building_tag ?? ''}::${r.phase_number ?? ''}`),
  ).size;

  const bidLabel = (bid.job_name as string | null) ?? bid.customer_name;

  return (
    <div className="flex flex-col gap-6">
      {bid.archived_at ? (
        <ArchivedBanner
          bidId={bid.id}
          bidLabel={bidLabel}
          archivedAt={bid.archived_at as string}
          canReactivate={canArchive}
        />
      ) : null}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1 text-caption text-text-tertiary transition-colors duration-micro hover:text-text-secondary"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden="true" />
            Back to dashboard
          </Link>
          <div className="mt-2 flex items-center gap-3">
            <h1 className="text-h1 text-text-primary">
              {bid.job_name || bid.customer_name}
            </h1>
            <StatusBadge status={bid.status} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-text-secondary">
            <span>{bid.customer_name}</span>
            {bid.customer_email && <span>· {bid.customer_email}</span>}
            {bid.job_address && <span>· {bid.job_address}</span>}
            {bid.due_date && (
              <span>
                · Due {new Date(bid.due_date).toLocaleDateString('en-US')}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {bid.raw_file_url && (
            <Button asChild variant="secondary">
              <a href={bid.raw_file_url} target="_blank" rel="noreferrer">
                <FileDown className="h-4 w-4" aria-hidden="true" />
                Source file
              </a>
            </Button>
          )}
          {bid.status === 'routing' && (
            <Button asChild>
              <Link href={`/bids/${bid.id}/route`}>
                <RouteIcon className="h-4 w-4" aria-hidden="true" />
                Open routing
              </Link>
            </Button>
          )}
          {!bid.archived_at && canArchive ? (
            <ArchiveActionButton bidId={bid.id} />
          ) : null}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Line items" value={rows.length.toLocaleString()} />
        <Stat
          label="Total BF"
          value={totalBF.toLocaleString(undefined, {
            maximumFractionDigits: 0,
          })}
        />
        <Stat label="Building groups" value={buildingCount.toLocaleString()} />
        <Stat label="Job region" value={bid.job_region ?? '—'} />
      </div>

      <BidLinesView rows={rows} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-base bg-bg-surface px-4 py-3 shadow-sm">
      <div className="text-label uppercase text-text-tertiary">{label}</div>
      <div className="mt-1 text-h3 font-mono tabular-nums text-text-primary">
        {value}
      </div>
    </div>
  );
}
