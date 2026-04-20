/**
 * Bid quote page — customer PDF preview + release surface.
 *
 * Purpose:  Server-rendered shell for /bids/[bidId]/quote. Validates the
 *           session, enforces the preview role gate (trader | trader_buyer
 *           | manager | owner), loads the latest quote row + bid meta,
 *           and hands off to <QuotePreviewClient> for the interactive
 *           preview + release handshake. Managers/owners see the Release
 *           control; others see a disabled chip explaining the gate.
 *
 *           Pure-trader role gating mirrors /api/quote preview-side so
 *           the page surface matches the API contract exactly.
 *
 * Inputs:   params.bidId.
 * Outputs:  Quote preview JSX.
 * Agent/API: /api/quote on the client side.
 * Imports:  next/navigation, next/link, lucide-react,
 *           ../../../../lib/supabase/server,
 *           ../../../../components/bids/quote-preview-client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, ShieldOff } from 'lucide-react';

import { getSupabaseRSCClient } from '../../../../lib/supabase/server';
import {
  QuotePreviewClient,
  type QuotePreviewClientQuote,
} from '../../../../components/bids/quote-preview-client';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { bidId: string };
}

const PREVIEW_ROLES = new Set([
  'trader',
  'trader_buyer',
  'manager',
  'owner',
]);
const RELEASE_ROLES = new Set(['manager', 'owner']);

export default async function QuotePage({ params }: PageProps) {
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
  const hasPreview = roles.some((r) => PREVIEW_ROLES.has(r));
  if (!hasPreview) return <RoleGate bidId={params.bidId} />;

  const canRelease = roles.some((r) => RELEASE_ROLES.has(r));

  const [bidResult, quoteResult] = await Promise.all([
    supabase
      .from('bids')
      .select('id, company_id, customer_name, job_name')
      .eq('id', params.bidId)
      .maybeSingle(),
    supabase
      .from('quotes')
      .select('id, status, total, pdf_url')
      .eq('bid_id', params.bidId)
      .eq('company_id', profile.company_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const bid = bidResult.data;
  if (!bid) notFound();
  if (bid.company_id !== profile.company_id) notFound();

  const quote: QuotePreviewClientQuote | null = quoteResult.data
    ? {
        id: quoteResult.data.id as string,
        status: quoteResult.data.status as QuotePreviewClientQuote['status'],
        total: Number(quoteResult.data.total),
        pdfUrl: (quoteResult.data.pdf_url as string | null) ?? null,
      }
    : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="min-w-0">
        <Link
          href={`/bids/${bid.id}/margin`}
          className="inline-flex items-center gap-1 text-caption text-text-tertiary transition-colors duration-micro hover:text-text-secondary"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden="true" />
          Back to margin stack
        </Link>
        <h1 className="mt-2 text-h1 text-text-primary">
          Quote — {(bid.customer_name as string) ?? 'Customer'}
        </h1>
        {bid.job_name && (
          <p className="mt-1 text-body text-text-secondary">
            {bid.job_name as string}
          </p>
        )}
      </header>

      {!quote && (
        <div className="rounded-md border border-[rgba(184,122,29,0.4)] bg-[rgba(184,122,29,0.08)] px-4 py-3 text-body-sm text-semantic-warning">
          No quote persisted for this bid yet. Open the margin stack and save
          a draft before previewing.
        </div>
      )}

      <QuotePreviewClient
        bidId={params.bidId}
        customerName={(bid.customer_name as string) ?? 'Customer'}
        quote={quote}
        canRelease={canRelease}
      />
    </div>
  );
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
        <h1 className="mt-2 text-h1 text-text-primary">Quote</h1>
      </header>
      <div className="mx-auto mt-8 flex max-w-md flex-col items-center gap-3 rounded-md border border-border-base bg-bg-surface px-6 py-12 text-center shadow-sm">
        <ShieldOff className="h-12 w-12 text-text-tertiary" aria-hidden="true" />
        <h2 className="text-h3 text-text-secondary">
          Quote preview requires a trader-aligned role
        </h2>
        <p className="text-body-sm text-text-tertiary">
          Previewing or releasing customer quotes is restricted to trader,
          trader-buyer, manager, and owner roles.
        </p>
      </div>
    </div>
  );
}
