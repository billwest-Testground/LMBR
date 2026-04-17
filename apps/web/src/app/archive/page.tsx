/**
 * Archive page — archived bids + knowledge-base search entry point.
 *
 * Purpose:  Thin server shell that session-gates /archive and delegates
 *           everything interactive to <ArchiveClient />. Two tabs
 *           behind one URL; ?tab=archived (default) and ?tab=search
 *           are deep-linkable.
 *
 *           The sidebar already points here (/archive); this file
 *           replaces the 1-line stub with the real Prompt 10 surface.
 *
 * Inputs:   session cookie.
 * Outputs:  JSX.
 * Agent/API: client fetches /api/archive + /api/bids/[bidId]/reactivate.
 * Imports:  next/navigation, ../../lib/supabase/server,
 *           ./archive-client.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { redirect } from 'next/navigation';

import { getSupabaseRSCClient } from '../../lib/supabase/server';

import { ArchiveClient } from './archive-client';

export const dynamic = 'force-dynamic';

export default async function ArchivePage() {
  const supabase = getSupabaseRSCClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  return <ArchiveClient />;
}
