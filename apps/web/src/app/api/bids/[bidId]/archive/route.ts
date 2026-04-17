/**
 * POST /api/bids/[bidId]/archive — archive a bid.
 *
 * Purpose:  Sets `archived_at` and `archived_by` on the bid row. The
 *           workflow `status` is deliberately NOT modified — a `sent`
 *           quote stays `sent` after archive; the archive state is a
 *           separate lifecycle axis (see CLAUDE.md + migration 027).
 *
 *           Role gate:
 *             - Manager, owner, trader_buyer: can archive any bid in
 *               the tenant they can see.
 *             - Buyer: CANNOT archive. Their role is vendor-pricing,
 *               not bid lifecycle — see Prompt 10 spec.
 *             - Pure trader: can archive only bids where they are the
 *               assigned trader OR the creator. Mirrors the `bids`
 *               UPDATE RLS policy for traders (migration 003) except
 *               we also exclude buyer — the in-code gate is tighter
 *               than RLS.
 *
 *           Idempotent: re-archiving an already-archived bid returns
 *           200 with the existing `archivedAt` / `archivedBy` intact.
 *           No timestamp overwrite — a second call should not move the
 *           audit marker, and the UI must be safe to retry on a
 *           flaky network.
 *
 *           Write path uses the service-role admin client (paired with
 *           the explicit in-code role gate) — same pattern as
 *           /api/manager/approvals. RLS on bids would also allow the
 *           write for privileged users, but using admin makes the
 *           buyer-exclusion gate unambiguous.
 *
 * Inputs:   URL param bidId (uuid). No body.
 * Outputs:  200 { success, bid: { id, archivedAt, archivedBy } }.
 *           400 invalid bidId.
 *           401 not authenticated.
 *           403 wrong role / wrong tenant / trader not on the bid.
 *           404 bid not found.
 * Agent/API: none.
 * Imports:  next/server, zod, @lmbr/lib, supabase server client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getSupabaseAdmin } from '@lmbr/lib';

import { getSupabaseRouteHandlerClient } from '../../../../../lib/supabase/server';

export const runtime = 'nodejs';

const PRIVILEGED_ROLES = new Set(['trader_buyer', 'manager', 'owner']);
const TRADER_ROLE = 'trader';

const ParamsSchema = z.object({ bidId: z.string().uuid() });

interface BidForArchive {
  id: string;
  company_id: string;
  assigned_trader_id: string | null;
  created_by: string;
  archived_at: string | null;
  archived_by: string | null;
}

function canArchive(
  roles: string[],
  bid: BidForArchive,
  userId: string,
): boolean {
  if (roles.some((r) => PRIVILEGED_ROLES.has(r))) return true;
  if (
    roles.includes(TRADER_ROLE) &&
    (bid.assigned_trader_id === userId || bid.created_by === userId)
  ) {
    return true;
  }
  return false;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { bidId: string } },
): Promise<NextResponse> {
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid bidId' }, { status: 400 });
  }
  const { bidId } = parsed.data;

  try {
    const supabase = getSupabaseRouteHandlerClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const [profileResult, rolesResult] = await Promise.all([
      supabase
        .from('users')
        .select('id, company_id')
        .eq('id', session.user.id)
        .maybeSingle(),
      supabase.from('roles').select('role_type').eq('user_id', session.user.id),
    ]);
    if (profileResult.error) {
      return NextResponse.json(
        { error: profileResult.error.message },
        { status: 500 },
      );
    }
    const profile = profileResult.data;
    if (!profile?.company_id) {
      return NextResponse.json(
        { error: 'User profile not found' },
        { status: 403 },
      );
    }
    const roles = (rolesResult.data ?? []).map((r) => r.role_type as string);

    // RLS-scoped read so cross-tenant access is already blocked by
    // Postgres. We still compare company_id explicitly for a crisp 403.
    const { data: bidData, error: bidError } = await supabase
      .from('bids')
      .select(
        'id, company_id, assigned_trader_id, created_by, archived_at, archived_by',
      )
      .eq('id', bidId)
      .maybeSingle();
    if (bidError) {
      return NextResponse.json({ error: bidError.message }, { status: 500 });
    }
    const bid = bidData as BidForArchive | null;
    if (!bid) {
      return NextResponse.json({ error: 'Bid not found' }, { status: 404 });
    }
    if (bid.company_id !== profile.company_id) {
      return NextResponse.json(
        { error: 'Bid belongs to a different company' },
        { status: 403 },
      );
    }

    if (!canArchive(roles, bid, session.user.id)) {
      return NextResponse.json(
        {
          error:
            'Archiving requires trader_buyer / manager / owner, or trader on own bid.',
        },
        { status: 403 },
      );
    }

    // Idempotent path — already archived, return the existing marker
    // unchanged. No UPDATE issued so we don't overwrite the audit
    // timestamp on a retried call.
    if (bid.archived_at) {
      return NextResponse.json({
        success: true,
        bid: {
          id: bid.id,
          archivedAt: bid.archived_at,
          archivedBy: bid.archived_by,
        },
      });
    }

    const archivedAt = new Date().toISOString();
    const admin = getSupabaseAdmin();
    const { data: updated, error: updateError } = await admin
      .from('bids')
      .update({ archived_at: archivedAt, archived_by: session.user.id })
      .eq('id', bid.id)
      .eq('company_id', profile.company_id)
      .select('id, archived_at, archived_by')
      .single();
    if (updateError) {
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      bid: {
        id: updated!.id as string,
        archivedAt: updated!.archived_at as string,
        archivedBy: updated!.archived_by as string | null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Archive failed';
    console.warn(`LMBR.ai archive: ${message}.`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
