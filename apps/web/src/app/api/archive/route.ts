/**
 * GET /api/archive — Archived bids index for the /archive page.
 *
 * Purpose:  Feeds the Archived Bids tab on /archive with enough per-row
 *           detail that the table renders in one round trip:
 *             - bid core fields (id, customer, job, status, archived_at)
 *             - archived_by user's display_name (so the "Archived By"
 *               column reads "Jane Doe", not a uuid)
 *             - total_bf — sum of the bid's line_items.board_feet
 *             - repeat_count — how many archived bids share this
 *               bid's (customer_name, job_address). Drives the
 *               "Bid multiple times" filter in Step 4.
 *
 *           Session-authenticated. RLS on public.bids already scopes
 *           visibility per role (pure traders see their own; buyer /
 *           trader_buyer / manager / owner see all tenant bids). The
 *           route doesn't add another role gate — read access mirrors
 *           what RLS grants, which is the existing contract.
 *
 *           Optional filters:
 *             search — ilike OR against job_name / customer_name.
 *             fromDate / toDate — archived_at window (ISO 8601 strings
 *               or YYYY-MM-DD; stored as timestamptz on the DB side).
 *
 *           Aggregation strategy: Supabase's PostgREST embedded join
 *           gives us the users row per archived_by and the per-bid
 *           line_items.board_feet array in one query. total_bf and
 *           repeat_count are computed in TypeScript so the SQL stays
 *           simple and the logic stays testable.
 *
 * Inputs:   Query params: search?, fromDate?, toDate?.
 * Outputs:  200 { bids: ArchiveBid[], total: number }.
 *           401 not authenticated.
 *           500 DB error.
 * Agent/API: Supabase session client (RLS-scoped).
 * Imports:  next/server, ../../../lib/supabase/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getSupabaseRouteHandlerClient } from '../../../lib/supabase/server';

export const runtime = 'nodejs';

export interface ArchiveBid {
  id: string;
  jobName: string | null;
  customerName: string;
  jobAddress: string | null;
  status: string;
  archivedAt: string;
  archivedByUserId: string | null;
  archivedByDisplayName: string | null;
  totalBoardFeet: number;
  repeatCount: number;
}

interface ArchiveRow {
  id: string;
  job_name: string | null;
  customer_name: string;
  job_address: string | null;
  status: string;
  archived_at: string;
  archived_by: string | null;
  archived_user: { id: string; full_name: string | null; email: string } | null;
  line_items: Array<{ board_feet: number | string | null }> | null;
}

function toFiniteNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function repeatKey(row: Pick<ArchiveRow, 'customer_name' | 'job_address'>): string {
  return `${row.customer_name}|${row.job_address ?? ''}`;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const supabase = getSupabaseRouteHandlerClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const url = new URL(req.url);
    const search = url.searchParams.get('search')?.trim() ?? '';
    const fromDate = url.searchParams.get('fromDate')?.trim() ?? '';
    const toDate = url.searchParams.get('toDate')?.trim() ?? '';

    // The nested select pulls the archived_by user row and the bid's
    // line_items.board_feet column in one round trip. Supabase uses
    // `users!archived_by(...)` syntax to disambiguate the FK column
    // when multiple relationships to users exist (created_by,
    // assigned_trader_id, archived_by all point at users).
    const selectSpec =
      'id, job_name, customer_name, job_address, status, archived_at, archived_by,' +
      ' archived_user:users!archived_by(id, full_name, email),' +
      ' line_items(board_feet)';

    let query = supabase
      .from('bids')
      .select(selectSpec)
      .not('archived_at', 'is', null)
      .order('archived_at', { ascending: false });

    if (search.length > 0) {
      // Escape commas/parens in search to keep PostgREST's or() parser
      // from treating them as syntax. Also clamp length.
      const safe = search.slice(0, 120).replace(/[(),]/g, ' ');
      query = query.or(
        `job_name.ilike.%${safe}%,customer_name.ilike.%${safe}%`,
      );
    }
    if (fromDate.length > 0) {
      query = query.gte('archived_at', fromDate);
    }
    if (toDate.length > 0) {
      query = query.lte('archived_at', toDate);
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const rows = (data ?? []) as unknown as ArchiveRow[];

    // Compute repeat_count across THIS response set. Same (customer,
    // address) pair counted once per row — i.e. if three bids share
    // "Acme / 100 Main", each of those three rows gets repeatCount=3.
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = repeatKey(row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const bids: ArchiveBid[] = rows.map((row) => {
      const totalBf = (row.line_items ?? []).reduce(
        (sum, li) => sum + toFiniteNumber(li.board_feet),
        0,
      );
      const archivedUser = row.archived_user;
      const displayName = archivedUser
        ? (archivedUser.full_name ?? archivedUser.email)
        : null;
      return {
        id: row.id,
        jobName: row.job_name,
        customerName: row.customer_name,
        jobAddress: row.job_address,
        status: row.status,
        archivedAt: row.archived_at,
        archivedByUserId: row.archived_by,
        archivedByDisplayName: displayName,
        totalBoardFeet: totalBf,
        repeatCount: counts.get(repeatKey(row)) ?? 1,
      };
    });

    return NextResponse.json({ bids, total: bids.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Archive load failed';
    console.warn(`LMBR.ai archive: ${message}.`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
