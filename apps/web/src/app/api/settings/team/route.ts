/**
 * GET + POST /api/settings/team — team roster + invite.
 *
 * Purpose:  GET returns every member of the tenant with their single
 *           role (DB uniqueness: one role per user per tenant) plus
 *           a pending-invite flag derived from auth.users.last_sign_in_at.
 *
 *           POST invites a teammate. Mirrors the onboarding invite
 *           pattern (admin.auth.admin.inviteUserByEmail + upsert
 *           public.users + upsert public.roles) but broadens the
 *           accepted role set to include 'trader_buyer'. 'owner' is
 *           never invitable through this route — ownership must be
 *           bootstrapped via onboarding, and is promoted separately
 *           with PATCH /api/settings/team/{userId} by an existing
 *           owner (TBD in a future session; this route does not
 *           expose that yet).
 *
 * Inputs:   session; POST body { email, fullName, roleType }.
 * Outputs:  { members: TeamMember[] } (GET) or { userId } (POST).
 * Agent/API: Supabase (admin for auth + service-role reads).
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

// Invitable roles. 'owner' is excluded intentionally — ownership is
// bootstrapped at onboarding and promotion is a separate manual flow.
const INVITABLE_ROLE_VALUES = ['trader', 'buyer', 'trader_buyer', 'manager'] as const;
const InvitableRoleSchema = z.enum(INVITABLE_ROLE_VALUES);
type InvitableRole = z.infer<typeof InvitableRoleSchema>;

const InviteSchema = z.object({
  email: z.string().email(),
  fullName: z.string().trim().min(2).max(120),
  roleType: InvitableRoleSchema,
});

// Local — Next 14 disallows non-handler exports from route files.
interface TeamMember {
  id: string;
  email: string;
  fullName: string | null;
  role: string | null;         // null = deactivated (role row removed)
  pending: boolean;            // invited but never signed in
  lastSignInAt: string | null;
}

async function resolveContext(
  req: NextRequest,
): Promise<
  | { companyId: string; isManagerOrOwner: boolean; callerId: string }
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
    return { error: NextResponse.json({ error: 'User profile not found' }, { status: 403 }) };
  }
  const callerRoles = (rolesResult.data ?? []).map((r) => r.role_type as string);
  const isManagerOrOwner = callerRoles.some((r) => MANAGER_ROLES.has(r));
  void req;
  return {
    companyId: profile.company_id as string,
    isManagerOrOwner,
    callerId: session.user.id,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await resolveContext(req);
    if ('error' in ctx) return ctx.error;

    const admin = getSupabaseAdmin();

    // Fetch the public.users + roles rows for the tenant in parallel
    // with the auth.users list. auth.admin.listUsers is platform-wide,
    // so we re-key by email to bind to tenant rows without leaking.
    const [usersRes, rolesRes, authRes] = await Promise.all([
      admin
        .from('users')
        .select('id, email, full_name, created_at')
        .eq('company_id', ctx.companyId),
      admin
        .from('roles')
        .select('user_id, role_type')
        .eq('company_id', ctx.companyId),
      admin.auth.admin.listUsers({ page: 1, perPage: 200 }),
    ]);

    const rolesByUser = new Map<string, string>();
    for (const r of rolesRes.data ?? []) {
      rolesByUser.set(r.user_id as string, r.role_type as string);
    }
    const authById = new Map<string, { lastSignInAt: string | null }>();
    for (const u of authRes.data?.users ?? []) {
      if (!u.id) continue;
      authById.set(u.id, {
        lastSignInAt: (u.last_sign_in_at as string | null) ?? null,
      });
    }

    const members: TeamMember[] = (usersRes.data ?? [])
      .map((u) => {
        const auth = authById.get(u.id as string);
        return {
          id: u.id as string,
          email: u.email as string,
          fullName: (u.full_name as string | null) ?? null,
          role: rolesByUser.get(u.id as string) ?? null,
          pending: !auth || auth.lastSignInAt === null,
          lastSignInAt: auth?.lastSignInAt ?? null,
        };
      })
      .sort((a, b) => {
        // Pending first so the action affordance surfaces at the top,
        // then by email for deterministic order.
        if (a.pending !== b.pending) return a.pending ? -1 : 1;
        return a.email.localeCompare(b.email);
      });

    return NextResponse.json({ members });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Team load failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await resolveContext(req);
    if ('error' in ctx) return ctx.error;
    if (!ctx.isManagerOrOwner) {
      return NextResponse.json(
        { error: 'Only managers or owners can invite teammates.' },
        { status: 403 },
      );
    }

    const parsed = InviteSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message ?? 'Invalid body' },
        { status: 400 },
      );
    }

    const admin = getSupabaseAdmin();
    const email = parsed.data.email.toLowerCase();

    // Reject if the email already has a tenant row — covers both
    // "already invited" and "already active". The response is 409 so
    // the client can surface "already on the team" rather than "invite
    // failed".
    const { data: existing } = await admin
      .from('users')
      .select('id, company_id')
      .eq('email', email)
      .maybeSingle();
    if (existing) {
      return NextResponse.json(
        { error: 'That email is already associated with a user.' },
        { status: 409 },
      );
    }

    const redirectTo = (() => {
      try {
        const url = new URL(req.url);
        return `${url.origin}/login`;
      } catch {
        return undefined;
      }
    })();

    const { data: invite, error: inviteError } =
      await admin.auth.admin.inviteUserByEmail(email, {
        data: { full_name: parsed.data.fullName },
        redirectTo,
      });
    if (inviteError || !invite?.user) {
      return NextResponse.json(
        { error: inviteError?.message ?? 'Invite send failed' },
        { status: 500 },
      );
    }

    const invitedUserId = invite.user.id;
    const { error: userInsertError } = await admin.from('users').upsert({
      id: invitedUserId,
      company_id: ctx.companyId,
      email,
      full_name: parsed.data.fullName,
    });
    if (userInsertError) {
      return NextResponse.json({ error: userInsertError.message }, { status: 500 });
    }

    const { error: roleInsertError } = await admin
      .from('roles')
      .upsert(
        {
          user_id: invitedUserId,
          company_id: ctx.companyId,
          role_type: parsed.data.roleType,
        },
        { onConflict: 'user_id,company_id' },
      );
    if (roleInsertError) {
      return NextResponse.json({ error: roleInsertError.message }, { status: 500 });
    }

    return NextResponse.json({ userId: invitedUserId }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invite failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
