/**
 * GET /api/auth/outlook/status — Integrations page read-only data loader.
 *
 * Purpose:  Feeds the /settings/integrations client with three payloads
 *           in one round trip:
 *
 *             personal     — the caller's own connection (or null).
 *             subscription — the company's single active bids@ mailbox
 *                            subscription (or null).
 *             team         — every teammate's connection status.
 *                            Populated for manager/owner roles only;
 *                            empty array for other roles.
 *             counters     — emails_this_month (distinct bids created
 *                            from inbound Graph notifications since the
 *                            first of the current UTC month).
 *
 *           Never returns decrypted tokens — only metadata. The columns
 *           are ciphertext to the DB anyway; this route doesn't select
 *           them. Error codes are narrow so the UI can branch cleanly
 *           ('outlook_not_connected' / 'outlook_needs_reauth' / etc).
 *
 * Inputs:   session only.
 * Outputs:  { personal, subscription, team, counters }.
 * Agent/API: Supabase (service-role for team rollup, session client
 *            for the caller's own row).
 * Imports:  next/server, @lmbr/lib, supabase server client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getSupabaseAdmin } from '@lmbr/lib';

import { getSupabaseRouteHandlerClient } from '../../../../../lib/supabase/server';

export const runtime = 'nodejs';

const MANAGER_ROLES = new Set(['manager', 'owner']);

export interface PersonalConnectionStatus {
  status: 'connected' | 'needs_reauth' | 'not_connected';
  email: string | null;
  displayName: string | null;
  connectedAt: string | null;
  lastUsedAt: string | null;
}

export interface SubscriptionStatus {
  status: 'active' | 'degraded' | 'expired';
  mailboxEmail: string;
  subscriptionId: string;
  expiresAt: string;
  lastRenewedAt: string | null;
  emailsThisMonth: number;
}

export interface TeamMemberStatus {
  userId: string;
  fullName: string | null;
  email: string;
  roles: string[];
  status: 'connected' | 'needs_reauth' | 'not_connected';
  lastUsedAt: string | null;
}

export interface IntegrationsStatusResponse {
  personal: PersonalConnectionStatus;
  subscription: SubscriptionStatus | null;
  team: TeamMemberStatus[];
  counters: { emailsThisMonth: number };
  subjects: {
    dispatch: string | null;
    nudge: string | null;
    quote: string | null;
  };
  isManagerOrOwner: boolean;
}

function monthStartIso(): string {
  const now = new Date();
  const iso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return iso.toISOString();
}

export async function GET(
  _req: NextRequest,
): Promise<NextResponse<IntegrationsStatusResponse | { error: string }>> {
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
    const profile = profileResult.data;
    if (!profile?.company_id) {
      return NextResponse.json(
        { error: 'User profile not found' },
        { status: 403 },
      );
    }
    const callerRoles = (rolesResult.data ?? []).map(
      (r) => r.role_type as string,
    );
    const isManagerOrOwner = callerRoles.some((r) => MANAGER_ROLES.has(r));

    const admin = getSupabaseAdmin();

    // --- Personal connection -------------------------------------------
    const { data: connectionRow } = await admin
      .from('outlook_connections')
      .select('email, display_name, connected_at, last_used_at, status')
      .eq('user_id', profile.id)
      .eq('company_id', profile.company_id)
      .maybeSingle();

    let personal: PersonalConnectionStatus;
    if (!connectionRow) {
      personal = {
        status: 'not_connected',
        email: null,
        displayName: null,
        connectedAt: null,
        lastUsedAt: null,
      };
    } else {
      const status =
        connectionRow.status === 'active'
          ? 'connected'
          : connectionRow.status === 'expired' ||
              connectionRow.status === 'revoked'
            ? 'needs_reauth'
            : 'not_connected';
      personal = {
        status,
        email: (connectionRow.email as string | null) ?? null,
        displayName: (connectionRow.display_name as string | null) ?? null,
        connectedAt: (connectionRow.connected_at as string | null) ?? null,
        lastUsedAt: (connectionRow.last_used_at as string | null) ?? null,
      };
    }

    // --- Subscription (latest active, or latest overall) ---------------
    // We surface at most one subscription in the UI — the "bids@ mailbox"
    // section is modeled as a single row. Prefer an active subscription
    // if one exists; otherwise show whichever is most recent so the UI
    // can render the "reconnect" state.
    const { data: subRow } = await admin
      .from('outlook_subscriptions')
      .select(
        'subscription_id, resource, expiration_datetime, last_renewed_at, status, created_at',
      )
      .eq('company_id', profile.company_id)
      .order('status', { ascending: true })
      .order('expiration_datetime', { ascending: false })
      .limit(1)
      .maybeSingle();

    let subscription: SubscriptionStatus | null = null;
    if (subRow) {
      const match = /^users\/([^/]+)\/messages$/i.exec(
        (subRow.resource as string) ?? '',
      );
      const mailbox = match && match[1] ? match[1] : '';
      subscription = {
        status: subRow.status as 'active' | 'degraded' | 'expired',
        mailboxEmail: mailbox,
        subscriptionId: subRow.subscription_id as string,
        expiresAt: subRow.expiration_datetime as string,
        lastRenewedAt: (subRow.last_renewed_at as string | null) ?? null,
        emailsThisMonth: 0, // filled in below in parallel
      };
    }

    // --- Counter: emails processed this month --------------------------
    const { count: emailsThisMonth } = await admin
      .from('bids')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', profile.company_id)
      .not('message_id', 'is', null)
      .gte('created_at', monthStartIso());

    if (subscription) {
      subscription.emailsThisMonth = emailsThisMonth ?? 0;
    }

    // --- Subject overrides for the template editor -----------------------
    const { data: companyRow } = await admin
      .from('companies')
      .select('dispatch_email_subject, nudge_email_subject, quote_email_subject')
      .eq('id', profile.company_id)
      .maybeSingle();
    const subjects = {
      dispatch: (companyRow?.dispatch_email_subject as string | null) ?? null,
      nudge: (companyRow?.nudge_email_subject as string | null) ?? null,
      quote: (companyRow?.quote_email_subject as string | null) ?? null,
    };

    // --- Team rollup (manager/owner only) -------------------------------
    let team: TeamMemberStatus[] = [];
    if (isManagerOrOwner) {
      const [usersResult, rolesAllResult, connsResult] = await Promise.all([
        admin
          .from('users')
          .select('id, email, full_name')
          .eq('company_id', profile.company_id),
        admin
          .from('roles')
          .select('user_id, role_type')
          .eq('company_id', profile.company_id),
        admin
          .from('outlook_connections')
          .select('user_id, status, last_used_at')
          .eq('company_id', profile.company_id),
      ]);

      const rolesByUser = new Map<string, string[]>();
      for (const row of rolesAllResult.data ?? []) {
        const uid = row.user_id as string;
        const type = row.role_type as string;
        const arr = rolesByUser.get(uid) ?? [];
        if (!arr.includes(type)) arr.push(type);
        rolesByUser.set(uid, arr);
      }

      const connByUser = new Map<
        string,
        { status: 'active' | 'expired' | 'revoked'; last_used_at: string | null }
      >();
      for (const row of connsResult.data ?? []) {
        connByUser.set(row.user_id as string, {
          status: row.status as 'active' | 'expired' | 'revoked',
          last_used_at: (row.last_used_at as string | null) ?? null,
        });
      }

      team = (usersResult.data ?? []).map((u) => {
        const conn = connByUser.get(u.id as string);
        const status = !conn
          ? 'not_connected'
          : conn.status === 'active'
            ? 'connected'
            : 'needs_reauth';
        return {
          userId: u.id as string,
          fullName: (u.full_name as string | null) ?? null,
          email: u.email as string,
          roles: rolesByUser.get(u.id as string) ?? [],
          status,
          lastUsedAt: conn?.last_used_at ?? null,
        };
      });
    }

    return NextResponse.json({
      personal,
      subscription,
      team,
      counters: { emailsThisMonth: emailsThisMonth ?? 0 },
      subjects,
      isManagerOrOwner,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Status load failed';
    console.warn(`LMBR.ai outlook status: ${message}.`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
