/**
 * PATCH + DELETE /api/settings/team/{userId} — mutate a single teammate.
 *
 * Purpose:  PATCH body `{ role }` reassigns or clears the member's role.
 *             • role = 'trader' | 'buyer' | 'trader_buyer' | 'manager'
 *               → upserts the single public.roles row.
 *             • role = null
 *               → deletes the role row. The user stays in public.users
 *                 (so audit history and bid assignment FKs hold) but
 *                 fails every has_role() / is_manager_or_owner() check,
 *                 which in practice means they can't see or mutate
 *                 anything behind RLS. Reactivation = reassign a role.
 *
 *           DELETE cancels a pending invite — only valid while the
 *           user has never signed in. Flow:
 *             1. Verify auth.users.last_sign_in_at is null.
 *             2. Delete the auth.users row via admin.auth.admin.deleteUser.
 *             3. public.users + public.roles cascade off the auth delete
 *                (users.id REFERENCES auth.users(id) ON DELETE CASCADE).
 *           Rejects with 409 if the user has ever signed in — use PATCH
 *           role=null for that path instead.
 *
 *           Owner protection: none of these operations can mutate a row
 *           whose current role is 'owner' unless the caller is an owner
 *           AND there is more than one owner in the tenant. Prevents
 *           accidental solo-owner lockout.
 *
 * Inputs:   session; PATCH body { role: string | null }; params.userId.
 * Outputs:  { ok: true, role?: string | null }
 * Agent/API: Supabase admin.
 * Imports:  next/server, zod, @lmbr/lib, supabase server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getSupabaseAdmin } from '@lmbr/lib';

import { getSupabaseRouteHandlerClient } from '../../../../../lib/supabase/server';

export const runtime = 'nodejs';

const MANAGER_ROLES = new Set(['manager', 'owner']);

const PATCH_ROLES = ['trader', 'buyer', 'trader_buyer', 'manager'] as const;
const PatchSchema = z.object({
  role: z.enum(PATCH_ROLES).nullable(),
});

async function resolveContext(
  req: NextRequest,
): Promise<
  | { companyId: string; isManagerOrOwner: boolean; isOwner: boolean; callerId: string }
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
  void req;
  return {
    companyId: profile.company_id as string,
    isManagerOrOwner: callerRoles.some((r) => MANAGER_ROLES.has(r)),
    isOwner: callerRoles.includes('owner'),
    callerId: session.user.id,
  };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { userId: string } },
): Promise<NextResponse> {
  try {
    const ctx = await resolveContext(req);
    if ('error' in ctx) return ctx.error;
    if (!ctx.isManagerOrOwner) {
      return NextResponse.json(
        { error: 'Only managers or owners can change roles.' },
        { status: 403 },
      );
    }

    const parsed = PatchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message ?? 'Invalid body' },
        { status: 400 },
      );
    }
    const nextRole = parsed.data.role;

    const admin = getSupabaseAdmin();

    // Confirm the target user belongs to this tenant — never trust
    // the userId param as authoritative for tenancy.
    const { data: targetUser } = await admin
      .from('users')
      .select('id, company_id')
      .eq('id', params.userId)
      .maybeSingle();
    if (!targetUser || targetUser.company_id !== ctx.companyId) {
      return NextResponse.json({ error: 'User not found in tenant' }, { status: 404 });
    }

    // Load the target's current role row (if any) so we can run the
    // owner-safety guard before mutating.
    const { data: currentRoleRow } = await admin
      .from('roles')
      .select('role_type')
      .eq('user_id', params.userId)
      .eq('company_id', ctx.companyId)
      .maybeSingle();
    const currentRole = (currentRoleRow?.role_type as string | undefined) ?? null;

    if (currentRole === 'owner') {
      if (!ctx.isOwner) {
        return NextResponse.json(
          { error: 'Only another owner can change an owner role.' },
          { status: 403 },
        );
      }
      // Count remaining owners — block demotion below one.
      const { count: ownerCount } = await admin
        .from('roles')
        .select('user_id', { count: 'exact', head: true })
        .eq('company_id', ctx.companyId)
        .eq('role_type', 'owner');
      if ((ownerCount ?? 0) <= 1) {
        return NextResponse.json(
          { error: 'Cannot demote the last remaining owner.' },
          { status: 409 },
        );
      }
    }

    if (nextRole === null) {
      const { error } = await admin
        .from('roles')
        .delete()
        .eq('user_id', params.userId)
        .eq('company_id', ctx.companyId);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      return NextResponse.json({ ok: true, role: null });
    }

    const { error } = await admin
      .from('roles')
      .upsert(
        {
          user_id: params.userId,
          company_id: ctx.companyId,
          role_type: nextRole,
        },
        { onConflict: 'user_id,company_id' },
      );
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, role: nextRole });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Team PATCH failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { userId: string } },
): Promise<NextResponse> {
  try {
    const ctx = await resolveContext(req);
    if ('error' in ctx) return ctx.error;
    if (!ctx.isManagerOrOwner) {
      return NextResponse.json(
        { error: 'Only managers or owners can cancel invites.' },
        { status: 403 },
      );
    }

    const admin = getSupabaseAdmin();

    // Tenant + never-signed-in check — DELETE is strictly for pending
    // invites. Active users must go through PATCH role=null.
    const { data: targetUser } = await admin
      .from('users')
      .select('id, company_id')
      .eq('id', params.userId)
      .maybeSingle();
    if (!targetUser || targetUser.company_id !== ctx.companyId) {
      return NextResponse.json({ error: 'User not found in tenant' }, { status: 404 });
    }
    if (params.userId === ctx.callerId) {
      return NextResponse.json(
        { error: 'Cannot cancel your own account from this endpoint.' },
        { status: 400 },
      );
    }

    const { data: authUser } = await admin.auth.admin.getUserById(params.userId);
    if (authUser?.user?.last_sign_in_at) {
      return NextResponse.json(
        { error: 'User has already accepted the invite. Deactivate the role instead.' },
        { status: 409 },
      );
    }

    const { error: deleteError } = await admin.auth.admin.deleteUser(params.userId);
    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invite cancel failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
