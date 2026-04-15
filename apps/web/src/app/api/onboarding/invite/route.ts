/**
 * POST /api/onboarding/invite — invite a teammate into the tenant.
 *
 * Purpose:  Sends a Supabase magic-link invitation to a new teammate and
 *           pre-seeds their public.users + public.roles rows so that when
 *           they click the link and land in the app they immediately have
 *           tenancy and role membership (no second onboarding hop). Only
 *           managers and owners may invite.
 *
 * Input:    { email, fullName, roleType }
 * Output:   { user_id }
 * Imports:  @lmbr/lib (getSupabaseAdmin), lib/supabase/server, zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getSupabaseAdmin } from '@lmbr/lib';
import { getSupabaseRouteHandlerClient } from '../../../../lib/supabase/server';

export const runtime = 'nodejs';

const BodySchema = z.object({
  email: z.string().email(),
  fullName: z.string().trim().min(2).max(120),
  roleType: z.enum(['trader', 'buyer', 'trader_buyer', 'manager']),
});

export async function POST(req: Request) {
  const sessionClient = getSupabaseRouteHandlerClient();
  const {
    data: { session },
  } = await sessionClient.auth.getSession();

  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // Verify the caller is a manager/owner of a tenant.
  const { data: callerProfile } = await sessionClient
    .from('users')
    .select('company_id')
    .eq('id', session.user.id)
    .maybeSingle();

  if (!callerProfile?.company_id) {
    return NextResponse.json(
      { error: 'Complete company setup before inviting teammates.' },
      { status: 400 },
    );
  }

  const { data: callerRoles } = await sessionClient
    .from('roles')
    .select('role_type')
    .eq('user_id', session.user.id);

  const callerRoleSet = new Set((callerRoles ?? []).map((r) => r.role_type));
  if (!callerRoleSet.has('manager') && !callerRoleSet.has('owner')) {
    return NextResponse.json(
      { error: 'Only managers or owners can invite teammates.' },
      { status: 403 },
    );
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.errors[0]?.message ?? 'Invalid input' : 'Invalid JSON';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  // inviteUserByEmail creates the auth.users row immediately and emails a
  // magic link. We then use its returned user.id to seed public.users and
  // public.roles so the invitee lands in an already-provisioned tenant.
  const { data: invite, error: inviteError } =
    await admin.auth.admin.inviteUserByEmail(body.email, {
      data: { full_name: body.fullName },
      redirectTo: buildRedirect(req),
    });

  if (inviteError || !invite?.user) {
    return NextResponse.json(
      { error: inviteError?.message ?? 'Failed to send invite' },
      { status: 500 },
    );
  }

  const invitedUserId = invite.user.id;

  const { error: userInsertError } = await admin.from('users').upsert({
    id: invitedUserId,
    company_id: callerProfile.company_id,
    email: body.email.toLowerCase(),
    full_name: body.fullName,
  });

  if (userInsertError) {
    return NextResponse.json({ error: userInsertError.message }, { status: 500 });
  }

  const { error: roleInsertError } = await admin
    .from('roles')
    .upsert(
      {
        user_id: invitedUserId,
        company_id: callerProfile.company_id,
        role_type: body.roleType,
      },
      { onConflict: 'user_id,company_id' },
    );

  if (roleInsertError) {
    return NextResponse.json({ error: roleInsertError.message }, { status: 500 });
  }

  return NextResponse.json({ user_id: invitedUserId }, { status: 201 });
}

function buildRedirect(req: Request): string | undefined {
  try {
    const url = new URL(req.url);
    return `${url.origin}/login`;
  } catch {
    return undefined;
  }
}
