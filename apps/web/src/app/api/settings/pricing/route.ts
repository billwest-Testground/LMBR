/**
 * GET + PUT /api/settings/pricing — company quote-settings row.
 *
 * Purpose:  Exposes the three Prompt 07 columns added by migration 018 —
 *           `approval_threshold_dollars`, `min_margin_percent`, and
 *           `margin_presets` — for the /settings/pricing page. Writes
 *           are manager/owner-gated to match every other settings route.
 *
 *           Validation rules worth preserving:
 *             • approval_threshold_dollars is a non-negative dollar
 *               amount, capped at 10M so a typo can't accidentally
 *               disable the approval gate forever.
 *             • min_margin_percent is a fraction in [0, 1]. 0 allows
 *               zero-margin quotes (valid for trade-out scenarios);
 *               1.0 means "everything is above margin floor."
 *             • margin_presets is an array of up to 10 fractions in
 *               (0, 1). Duplicates stripped, values sorted ascending
 *               so the UI ladder is predictable. Empty array is
 *               rejected because the pricing screen relies on at least
 *               one preset to seed its ladder.
 *
 * Inputs:   session; PUT body validated below.
 * Outputs:  { approvalThresholdDollars, minMarginPercent, marginPresets }
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
interface PricingSettingsPayload {
  approvalThresholdDollars: number;
  minMarginPercent: number;
  marginPresets: number[];
}

const UpdateSchema = z
  .object({
    approvalThresholdDollars: z
      .number()
      .finite()
      .min(0)
      .max(10_000_000)
      .optional(),
    minMarginPercent: z.number().finite().min(0).max(1).optional(),
    marginPresets: z
      .array(z.number().finite().min(0).max(1))
      .min(1)
      .max(10)
      .optional(),
  })
  .refine(
    (v) =>
      v.approvalThresholdDollars !== undefined ||
      v.minMarginPercent !== undefined ||
      v.marginPresets !== undefined,
    { message: 'At least one field must be provided.' },
  );

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

function toPayload(row: Record<string, unknown>): PricingSettingsPayload {
  const presetsRaw = row.margin_presets;
  const presets = Array.isArray(presetsRaw)
    ? (presetsRaw as unknown[]).filter(
        (n): n is number => typeof n === 'number' && Number.isFinite(n),
      )
    : [];
  return {
    approvalThresholdDollars: Number(row.approval_threshold_dollars ?? 0),
    minMarginPercent: Number(row.min_margin_percent ?? 0),
    marginPresets: presets,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await resolveContext(req);
    if ('error' in ctx) return ctx.error;

    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('companies')
      .select('approval_threshold_dollars, min_margin_percent, margin_presets')
      .eq('id', ctx.companyId)
      .maybeSingle();
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? 'Company not found' },
        { status: 404 },
      );
    }
    return NextResponse.json(toPayload(data));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pricing load failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await resolveContext(req);
    if ('error' in ctx) return ctx.error;
    if (!ctx.isManagerOrOwner) {
      return NextResponse.json(
        { error: 'Editing pricing settings requires manager or owner role.' },
        { status: 403 },
      );
    }

    const parsed = UpdateSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message ?? 'Invalid body' },
        { status: 400 },
      );
    }
    const update: Record<string, unknown> = {};
    if (parsed.data.approvalThresholdDollars !== undefined) {
      update.approval_threshold_dollars = parsed.data.approvalThresholdDollars;
    }
    if (parsed.data.minMarginPercent !== undefined) {
      update.min_margin_percent = parsed.data.minMarginPercent;
    }
    if (parsed.data.marginPresets !== undefined) {
      const dedupedSorted = Array.from(new Set(parsed.data.marginPresets)).sort(
        (a, b) => a - b,
      );
      update.margin_presets = dedupedSorted;
    }

    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('companies')
      .update(update)
      .eq('id', ctx.companyId)
      .select('approval_threshold_dollars, min_margin_percent, margin_presets')
      .single();
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? 'Update failed' },
        { status: 500 },
      );
    }
    return NextResponse.json(toPayload(data));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Pricing update failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
