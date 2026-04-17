/**
 * PUT /api/settings/email-subjects — save per-company email subject overrides.
 *
 * Purpose:  Saves the three `companies.*_email_subject` columns added by
 *           migration 023. Manager/owner only — overriding outbound email
 *           subjects is a branding/tone decision that sits at the same
 *           trust level as role assignments and approval thresholds.
 *
 *           An empty string or a whitespace-only value clears the
 *           override (column → NULL) so the hardcoded default in
 *           packages/lib/src/outlook.ts kicks back in. This lets the
 *           settings UI show a "Reset to default" button that posts an
 *           empty string without a separate endpoint.
 *
 * Inputs:   { dispatch?: string | null, nudge?: string | null,
 *             quote?: string | null }
 * Outputs:  { dispatch, nudge, quote } echoed back as persisted values
 *             (null for cleared, string for set).
 * Agent/API: Supabase (service-role — RLS on companies restricts UPDATE
 *            to owner/manager via migration 001 pattern; we do the same
 *            check in-route for a crisp 403).
 * Imports:  next/server, zod, @lmbr/lib, supabase server client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getSupabaseAdmin } from '@lmbr/lib';

import { getSupabaseRouteHandlerClient } from '../../../../lib/supabase/server';

export const runtime = 'nodejs';

const MANAGER_ROLES = new Set(['manager', 'owner']);

const SubjectSchema = z
  .string()
  .max(240)
  .nullable()
  .transform((v) => {
    if (v === null) return null;
    const trimmed = v.trim();
    return trimmed.length === 0 ? null : trimmed;
  });

const BodySchema = z.object({
  dispatch: SubjectSchema.optional(),
  nudge: SubjectSchema.optional(),
  quote: SubjectSchema.optional(),
});

export async function PUT(req: NextRequest): Promise<NextResponse> {
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
    const roles = (rolesResult.data ?? []).map((r) => r.role_type as string);
    if (!roles.some((r) => MANAGER_ROLES.has(r))) {
      return NextResponse.json(
        {
          error:
            'Editing email templates requires manager or owner role.',
        },
        { status: 403 },
      );
    }

    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message ?? 'Invalid body' },
        { status: 400 },
      );
    }

    // Build the update payload with only the fields the caller sent.
    // Omitting a key leaves that column untouched — the UI can persist
    // one row at a time without overwriting the other two with null.
    const update: Record<string, string | null> = {};
    if ('dispatch' in parsed.data)
      update.dispatch_email_subject = parsed.data.dispatch ?? null;
    if ('nudge' in parsed.data)
      update.nudge_email_subject = parsed.data.nudge ?? null;
    if ('quote' in parsed.data)
      update.quote_email_subject = parsed.data.quote ?? null;

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { error: 'At least one of dispatch/nudge/quote must be provided.' },
        { status: 400 },
      );
    }

    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('companies')
      .update(update)
      .eq('id', profile.company_id)
      .select(
        'dispatch_email_subject, nudge_email_subject, quote_email_subject',
      )
      .single();
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? 'Update failed' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      dispatch: (data.dispatch_email_subject as string | null) ?? null,
      nudge: (data.nudge_email_subject as string | null) ?? null,
      quote: (data.quote_email_subject as string | null) ?? null,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Email subjects update failed';
    console.warn(`LMBR.ai email subjects: ${message}.`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
