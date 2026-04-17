/**
 * POST /api/market/futures/refresh — CME lumber futures refresh cron target.
 *
 * Purpose:  The 15-minute cron tick that keeps public.market_futures
 *           fresh. Calls refreshLumberFutures from @lmbr/lib/market-data,
 *           which fetches the current Twelve Data quote and upserts on
 *           (symbol, contract_month). Prompt 11 wires the actual cron
 *           schedule; this route exists now so the refresh path can be
 *           exercised end-to-end without any scheduler infrastructure.
 *
 *           Auth: shared-secret Bearer token via MARKET_REFRESH_SECRET.
 *           Same pattern as /api/webhook/outlook/renew — constant-time
 *           compare defeats timing-side-channel leaks of the secret.
 *
 *           Failure policy: upstream Twelve Data hiccups (rate limit,
 *           DNS blip, malformed response) return 200 with a summary
 *           that reports success=false + the reason. A 5xx from this
 *           route would make the cron provider retry the whole tick,
 *           which amplifies instead of fixes — the dashboard's
 *           "last fetched at" label is the right place to surface
 *           stale data, not an operational alert.
 *
 *           The only path that returns a non-2xx is the auth gate —
 *           bad / missing bearer → 401 with a canonical body so a
 *           caller cannot distinguish "missing env var" from "bad
 *           token presented" (both are misconfigurations that the
 *           cron provider should surface to a human).
 *
 * Inputs:   Header: `Authorization: Bearer ${MARKET_REFRESH_SECRET}`.
 * Outputs:  200 { success, quote?, error? } or 401 { error }.
 * Agent/API: @lmbr/lib refreshLumberFutures (wraps Twelve Data +
 *            market_futures upsert). No direct network or DB calls
 *            from this route — they're encapsulated behind the lib.
 * Imports:  next/server, node:crypto, @lmbr/lib.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { refreshLumberFutures } from '@lmbr/lib';

export const runtime = 'nodejs';
// The upstream fetch is capped at 8s inside the lib; give the route
// headroom so a transient provider slowdown doesn't truncate the
// response write.
export const maxDuration = 30;

function bearerMatches(header: string | null): boolean {
  const secret = process.env.MARKET_REFRESH_SECRET;
  if (!secret || secret.length === 0) return false;
  if (typeof header !== 'string' || header.length === 0) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !match[1]) return false;
  const presented = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!bearerMatches(req.headers.get('authorization'))) {
    return unauthorized();
  }

  const result = await refreshLumberFutures();
  if (!result.ok) {
    console.warn(
      `LMBR.ai market-futures refresh: ${result.error}${result.status ? ` (status=${result.status})` : ''}.`,
    );
    return NextResponse.json({
      success: false,
      error: result.error,
      ...(result.status !== undefined ? { status: result.status } : {}),
    });
  }

  return NextResponse.json({
    success: true,
    quote: {
      symbol: result.quote.symbol,
      contractMonth: result.quote.contractMonth,
      lastPrice: result.quote.lastPrice,
      priceChange: result.quote.priceChange,
      priceChangePct: result.quote.priceChangePct,
      volume: result.quote.volume,
      fetchedAt: result.quote.fetchedAt,
    },
  });
}
