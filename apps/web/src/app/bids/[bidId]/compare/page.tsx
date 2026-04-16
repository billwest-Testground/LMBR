/**
 * Bid comparison page — vendor matrix + best-price selection.
 *
 * Purpose:  Server-rendered shell for the comparison matrix. Validates the
 *           session, enforces the buyer-aligned role gate (pure traders
 *           are blocked — they see quote_line_items downstream), calls the
 *           shared loadComparison() helper (same one the /api/compare
 *           route handler uses so the two surfaces never drift), and hands
 *           the result to the client matrix wrapper.
 *
 *           Pure-trader role gate renders a friendly "buyer role required"
 *           panel without hitting the comparison engine at all, per the
 *           task spec.
 *
 * Inputs:   params.bidId (uuid).
 * Outputs:  Comparison matrix JSX.
 * Agent/API: @lmbr/agents comparison-agent (via loadComparison helper).
 * Imports:  next/navigation, ../../../../lib/supabase/server,
 *           ../../../../lib/compare/load-comparison,
 *           ../../../../components/bids/comparison-matrix-client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, ShieldOff } from 'lucide-react';

import { loadComparison } from '../../../../lib/compare/load-comparison';
import { getSupabaseRSCClient } from '../../../../lib/supabase/server';
import { ComparisonMatrixClient } from '../../../../components/bids/comparison-matrix-client';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { bidId: string };
}

/**
 * Roles permitted to see vendor pricing. Pure traders are explicitly
 * excluded — they see the final quote_line_items after a buyer has made
 * vendor selections, never the raw comparison matrix. Kept in sync with
 * the route-handler set in /api/compare/[bidId]/route.ts.
 */
const COMPARE_ROLES = new Set(['buyer', 'trader_buyer', 'manager', 'owner']);

export default async function ComparePage({ params }: PageProps) {
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
  const hasAllowedRole = roles.some((r) => COMPARE_ROLES.has(r));

  if (!hasAllowedRole) {
    return <RoleGateMessage bidId={params.bidId} />;
  }

  const loaded = await loadComparison({
    supabase,
    bidId: params.bidId,
    companyId: profile.company_id as string,
  });

  if (loaded.status === 'invalid_bid_id' || loaded.status === 'not_found') {
    notFound();
  }
  if (loaded.status === 'wrong_company') {
    notFound();
  }
  if (loaded.status === 'db_error') {
    return <ErrorPanel message={loaded.message} bidId={params.bidId} />;
  }

  const { result, bid } = loaded;
  const dueDate = bid.dueDate
    ? new Date(bid.dueDate).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="min-w-0">
        <Link
          href={`/bids/${bid.id}`}
          className="inline-flex items-center gap-1 text-caption text-text-tertiary transition-colors duration-micro hover:text-text-secondary"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden="true" />
          Back to bid
        </Link>
        <h1 className="mt-2 text-h1 text-text-primary">
          Comparison — {bid.customerName}
        </h1>
        {(bid.jobName || dueDate) && (
          <p className="mt-1 text-body text-text-secondary">
            {bid.jobName && <span>{bid.jobName}</span>}
            {bid.jobName && dueDate && <span> · </span>}
            {dueDate && <span>Due {dueDate}</span>}
          </p>
        )}
      </header>

      <ComparisonMatrixClient result={result} />
    </div>
  );
}

function RoleGateMessage({ bidId }: { bidId: string }) {
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
        <h1 className="mt-2 text-h1 text-text-primary">Comparison</h1>
      </header>
      <div className="mx-auto mt-8 flex max-w-md flex-col items-center gap-3 rounded-md border border-border-base bg-bg-surface px-6 py-12 text-center shadow-sm">
        <ShieldOff className="h-12 w-12 text-text-tertiary" aria-hidden="true" />
        <h2 className="text-h3 text-text-secondary">
          Vendor pricing requires buyer role
        </h2>
        <p className="text-body-sm text-text-tertiary">
          The raw vendor comparison matrix is restricted to buyer, trader-buyer,
          manager, and owner roles. Once your buyer confirms a selection, the
          quote will appear on your trader dashboard.
        </p>
      </div>
    </div>
  );
}

function ErrorPanel({ message, bidId }: { message: string; bidId: string }) {
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
        <h1 className="mt-2 text-h1 text-text-primary">Comparison</h1>
      </header>
      <div className="rounded-md border border-[rgba(232,84,72,0.4)] bg-[rgba(232,84,72,0.08)] px-6 py-5 text-body-sm text-semantic-error">
        Comparison failed to load: {message}
      </div>
    </div>
  );
}
