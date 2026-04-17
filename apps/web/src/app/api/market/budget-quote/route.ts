/**
 * POST /api/market/budget-quote — Ephemeral market-rate estimate.
 *
 * Purpose:  Internal tool for a trader who needs a ballpark sell
 *           number before the vendor cycle runs. Pulls the bid's
 *           non-consolidated line items, maps them to market-agent
 *           lookup inputs, calls generateBudgetQuote, and returns the
 *           resulting BudgetQuote with the mandatory "not a vendor
 *           quote" disclaimer.
 *
 *           Ephemeral by design — the result is NEVER persisted. The
 *           trader uses it to anchor internal expectations and to
 *           decide whether to chase the full vendor cycle at all.
 *           Calling it a "quote" in any user-facing surface is a
 *           product violation (see CLAUDE.md / market-agent.ts file
 *           header). This route's response always includes the
 *           `warning` field to force the caller to handle that
 *           terminology contract.
 *
 *           Role gate: trader / trader_buyer / manager / owner.
 *           Buyer-only is excluded — budget estimates are an upstream
 *           trader tool. Buyers deal in vendor-pricing selection, not
 *           pre-vendor ballparks.
 *
 * Inputs:   Body: { bidId: uuid, marginPct: number, region?: string }.
 * Outputs:  200 { bidId, budget: BudgetQuote, generatedAt, warning }.
 *           400 bad body / bid not in pricing-compatible state.
 *           401 not authenticated.
 *           403 wrong role / wrong tenant.
 *           404 bid not found.
 * Agent/API: @lmbr/agents generateBudgetQuote (pure TS + one read of
 *            market_price_snapshots). Never writes.
 * Imports:  next/server, zod, @lmbr/agents, @lmbr/types,
 *           ../../../../lib/supabase/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  generateBudgetQuote,
  type BudgetQuoteLineInput,
} from '@lmbr/agents';
import type { MarketSnapshotUnit } from '@lmbr/types';

import { getSupabaseRouteHandlerClient } from '../../../../lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

const BUDGET_QUOTE_ROLES = new Set([
  'trader',
  'trader_buyer',
  'manager',
  'owner',
]);

const BUDGET_QUOTE_WARNING =
  'This is a market-rate estimate only. Not a vendor quote. Prices will vary.';

const BodySchema = z.object({
  bidId: z.string().uuid(),
  marginPct: z
    .number()
    .refine((n) => Number.isFinite(n), { message: 'marginPct must be finite' }),
  region: z.string().min(1).max(40).optional(),
});

interface BidRow {
  id: string;
  company_id: string;
  customer_name: string | null;
  job_region: string | null;
}

interface LineItemRow {
  id: string;
  species: string;
  dimension: string | null;
  grade: string | null;
  unit: string;
  quantity: number | string;
  board_feet: number | string | null;
}

function narrowUnit(raw: string | null | undefined): MarketSnapshotUnit | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'mbf') return 'mbf';
  if (lower === 'msf') return 'msf';
  if (lower === 'piece' || lower === 'pcs') return 'piece';
  return null;
}

function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0]?.message ?? 'Invalid body' },
        { status: 400 },
      );
    }
    const { bidId, marginPct, region: regionOverride } = parsed.data;

    // --- Session + role gate -------------------------------------------
    const supabase = getSupabaseRouteHandlerClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const [profileResult, rolesResult] = await Promise.all([
      supabase
        .from('users')
        .select('id, company_id')
        .eq('id', session.user.id)
        .maybeSingle(),
      supabase.from('roles').select('role_type').eq('user_id', session.user.id),
    ]);
    if (profileResult.error) {
      return NextResponse.json(
        { error: profileResult.error.message },
        { status: 500 },
      );
    }
    const profile = profileResult.data;
    if (!profile?.company_id) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 403 });
    }
    const roles = (rolesResult.data ?? []).map((r) => r.role_type as string);
    if (!roles.some((r) => BUDGET_QUOTE_ROLES.has(r))) {
      return NextResponse.json(
        {
          error:
            'Budget estimates require a trader, trader_buyer, manager, or owner role.',
        },
        { status: 403 },
      );
    }

    // --- Load bid (RLS-scoped — other tenants return no row) -----------
    const { data: bidData, error: bidError } = await supabase
      .from('bids')
      .select('id, company_id, customer_name, job_region')
      .eq('id', bidId)
      .maybeSingle();
    if (bidError) {
      return NextResponse.json({ error: bidError.message }, { status: 500 });
    }
    const bid = bidData as BidRow | null;
    if (!bid) {
      return NextResponse.json({ error: 'Bid not found' }, { status: 404 });
    }
    if (bid.company_id !== profile.company_id) {
      return NextResponse.json(
        { error: 'Bid belongs to a different company' },
        { status: 403 },
      );
    }

    // --- Load non-consolidated line items for the bid ------------------
    // Non-consolidated = the original ingested rows, one per source
    // line. For a hybrid-mode bid the consolidated rows are a separate
    // vendor-facing projection; the budget estimate is a buyer-facing
    // number so we price the ORIGINAL lines.
    const { data: liData, error: liError } = await supabase
      .from('line_items')
      .select('id, species, dimension, grade, unit, quantity, board_feet')
      .eq('bid_id', bid.id)
      .eq('company_id', profile.company_id)
      .eq('is_consolidated', false)
      .order('sort_order', { ascending: true });
    if (liError) {
      return NextResponse.json({ error: liError.message }, { status: 500 });
    }
    const lineRows = (liData ?? []) as LineItemRow[];
    if (lineRows.length === 0) {
      return NextResponse.json(
        { error: 'Bid has no priceable line items yet.' },
        { status: 400 },
      );
    }

    // Map to the market-agent input shape. Rows with an unknown unit
    // can't be priced against the Cash Index — drop them loudly.
    const lineInputs: BudgetQuoteLineInput[] = [];
    const skippedForBadUnit: string[] = [];
    for (const row of lineRows) {
      const unit = narrowUnit(row.unit);
      if (!unit) {
        skippedForBadUnit.push(row.id);
        continue;
      }
      const quantity = toNumber(row.quantity);
      if (!(quantity > 0)) continue;
      const input: BudgetQuoteLineInput = {
        commodityId: row.id,
        species: row.species,
        dimension: row.dimension,
        grade: row.grade,
        unit,
        quantity,
      };
      const bf = toNumber(row.board_feet);
      if (bf > 0) input.boardFeet = bf;
      lineInputs.push(input);
    }

    if (lineInputs.length === 0) {
      return NextResponse.json(
        { error: 'No priceable line items after unit normalization.' },
        { status: 400 },
      );
    }

    // --- Region resolution ---------------------------------------------
    // Query param override wins over the bid's stored region. Null
    // means "cascade through any region" at the market-agent level.
    const region = regionOverride ?? bid.job_region ?? null;

    // --- Generate the estimate -----------------------------------------
    const budget = await generateBudgetQuote({
      companyId: profile.company_id,
      customerName: bid.customer_name ?? 'Customer',
      region,
      lines: lineInputs,
      marginPct,
    });

    const response: Record<string, unknown> = {
      bidId: bid.id,
      budget,
      generatedAt: budget.generatedAt,
      warning: BUDGET_QUOTE_WARNING,
    };
    if (skippedForBadUnit.length > 0) {
      response.skippedLineItemIds = skippedForBadUnit;
    }
    return NextResponse.json(response);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Budget estimate failed';
    console.warn(`LMBR.ai budget-quote: ${message}.`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
