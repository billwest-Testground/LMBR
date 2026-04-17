/**
 * POST /api/market/aggregate — Daily Cash Index aggregation cron target.
 *
 * Purpose:  The once-per-day cron tick that rolls up every company's
 *           vendor_bid_line_items for a given sample_date into the
 *           anonymized public.market_price_snapshots table. Calls
 *           aggregateMarketSnapshots from @lmbr/agents/market-agent,
 *           which enforces the 3-buyer floor, computes distribution
 *           stats, and upserts with ON CONFLICT DO NOTHING so re-runs
 *           are no-ops. Prompt 11 wires the actual schedule; this
 *           route exists now so the aggregation path can be exercised
 *           on demand during development.
 *
 *           Auth: shared-secret Bearer token via MARKET_AGGREGATE_SECRET.
 *           Same constant-time compare pattern as
 *           /api/webhook/outlook/renew — a timing-side-channel can't
 *           probe the secret one character at a time.
 *
 *           Failure policy: every non-auth failure returns 200 with
 *           { success: false, error }. Cron providers retry on 4xx /
 *           5xx, which amplifies instead of fixes — a transient DB
 *           blip would cause a retry storm that burns the same budget
 *           as the aggregation itself. The only non-2xx response
 *           comes from the auth gate, and that's a canonical
 *           "Unauthorized" body that hides whether the env var is
 *           even set (misconfig either way).
 *
 *           slicesBelowFloor is logged at info level because it's a
 *           useful readiness signal — "this many slices have data
 *           but aren't writable yet because we need more tenants."
 *           When the number reaches zero / stabilizes, the Cash
 *           Index has matured enough to be the public signal.
 *
 * Inputs:   Header: `Authorization: Bearer ${MARKET_AGGREGATE_SECRET}`.
 *           Body (optional): { sampleDate?: 'YYYY-MM-DD', region?: string }.
 * Outputs:  200 { success, sampleDate, slicesWritten, slicesBelowFloor,
 *                 durationMs } on success, or 200 { success: false,
 *                 error, sampleDate?, durationMs } on aggregation
 *                 failure. 401 { error: 'Unauthorized' } on auth gate.
 * Agent/API: @lmbr/agents aggregateMarketSnapshots — no direct DB from
 *            this route; all the heavy lifting lives in market-agent.
 * Imports:  next/server, node:crypto, zod, @lmbr/agents.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { aggregateMarketSnapshots } from '@lmbr/agents';

export const runtime = 'nodejs';
// Aggregation reads every vendor_bid_line_items row on sampleDate —
// cross-tenant, unbounded. 60s is generous for today's volumes and
// leaves headroom before the platform matures.
export const maxDuration = 60;

const BodySchema = z
  .object({
    sampleDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'sampleDate must be YYYY-MM-DD')
      .optional(),
    region: z.string().min(1).max(40).optional(),
  })
  .strict();

function unauthorized(): NextResponse {
  // Canonical response so a caller cannot distinguish "missing env"
  // from "bad token presented". Both are misconfigurations that the
  // cron provider should surface to a human, not retry against.
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

function bearerMatches(header: string | null): boolean {
  const secret = process.env.MARKET_AGGREGATE_SECRET;
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
  if (!bearerMatches(req.headers.get('authorization'))) {
    return unauthorized();
  }

  // Parse body tolerantly — empty body is fine (defaults to today UTC,
  // all regions). An invalid JSON body returns 200 with success=false
  // rather than 400 so cron doesn't retry.
  let parsed: z.infer<typeof BodySchema> = {};
  try {
    const rawText = await req.text();
    if (rawText.trim().length > 0) {
      const parsedJson: unknown = JSON.parse(rawText);
      const result = BodySchema.safeParse(parsedJson);
      if (!result.success) {
        return NextResponse.json({
          success: false,
          error: result.error.errors[0]?.message ?? 'Invalid body',
          durationMs: 0,
        });
      }
      parsed = result.data;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      success: false,
      error: `Body parse failed: ${message}`,
      durationMs: 0,
    });
  }

  const started = Date.now();
  try {
    // aggregateMarketSnapshots is type-narrow on optional fields under
    // exactOptionalPropertyTypes: don't pass `undefined` explicitly.
    const args: { sampleDate?: string; region?: string } = {};
    if (parsed.sampleDate) args.sampleDate = parsed.sampleDate;
    if (parsed.region) args.region = parsed.region;

    const result = await aggregateMarketSnapshots(args);
    const durationMs = Date.now() - started;

    // slicesBelowFloor is the readiness signal — log it at info level
    // (console.log) so an ops dashboard tailing the logs can plot the
    // curve as the platform matures. 0 means every slice with data
    // cleared the 3-buyer floor.
    console.log(
      `[market.aggregate] sampleDate=${result.sampleDate} slicesWritten=${result.slicesWritten} slicesBelowFloor=${result.slicesBelowFloor} scanned=${result.scanned} durationMs=${durationMs}`,
    );

    return NextResponse.json({
      success: true,
      sampleDate: result.sampleDate,
      slicesWritten: result.slicesWritten,
      slicesBelowFloor: result.slicesBelowFloor,
      durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`LMBR.ai market.aggregate: ${message} (durationMs=${durationMs}).`);
    return NextResponse.json({
      success: false,
      error: message,
      ...(parsed.sampleDate ? { sampleDate: parsed.sampleDate } : {}),
      durationMs,
    });
  }
}
