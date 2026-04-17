/**
 * POST + DELETE /api/webhook/outlook/subscribe — bids@ mailbox subscription.
 *
 * Purpose:  Manager/owner entry point for setting up (and tearing down)
 *           the Graph change-notification subscription on the shared
 *           bids@ mailbox. Only one active subscription per company is
 *           surfaced in the UI — setting up a second one is an
 *           operational edge case, not a first-class flow. If a manager
 *           subscribes while an active row already exists we return 409
 *           instead of silently orphaning the old one.
 *
 *           POST { mailboxEmail } → creates the Graph subscription and
 *           persists the row. Requires the caller to already have an
 *           Outlook OAuth connection (getGraphClient is called under
 *           the hood); if not, the usual outlook_not_connected short-
 *           code bubbles up.
 *           DELETE → tears down the current active subscription. Best-
 *           effort DELETE at Graph first; then drop the DB row whether
 *           or not Graph said 200 (a 404 from Graph means the
 *           subscription is already gone — either way the row is stale).
 *
 * Inputs:   POST: { mailboxEmail: string }.
 *           DELETE: no body.
 * Outputs:  POST: { subscriptionId, expiresAt, mailboxEmail }.
 *           DELETE: { success: true }.
 * Agent/API: @lmbr/lib (createSubscription, getGraphClient,
 *            getSupabaseAdmin).
 * Imports:  next/server, zod, @lmbr/lib, supabase server client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  createSubscription,
  getGraphClient,
  getSupabaseAdmin,
} from '@lmbr/lib';

import { getSupabaseRouteHandlerClient } from '../../../../../lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MANAGER_ROLES = new Set(['manager', 'owner']);

const SubscribeBodySchema = z.object({
  mailboxEmail: z.string().email(),
});

async function gateManager(
  supabase: ReturnType<typeof getSupabaseRouteHandlerClient>,
): Promise<
  | { ok: false; response: NextResponse }
  | { ok: true; userId: string; companyId: string }
> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }),
    };
  }
  const [profileResult, rolesResult] = await Promise.all([
    supabase
      .from('users')
      .select('id, company_id')
      .eq('id', session.user.id)
      .maybeSingle(),
    supabase.from('roles').select('role_type').eq('user_id', session.user.id),
  ]);
  const profile = profileResult.data;
  if (!profile?.company_id) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'User profile not found' },
        { status: 403 },
      ),
    };
  }
  const roles = (rolesResult.data ?? []).map((r) => r.role_type as string);
  if (!roles.some((r) => MANAGER_ROLES.has(r))) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            'Managing the bids@ subscription requires manager or owner role.',
        },
        { status: 403 },
      ),
    };
  }
  return { ok: true, userId: profile.id as string, companyId: profile.company_id as string };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const supabase = getSupabaseRouteHandlerClient();
    const gate = await gateManager(supabase);
    if (!gate.ok) return gate.response;

    const parsed = SubscribeBodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message ?? 'Invalid body' },
        { status: 400 },
      );
    }
    const mailboxEmail = parsed.data.mailboxEmail.toLowerCase();

    const admin = getSupabaseAdmin();
    const { data: existing } = await admin
      .from('outlook_subscriptions')
      .select('id, status')
      .eq('company_id', gate.companyId)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();
    if (existing) {
      return NextResponse.json(
        {
          error:
            'An active bids@ subscription already exists for this company. Disconnect it first.',
        },
        { status: 409 },
      );
    }

    const result = await createSubscription(
      gate.userId,
      gate.companyId,
      mailboxEmail,
    );

    return NextResponse.json({
      subscriptionId: result.subscriptionId,
      expiresAt: result.expirationDateTime,
      mailboxEmail,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`LMBR.ai subscribe: ${message}.`);
    // Classify: no-connection surfaces as a specific status so the UI
    // can point the manager at /settings/integrations to connect first.
    if (/no connection for user=/.test(message)) {
      return NextResponse.json(
        { error: 'outlook_not_connected' },
        { status: 412 },
      );
    }
    return NextResponse.json(
      { error: 'Subscription creation failed.' },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: NextRequest): Promise<NextResponse> {
  try {
    const supabase = getSupabaseRouteHandlerClient();
    const gate = await gateManager(supabase);
    if (!gate.ok) return gate.response;

    const admin = getSupabaseAdmin();
    const { data: row, error: loadErr } = await admin
      .from('outlook_subscriptions')
      .select('id, subscription_id, user_id, status')
      .eq('company_id', gate.companyId)
      .order('status', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (loadErr) {
      return NextResponse.json({ error: loadErr.message }, { status: 500 });
    }
    if (!row) {
      // Nothing to delete. Treat as idempotent success.
      return NextResponse.json({ success: true });
    }

    // Best-effort Graph-side delete. A 404 here means the subscription
    // already expired at Graph; either way the DB row is stale and
    // should go.
    try {
      const client = await getGraphClient(row.user_id as string, gate.companyId);
      await client
        .api(`/subscriptions/${row.subscription_id as string}`)
        .delete();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/404|NotFound|The specified object was not found/i.test(message)) {
        console.warn(
          `LMBR.ai subscribe DELETE: Graph delete non-fatal for subscription=${row.subscription_id as string}: ${message}.`,
        );
      }
    }

    const { error: delErr } = await admin
      .from('outlook_subscriptions')
      .delete()
      .eq('id', row.id as string);
    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Subscription tear-down failed';
    console.warn(`LMBR.ai subscribe DELETE: ${message}.`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
