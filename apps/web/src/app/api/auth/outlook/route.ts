/**
 * GET + DELETE /api/auth/outlook — personal Outlook connection handle.
 *
 * Purpose:  Two paired operations on the caller's own
 *           outlook_connections row:
 *
 *             GET    — mint a Microsoft OAuth URL. The settings UI
 *                      redirects the browser there; Microsoft sends the
 *                      user back to /api/auth/outlook/callback with a
 *                      code + signed state.
 *             DELETE — disconnect. Drops the row from
 *                      outlook_connections so no subsequent sendMail /
 *                      getGraphClient call can use the cached tokens.
 *                      A best-effort Graph-side revoke is NOT attempted
 *                      here — Microsoft does not expose a token-
 *                      revocation endpoint for delegated confidential
 *                      clients; the user revokes through their tenant
 *                      admin panel if they want server-side invalidation.
 *                      Deleting the row is sufficient for "LMBR stops
 *                      acting on my behalf" which is what the UI
 *                      promises.
 *
 *           Scoped to the caller's own (user_id, company_id). A user
 *           cannot disconnect another user's Outlook from this route.
 *           Managers/owners have a separate path (future Prompt)
 *           for forcibly revoking teammate connections.
 *
 * Inputs:   GET: session only.
 *           DELETE: session only.
 * Outputs:  GET: { authUrl }
 *           DELETE: { success: true }
 * Agent/API: @lmbr/lib (getAuthUrl, getSupabaseAdmin).
 * Imports:  next/server, @lmbr/lib, supabase server client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getAuthUrl, getSupabaseAdmin } from '@lmbr/lib';

import { getSupabaseRouteHandlerClient } from '../../../../lib/supabase/server';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const supabase = getSupabaseRouteHandlerClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('users')
      .select('id, company_id')
      .eq('id', session.user.id)
      .maybeSingle();
    if (!profile?.company_id) {
      return NextResponse.json(
        { error: 'User profile not found' },
        { status: 403 },
      );
    }

    const authUrl = await getAuthUrl(profile.company_id, profile.id);
    return NextResponse.json({ authUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Auth URL failed';
    console.warn(`LMBR.ai outlook auth url: ${message}.`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest): Promise<NextResponse> {
  try {
    const supabase = getSupabaseRouteHandlerClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('users')
      .select('id, company_id')
      .eq('id', session.user.id)
      .maybeSingle();
    if (!profile?.company_id) {
      return NextResponse.json(
        { error: 'User profile not found' },
        { status: 403 },
      );
    }

    const admin = getSupabaseAdmin();
    const { error } = await admin
      .from('outlook_connections')
      .delete()
      .eq('user_id', profile.id)
      .eq('company_id', profile.company_id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Disconnect failed';
    console.warn(`LMBR.ai outlook disconnect: ${message}.`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
