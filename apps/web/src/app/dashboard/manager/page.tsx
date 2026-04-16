/**
 * Manager/Owner dashboard — approval queue.
 *
 * Purpose:  Primary surface for the Manager/Owner role. Lists every
 *           quote in status=pending_approval for the company, shows
 *           customer / job / trader / total / blended margin / submitted
 *           timestamp, and links straight to the margin-stack page so
 *           the manager can review margin before approving. Market
 *           analytics + quote release controls live on sub-tabs (Prompt
 *           09 / 12).
 *
 *           Manager/Owner only — other roles see an access-required
 *           panel so route discovery doesn't leak company-wide data.
 *
 * Inputs:   session.
 * Outputs:  JSX.
 * Agent/API: Supabase reads (quotes + bids + users) under RLS.
 * Imports:  next/link, next/navigation, lucide-react,
 *           ../../../lib/supabase/server, ../../../lib/cn.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowRight, Inbox, ShieldOff } from 'lucide-react';

import { getSupabaseRSCClient } from '../../../lib/supabase/server';
import { cn } from '../../../lib/cn';

export const dynamic = 'force-dynamic';

const MANAGER_ROLES = new Set(['manager', 'owner']);

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const USD_COMPACT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

interface ApprovalRow {
  quoteId: string;
  bidId: string;
  customer: string;
  jobName: string | null;
  dueDate: string | null;
  trader: string;
  total: number;
  blendedMarginPercent: number;
  submittedAt: string;
}

export default async function ManagerDashboardPage() {
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
  if (!roles.some((r) => MANAGER_ROLES.has(r))) {
    return <RoleGate />;
  }

  // --- Load pending quotes + joined meta ------------------------------------
  const { data: quotes } = await supabase
    .from('quotes')
    .select(
      'id, bid_id, total, margin_percent, created_by, created_at, updated_at',
    )
    .eq('company_id', profile.company_id)
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: false });

  const quoteRows = quotes ?? [];

  let rows: ApprovalRow[] = [];
  if (quoteRows.length > 0) {
    const bidIds = [...new Set(quoteRows.map((q) => q.bid_id as string))];
    const traderIds = [
      ...new Set(quoteRows.map((q) => q.created_by as string)),
    ];

    const [bidsResult, tradersResult] = await Promise.all([
      supabase
        .from('bids')
        .select('id, customer_name, job_name, due_date')
        .in('id', bidIds),
      supabase
        .from('users')
        .select('id, full_name, email')
        .in('id', traderIds),
    ]);
    const bidById = new Map(
      (bidsResult.data ?? []).map((b) => [b.id as string, b] as const),
    );
    const traderById = new Map(
      (tradersResult.data ?? []).map((u) => [u.id as string, u] as const),
    );

    rows = quoteRows.map((q) => {
      const bid = bidById.get(q.bid_id as string);
      const trader = traderById.get(q.created_by as string);
      return {
        quoteId: q.id as string,
        bidId: q.bid_id as string,
        customer: (bid?.customer_name as string | null) ?? 'Unknown customer',
        jobName: (bid?.job_name as string | null) ?? null,
        dueDate: (bid?.due_date as string | null) ?? null,
        trader:
          (trader?.full_name as string | null) ??
          (trader?.email as string | null) ??
          'Unknown trader',
        total: Number(q.total),
        blendedMarginPercent: Number(q.margin_percent),
        submittedAt: (q.updated_at as string) ?? (q.created_at as string),
      };
    });
  }

  const totalValue = rows.reduce((s, r) => s + r.total, 0);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-h1 text-text-primary">Manager dashboard</h1>
        <p className="mt-1 text-body text-text-secondary">
          Approve or return quotes above the threshold. Approved quotes can be
          released to the customer from the quote page.
        </p>
      </header>

      {/* Summary card ------------------------------------------------- */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <StatCard label="Pending approvals" value={rows.length.toLocaleString()} />
        <StatCard
          label="Total pending value"
          value={USD_COMPACT.format(totalValue)}
        />
        <StatCard
          label="Oldest pending"
          value={
            rows.length > 0
              ? formatRelative(
                  new Date(rows[rows.length - 1]!.submittedAt).getTime(),
                )
              : '—'
          }
        />
      </div>

      {/* Approval queue ------------------------------------------------ */}
      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="overflow-hidden rounded-md border border-border-base bg-bg-surface shadow-sm">
          <table className="w-full border-separate border-spacing-0 text-body-sm">
            <thead className="sticky top-0 z-10">
              <tr className="bg-bg-surface">
                <Th align="left">Customer</Th>
                <Th align="left">Job</Th>
                <Th align="left">Trader</Th>
                <Th align="right">Total</Th>
                <Th align="right">Blended</Th>
                <Th align="left">Submitted</Th>
                <Th align="right" className="w-24">
                  <span className="sr-only">Review</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.quoteId}
                  className="transition-colors duration-micro hover:bg-bg-subtle"
                >
                  <td className="border-b border-border-subtle px-3 py-3 text-text-primary">
                    {row.customer}
                  </td>
                  <td className="border-b border-border-subtle px-3 py-3 text-text-secondary">
                    {row.jobName ?? '—'}
                  </td>
                  <td className="border-b border-border-subtle px-3 py-3 text-text-secondary">
                    {row.trader}
                  </td>
                  <td className="border-b border-border-subtle px-3 py-3 text-right font-mono tabular-nums text-text-primary">
                    {USD.format(row.total)}
                  </td>
                  <td
                    className={cn(
                      'border-b border-border-subtle px-3 py-3 text-right font-mono tabular-nums',
                      row.blendedMarginPercent < 0.05
                        ? 'text-semantic-error'
                        : 'text-text-primary',
                    )}
                  >
                    {(row.blendedMarginPercent * 100).toFixed(2)}%
                  </td>
                  <td className="border-b border-border-subtle px-3 py-3 text-text-tertiary">
                    {formatRelative(new Date(row.submittedAt).getTime())}
                  </td>
                  <td className="border-b border-border-subtle px-3 py-3 text-right">
                    <Link
                      href={`/bids/${row.bidId}/margin`}
                      className="inline-flex items-center gap-1 text-body-sm text-accent-primary transition-colors duration-micro hover:text-accent-secondary"
                    >
                      Review
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Subcomponents
// -----------------------------------------------------------------------------

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-base bg-bg-surface px-5 py-4 shadow-sm">
      <div className="text-label uppercase text-text-tertiary">{label}</div>
      <div className="mt-1 font-mono text-[28px] font-semibold tabular-nums text-text-primary">
        {value}
      </div>
    </div>
  );
}

function Th({
  children,
  align = 'left',
  className,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  return (
    <th
      className={cn(
        'border-b border-border-base bg-bg-surface px-3 py-2 text-label uppercase text-text-tertiary',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto mt-4 flex max-w-md flex-col items-center gap-3 rounded-md border border-border-base bg-bg-surface px-6 py-12 text-center shadow-sm">
      <Inbox className="h-12 w-12 text-text-tertiary" aria-hidden="true" />
      <h2 className="text-h3 text-text-secondary">No quotes awaiting approval</h2>
      <p className="text-body-sm text-text-tertiary">
        Buyers submit quotes for approval when they exceed the company
        approval threshold. Anything pending will appear here in real time.
      </p>
    </div>
  );
}

function RoleGate() {
  return (
    <div className="flex flex-col gap-6">
      <div className="mx-auto mt-8 flex max-w-md flex-col items-center gap-3 rounded-md border border-border-base bg-bg-surface px-6 py-12 text-center shadow-sm">
        <ShieldOff className="h-12 w-12 text-text-tertiary" aria-hidden="true" />
        <h2 className="text-h3 text-text-secondary">Manager access required</h2>
        <p className="text-body-sm text-text-tertiary">
          The approval queue is restricted to manager and owner roles. If
          you should have access, ask your admin to update your role.
        </p>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
