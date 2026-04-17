/**
 * POST /api/webhook/outlook/renew — Graph subscription renewal cron target.
 *
 * Purpose:  Graph change-notification subscriptions expire after ~3 days.
 *           A subscription that lapses silently stops delivering change
 *           notifications — the mailbox is still being watched client-
 *           side, but our webhook (apps/web/src/app/api/webhook/outlook)
 *           never fires again until someone notices the dashboard is
 *           quiet. To prevent that, every subscription within 48h of
 *           expiry gets PATCHed forward by renewAllExpiringSoon() in
 *           packages/lib/src/outlook.ts. This endpoint is the HTTP
 *           entry point a cron job hits on a schedule (Prompt 11 wires
 *           the schedule; this route exists now so the renewal code
 *           can be exercised independently).
 *
 *           Auth: shared-secret Bearer token via OUTLOOK_RENEWAL_SECRET.
 *           The cron job knows the secret; a drive-by attacker does
 *           not. Compared with constant-time equality so a timing-side
 *           channel cannot probe the secret character-by-character.
 *
 *           Behavior: the underlying library call never throws — every
 *           per-subscription failure is captured in the `failed[]`
 *           array. We return 200 with a summary in every case except
 *           the auth gate; a non-200 would have the cron provider
 *           mark the run as failed and retry, which is the opposite
 *           of what we want for "one subscription errored out of ten".
 *
 *           On a 404 from Graph, renewSubscription recreates the
 *           subscription from the stored resource path — the
 *           `recreated` counter in the response surfaces that distinct
 *           outcome so ops can tell "renew succeeded" from "gone and
 *           we rebuilt it".
 *
 * Inputs:   Header: `Authorization: Bearer ${OUTLOOK_RENEWAL_SECRET}`.
 * Outputs:  200 { scanned, renewed, recreated, failed, errors } or
 *           401 { error: 'Unauthorized' }.
 * Agent/API: @lmbr/lib renewAllExpiringSoon (no direct Graph calls
 *            from this route — they're encapsulated behind the lib).
 * Imports:  next/server, node:crypto, @lmbr/lib.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { renewAllExpiringSoon } from '@lmbr/lib';

export const runtime = 'nodejs';
// Bulk renewal is sequential across all expiring subscriptions. 60s is
// plenty for tenants below a few hundred active subs; tune up when a
// single tenant crosses that threshold.
export const maxDuration = 60;

function unauthorized(): NextResponse {
  // Single canonical response so a caller cannot distinguish "missing
  // secret in env" from "bad token presented". Both indicate misconfig.
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

function bearerMatches(header: string | null): boolean {
  const secret = process.env.OUTLOOK_RENEWAL_SECRET;
  if (!secret || secret.length === 0) return false;
  if (typeof header !== 'string' || header.length === 0) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !match[1]) return false;
  const presented = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get('authorization');
  if (!bearerMatches(authHeader)) {
    return unauthorized();
  }

  try {
    const result = await renewAllExpiringSoon();
    return NextResponse.json({
      scanned: result.scanned,
      renewed: result.renewed,
      recreated: result.recreated,
      failed: result.failed.length,
      errors: result.failed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Renewal failed';
    console.warn(`LMBR.ai outlook renew: unexpected error: ${message}.`);
    return NextResponse.json({ error: 'Renewal failed' }, { status: 500 });
  }
}
