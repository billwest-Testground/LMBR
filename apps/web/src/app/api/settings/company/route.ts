/**
 * GET + PUT /api/settings/company — read + write the tenant's company row.
 *
 * Purpose:  Powers /settings/company. GET returns every field the settings
 *           page renders (name, timezone, default consolidation mode,
 *           regions served, logo_url) so the client never has to touch
 *           the DB directly. PUT persists updates. Logo uploads are
 *           handled by the sibling /logo route because they require
 *           multipart parsing and Storage bucket interaction.
 *
 *           Write gate: manager/owner only. Mirrors the email-subjects
 *           route pattern (migration 023) — we check roles in TypeScript
 *           for a crisp 403, and rely on companies_update_manager RLS
 *           as a backstop in case the service-role client is ever
 *           removed.
 *
 * Inputs:   session; PUT body validated by UpdateCompanySchema.
 * Outputs:  Company settings payload.
 * Agent/API: Supabase (session + admin).
 * Imports:  next/server, zod, @lmbr/lib, @lmbr/config, supabase server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getSupabaseAdmin } from '@lmbr/lib';
import { isKnownTimezone, US_REGIONS } from '@lmbr/config';
import { ConsolidationModeSchema } from '@lmbr/types';

import { getSupabaseRouteHandlerClient } from '../../../../lib/supabase/server';

export const runtime = 'nodejs';
// cookies() inside resolveContext forces dynamic rendering. Declare
// it here so the Next 14 build skips static analysis — without the
// flag, `next build` emits DYNAMIC_SERVER_USAGE errors (non-fatal in
// runtime but noisy in logs) and in strict mode can fail prerender.
export const dynamic = 'force-dynamic';

const MANAGER_ROLES = new Set(['manager', 'owner']);
const KNOWN_REGIONS = new Set(US_REGIONS.map((r) => r.id));

// Local — Next 14 disallows non-handler exports from route files. The
// form component defines its own local copy of this shape.
interface CompanySettingsPayload {
  name: string;
  timezone: string;
  logoUrl: string | null;
  defaultConsolidationMode: 'structured' | 'consolidated' | 'phased' | 'hybrid';
  jobRegionsServed: string[];
}

const UpdateCompanySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isKnownTimezone, { message: 'Unsupported timezone' })
    .optional(),
  defaultConsolidationMode: ConsolidationModeSchema.optional(),
  jobRegionsServed: z
    .array(z.string())
    .max(US_REGIONS.length)
    .refine((arr) => arr.every((r) => KNOWN_REGIONS.has(r as never)), {
      message: 'Unknown region id',
    })
    .optional(),
});

async function resolveContext(
  req: NextRequest,
): Promise<
  | { companyId: string; isManagerOrOwner: boolean }
  | { error: NextResponse }
> {
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
    return {
      error: NextResponse.json({ error: 'User profile not found' }, { status: 403 }),
    };
  }
  const callerRoles = (rolesResult.data ?? []).map((r) => r.role_type as string);
  const isManagerOrOwner = callerRoles.some((r) => MANAGER_ROLES.has(r));
  void req;
  return {
    companyId: profile.company_id as string,
    isManagerOrOwner,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await resolveContext(req);
    if ('error' in ctx) return ctx.error;

    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('companies')
      .select(
        'name, timezone, logo_url, default_consolidation_mode, job_regions_served',
      )
      .eq('id', ctx.companyId)
      .maybeSingle();
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? 'Company not found' },
        { status: 404 },
      );
    }

    const payload: CompanySettingsPayload = {
      name: data.name as string,
      timezone: data.timezone as string,
      logoUrl: (data.logo_url as string | null) ?? null,
      defaultConsolidationMode:
        (data.default_consolidation_mode as CompanySettingsPayload['defaultConsolidationMode']) ??
        'structured',
      jobRegionsServed: Array.isArray(data.job_regions_served)
        ? (data.job_regions_served as string[])
        : [],
    };
    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Company load failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await resolveContext(req);
    if ('error' in ctx) return ctx.error;
    if (!ctx.isManagerOrOwner) {
      return NextResponse.json(
        { error: 'Editing company settings requires manager or owner role.' },
        { status: 403 },
      );
    }

    const parsed = UpdateCompanySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message ?? 'Invalid body' },
        { status: 400 },
      );
    }

    const update: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name;
    if (parsed.data.timezone !== undefined) update.timezone = parsed.data.timezone;
    if (parsed.data.defaultConsolidationMode !== undefined)
      update.default_consolidation_mode = parsed.data.defaultConsolidationMode;
    if (parsed.data.jobRegionsServed !== undefined) {
      // Dedupe defensively — the client picker shouldn't emit dupes, but an
      // accidental state merge on the client would otherwise land duplicate
      // rows in the text[] column.
      update.job_regions_served = Array.from(new Set(parsed.data.jobRegionsServed));
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'No updatable fields provided.' }, { status: 400 });
    }

    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('companies')
      .update(update)
      .eq('id', ctx.companyId)
      .select(
        'name, timezone, logo_url, default_consolidation_mode, job_regions_served',
      )
      .single();
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? 'Update failed' },
        { status: 500 },
      );
    }
    const payload: CompanySettingsPayload = {
      name: data.name as string,
      timezone: data.timezone as string,
      logoUrl: (data.logo_url as string | null) ?? null,
      defaultConsolidationMode:
        (data.default_consolidation_mode as CompanySettingsPayload['defaultConsolidationMode']) ??
        'structured',
      jobRegionsServed: Array.isArray(data.job_regions_served)
        ? (data.job_regions_served as string[])
        : [],
    };
    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Company update failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
