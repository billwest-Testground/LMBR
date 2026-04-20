/**
 * POST + DELETE /api/settings/company/logo — company logo upload + clear.
 *
 * Purpose:  POST uploads a fresh company logo to the company-logos
 *           Storage bucket (migration 028) at the path
 *           `{companyId}/logo.{ext}`, then persists the resulting public
 *           URL to companies.logo_url so downstream quote PDF render
 *           paths read a ready-to-embed URL. Overwriting the same path
 *           each time means the bucket never accumulates orphan
 *           generations for a single tenant.
 *
 *           DELETE clears the logo_url (and best-effort removes the
 *           stored object). The Storage policies from migration 028
 *           allow manager/owner of the tenant to manipulate only their
 *           own company's prefix; we still enforce the role check in
 *           route for a crisp 403 path.
 *
 *           Accepted formats: png, jpg/jpeg, svg, webp. Max 2MB — the
 *           bucket has no hard limit but logos don't need more; larger
 *           uploads are rejected with 413.
 *
 * Inputs:   session + multipart form with a `logo` file field (POST).
 * Outputs:  { logoUrl: string | null }
 * Agent/API: Supabase Storage + Postgres.
 * Imports:  next/server, @lmbr/lib, supabase server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getSupabaseAdmin } from '@lmbr/lib';

import { getSupabaseRouteHandlerClient } from '../../../../../lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MANAGER_ROLES = new Set(['manager', 'owner']);
const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};
const BUCKET = 'company-logos';

async function resolveContext(
  req: NextRequest,
): Promise<{ companyId: string } | { error: NextResponse }> {
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
  if (!callerRoles.some((r) => MANAGER_ROLES.has(r))) {
    return {
      error: NextResponse.json(
        { error: 'Editing company settings requires manager or owner role.' },
        { status: 403 },
      ),
    };
  }
  void req;
  return { companyId: profile.company_id as string };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await resolveContext(req);
    if ('error' in ctx) return ctx.error;

    const form = await req.formData();
    const file = form.get('logo');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Missing logo file' }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: 'Empty logo file' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'Logo must be 2MB or smaller' }, { status: 413 });
    }
    const ext = ALLOWED[file.type];
    if (!ext) {
      return NextResponse.json(
        { error: 'Unsupported file type. Use PNG, JPG, SVG, or WebP.' },
        { status: 415 },
      );
    }

    const admin = getSupabaseAdmin();
    const path = `${ctx.companyId}/logo.${ext}`;
    const bytes = new Uint8Array(await file.arrayBuffer());

    // upsert=true so re-uploading the same tenant's logo overwrites the
    // previous object. Without upsert the insert path fails on the
    // second upload with a 409, forcing a two-step remove+upload dance.
    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(path, bytes, { contentType: file.type, upsert: true });
    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data: publicUrl } = admin.storage.from(BUCKET).getPublicUrl(path);
    // Bust any CDN caching on downstream reads by appending a cache-buster
    // tied to the upload wall-time. Without this the PDF render path
    // could pick up the previous generation for minutes after upload.
    const url = `${publicUrl.publicUrl}?v=${Date.now()}`;

    const { data, error } = await admin
      .from('companies')
      .update({ logo_url: url })
      .eq('id', ctx.companyId)
      .select('logo_url')
      .single();
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? 'Logo persist failed' },
        { status: 500 },
      );
    }
    return NextResponse.json({ logoUrl: data.logo_url as string });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Logo upload failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await resolveContext(req);
    if ('error' in ctx) return ctx.error;

    const admin = getSupabaseAdmin();

    // Best-effort object cleanup. We don't know the extension of the
    // currently-stored object, so list the prefix and remove whatever
    // is there. Storage errors are non-fatal — clearing the URL is the
    // contract the caller sees.
    const { data: listed } = await admin.storage.from(BUCKET).list(ctx.companyId);
    if (listed && listed.length > 0) {
      await admin.storage
        .from(BUCKET)
        .remove(listed.map((obj) => `${ctx.companyId}/${obj.name}`));
    }

    const { error } = await admin
      .from('companies')
      .update({ logo_url: null })
      .eq('id', ctx.companyId);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ logoUrl: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Logo clear failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
