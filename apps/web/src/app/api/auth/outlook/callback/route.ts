/**
 * GET /api/auth/outlook/callback — Microsoft OAuth redirect landing pad.
 *
 * Purpose:  Microsoft redirects the browser here after the user signs in
 *           on login.microsoftonline.com. We exchange the `code` +
 *           signed `state` for tokens via outlook.handleAuthCallback,
 *           which verifies the state HMAC, calls MSAL, pulls mailbox
 *           identity via /me, encrypts the tokens, and upserts the
 *           outlook_connections row.
 *
 *           Success path redirects back to /settings/integrations with a
 *           flag. Failure redirects with an error code but NEVER echoes
 *           Microsoft's raw error / error_description fields in the URL
 *           (those can leak tenant + user info in browser history).
 *           Details go to server logs only.
 *
 *           Azure AD registration: the redirect URI in the app
 *           registration MUST include this route at the deployed host.
 *           Local dev defaults to http://localhost:3000/api/auth/outlook/callback;
 *           MICROSOFT_REDIRECT_URI should be set to the same URL.
 *
 * Inputs:   query params: code, state, error?, error_description?
 * Outputs:  302 redirect to /settings/integrations?connected=1
 *           or /settings/integrations?error=<code>
 * Agent/API: @lmbr/lib handleAuthCallback (wraps MSAL + Graph /me).
 * Imports:  next/server, @lmbr/lib.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { handleAuthCallback } from '@lmbr/lib';

export const runtime = 'nodejs';

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(
    /\/+$/,
    '',
  );
}

function redirectToIntegrations(flag: string, value: string): NextResponse {
  const url = `${appUrl()}/settings/integrations?${flag}=${encodeURIComponent(value)}`;
  return NextResponse.redirect(url, 302);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    // Microsoft-side failure (user denied consent, admin approval required,
    // etc.). Log the full detail server-side but never reflect it in the
    // redirect target.
    const description = url.searchParams.get('error_description');
    console.warn(
      `LMBR.ai outlook callback: upstream error=${error} description=${description ?? ''}.`,
    );
    return redirectToIntegrations('error', 'auth_denied');
  }

  if (!code || !state) {
    console.warn('LMBR.ai outlook callback: missing code or state.');
    return redirectToIntegrations('error', 'auth_failed');
  }

  try {
    const result = await handleAuthCallback(code, state);
    if (result.success) {
      return redirectToIntegrations('connected', '1');
    }
    return redirectToIntegrations('error', 'auth_failed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`LMBR.ai outlook callback: ${message}.`);
    return redirectToIntegrations('error', 'auth_failed');
  }
}
