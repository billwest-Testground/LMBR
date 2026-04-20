/**
 * GET + PUT /api/settings/notifications — notification toggles.
 *
 * Purpose:  Reads and writes the companies.notification_prefs jsonb
 *           column added by migration 028. V1 exposes four keys:
 *           new_bid_received, vendor_bid_submitted,
 *           quote_approved_rejected, vendor_nudge_due. Additional
 *           channels (push, SMS) and per-user overrides are explicitly
 *           deferred — the V1 toggles are per-tenant email-only.
 *
 *           The contract with downstream senders: a missing key is
 *           treated as "on" so rolling out a new toggle doesn't break
 *           existing sends. The defaults in migration 028 are all
 *           `true` so a freshly-provisioned tenant behaves the same
 *           way as the legacy no-prefs path.
 *
 * Inputs:   session; PUT body NotificationPrefsSchema.
 * Outputs:  NotificationPrefs payload.
 * Agent/API: Supabase (admin).
 * Imports:  next/server, zod, @lmbr/lib, supabase server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getSupabaseAdmin } from '@lmbr/lib';

import { getSupabaseRouteHandlerClient } from '../../../../lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MANAGER_ROLES = new Set(['manager', 'owner']);

// Local — Next 14 disallows non-handler exports from route files.
// Callers that need the key list import it from the client component,
// which defines the same literal union.
const NOTIFICATION_KEYS = [
  'new_bid_received',
  'vendor_bid_submitted',
  'quote_approved_rejected',
  'vendor_nudge_due',
] as const;

type NotificationKey = (typeof NOTIFICATION_KEYS)[number];
type NotificationPrefs = Record<NotificationKey, boolean>;

const NotificationPrefsSchema = z.object({
  new_bid_received: z.boolean(),
  vendor_bid_submitted: z.boolean(),
  quote_approved_rejected: z.boolean(),
  vendor_nudge_due: z.boolean(),
});

const DEFAULTS: NotificationPrefs = {
  new_bid_received: true,
  vendor_bid_submitted: true,
  quote_approved_rejected: true,
  vendor_nudge_due: true,
};

function normalize(raw: unknown): NotificationPrefs {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const key of NOTIFICATION_KEYS) {
      const v = (raw as Record<string, unknown>)[key];
      if (typeof v === 'boolean') out[key] = v;
    }
  }
  return out;
}

async function resolveContext(
  req: NextRequest,
): Promise<{ companyId: string; isManagerOrOwner: boolean } | { error: NextResponse }> {
  const supabase = getSupabaseRouteHandlerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
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
    return { error: NextResponse.json({ error: 'User profile not found' }, { status: 403 }) };
  }
  const callerRoles = (rolesResult.data ?? []).map((r) => r.role_type as string);
  void req;
  return {
    companyId: profile.company_id as string,
    isManagerOrOwner: callerRoles.some((r) => MANAGER_ROLES.has(r)),
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await resolveContext(req);
    if ('error' in ctx) return ctx.error;

    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('companies')
      .select('notification_prefs')
      .eq('id', ctx.companyId)
      .maybeSingle();
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? 'Company not found' },
        { status: 404 },
      );
    }
    return NextResponse.json(normalize(data.notification_prefs));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Notifications load failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await resolveContext(req);
    if ('error' in ctx) return ctx.error;
    if (!ctx.isManagerOrOwner) {
      return NextResponse.json(
        { error: 'Editing notifications requires manager or owner role.' },
        { status: 403 },
      );
    }

    const parsed = NotificationPrefsSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message ?? 'Invalid body' },
        { status: 400 },
      );
    }

    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('companies')
      .update({ notification_prefs: parsed.data })
      .eq('id', ctx.companyId)
      .select('notification_prefs')
      .single();
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? 'Update failed' },
        { status: 500 },
      );
    }
    return NextResponse.json(normalize(data.notification_prefs));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Notifications update failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
