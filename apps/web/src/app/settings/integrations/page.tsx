/**
 * Settings — Integrations.
 *
 * Purpose:  Per-user Outlook connect/disconnect, plus manager-only
 *           controls for the shared bids@ mailbox subscription, a
 *           team connection roster, and email subject template
 *           overrides. The page is a thin server shell that enforces
 *           the session + tenant and delegates the interactivity to
 *           the `IntegrationsClient` island below.
 *
 * Inputs:   session.
 * Outputs:  JSX.
 * Agent/API: Microsoft Graph via @lmbr/lib (OAuth, subscriptions,
 *            sendMail) — consumed client-side via API routes.
 * Imports:  next/navigation, ../../../lib/supabase/server,
 *           ./integrations-client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { redirect } from 'next/navigation';

import { getSupabaseRSCClient } from '../../../lib/supabase/server';

import { IntegrationsClient } from './integrations-client';

export const dynamic = 'force-dynamic';

export default async function SettingsIntegrationsPage() {
  const supabase = getSupabaseRSCClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-h1 text-text-primary">Integrations</h1>
        <p className="mt-1 text-body text-text-secondary">
          Connect your Outlook account so vendor dispatches, nudges, and
          quote deliveries go out from your own email address. Managers
          also set up the shared bids@ mailbox here.
        </p>
      </header>

      <IntegrationsClient />
    </div>
  );
}
