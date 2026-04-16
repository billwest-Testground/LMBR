/**
 * loadComparison — shared ComparisonInput loader for the web app.
 *
 * Purpose:  Single implementation of the Supabase snapshot query that feeds
 *           the deterministic comparison-agent. Both the route handler at
 *           /api/compare/[bidId] and the server-rendered
 *           /bids/[bidId]/compare page call this so the two surfaces stay
 *           byte-for-byte consistent and we don't do an HTTP round-trip from
 *           the page back into the route handler.
 *
 *           RLS enforces tenancy — this helper never uses the service-role
 *           client. The caller passes an authenticated Supabase client
 *           (either the RSC client or the route-handler client), and the
 *           loader treats it purely as a read surface. The caller is also
 *           responsible for verifying the user's role (buyer-aligned) before
 *           invoking; the loader itself only validates bid ownership.
 *
 *           Return is a discriminated `LoadComparisonResult` so callers can
 *           translate into HTTP status codes (route handler) or Next.js
 *           notFound()/redirect() calls (server component) without a sprawl
 *           of try/catch.
 *
 * Inputs:   { supabase, bidId (uuid), companyId }.
 * Outputs:  LoadComparisonResult — 'ok' | 'invalid_bid_id' | 'not_found' |
 *           'wrong_company' | 'db_error'.
 * Agent/API: @lmbr/agents comparisonAgent (pure, no I/O).
 * Imports:  @lmbr/agents, @lmbr/types, @supabase/supabase-js, zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import {
  comparisonAgent,
  type ComparisonInput,
  type ComparisonLineInput,
  type ComparisonResult,
  type ComparisonVendor,
  type ComparisonVendorLine,
} from '@lmbr/agents';
import type { VendorBidStatus } from '@lmbr/types';

const BidIdSchema = z.string().uuid();

export interface BidSummary {
  id: string;
  customerName: string;
  jobName: string | null;
  dueDate: string | null;
}

export type LoadComparisonResult =
  | { status: 'ok'; result: ComparisonResult; bid: BidSummary }
  | { status: 'invalid_bid_id' }
  | { status: 'not_found' }
  | { status: 'wrong_company' }
  | { status: 'db_error'; message: string };

export interface LoadComparisonArgs {
  /**
   * Any authenticated Supabase client — either an RSC client or a route-
   * handler client is fine. We intentionally avoid pinning the generated
   * Database type here because neither the RSC client nor the route-handler
   * client is parameterized with it in this codebase.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, 'public', any>;
  bidId: string;
  companyId: string;
}

/**
 * Loads the raw snapshot for a bid under the caller's Supabase session and
 * hands it to comparisonAgent(). Returns a discriminated result so the HTTP
 * layer and the server-component layer can branch cleanly.
 */
export async function loadComparison(
  args: LoadComparisonArgs,
): Promise<LoadComparisonResult> {
  const bidIdParse = BidIdSchema.safeParse(args.bidId);
  if (!bidIdParse.success) {
    return { status: 'invalid_bid_id' };
  }
  const bidId = bidIdParse.data;
  const { supabase, companyId } = args;

  // --- Verify bid + company ownership ---------------------------------------
  const { data: bid, error: bidError } = await supabase
    .from('bids')
    .select('id, company_id, customer_name, job_name, due_date')
    .eq('id', bidId)
    .maybeSingle();
  if (bidError) {
    return { status: 'db_error', message: bidError.message };
  }
  if (!bid) {
    return { status: 'not_found' };
  }
  if (bid.company_id !== companyId) {
    return { status: 'wrong_company' };
  }

  // --- Load line_items for the bid ------------------------------------------
  const { data: lineItemRows, error: lineItemError } = await supabase
    .from('line_items')
    .select(
      'id, species, dimension, grade, length, quantity, unit, building_tag, phase_number, sort_order',
    )
    .eq('bid_id', bidId)
    .order('sort_order', { ascending: true })
    .order('building_tag', { ascending: true })
    .order('id', { ascending: true });
  if (lineItemError) {
    return { status: 'db_error', message: lineItemError.message };
  }

  // --- Load vendor_bids -----------------------------------------------------
  const { data: vendorBidRows, error: vendorBidError } = await supabase
    .from('vendor_bids')
    .select('id, vendor_id, status')
    .eq('bid_id', bidId);
  if (vendorBidError) {
    return { status: 'db_error', message: vendorBidError.message };
  }

  const vendorBids = vendorBidRows ?? [];
  const vendorBidIds = vendorBids.map((vb) => vb.id as string);
  const vendorIds = [...new Set(vendorBids.map((vb) => vb.vendor_id as string))];

  // --- Load vendor display names + vendor_bid_line_items in parallel --------
  const [vendorsResult, vendorLinesResult] = await Promise.all([
    vendorIds.length > 0
      ? supabase.from('vendors').select('id, name').in('id', vendorIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }>, error: null }),
    vendorBidIds.length > 0
      ? supabase
          .from('vendor_bid_line_items')
          .select('id, vendor_bid_id, line_item_id, unit_price, total_price')
          .in('vendor_bid_id', vendorBidIds)
      : Promise.resolve({
          data: [] as Array<{
            id: string;
            vendor_bid_id: string;
            line_item_id: string;
            unit_price: number | null;
            total_price: number | null;
          }>,
          error: null,
        }),
  ]);

  if (vendorsResult.error) {
    return { status: 'db_error', message: vendorsResult.error.message };
  }
  if (vendorLinesResult.error) {
    return { status: 'db_error', message: vendorLinesResult.error.message };
  }

  const vendorsById = new Map(
    (vendorsResult.data ?? []).map((v) => [v.id as string, v.name as string]),
  );
  const vendorBidById = new Map(
    vendorBids.map((vb) => [vb.id as string, vb] as const),
  );

  // --- Assemble ComparisonInput ---------------------------------------------
  const vendors: ComparisonVendor[] = vendorBids.map((vb) => ({
    vendorId: vb.vendor_id as string,
    vendorName: vendorsById.get(vb.vendor_id as string) ?? '(unknown vendor)',
    vendorBidId: vb.id as string,
    status: vb.status as VendorBidStatus,
  }));

  const lines: ComparisonLineInput[] = (lineItemRows ?? []).map((row) => ({
    lineItemId: row.id as string,
    species: row.species as string,
    dimension: row.dimension as string,
    grade: (row.grade as string | null) ?? null,
    length: (row.length as string | null) ?? null,
    quantity: Number(row.quantity),
    unit: row.unit as 'PCS' | 'MBF' | 'MSF',
    buildingTag: (row.building_tag as string | null) ?? null,
    phaseNumber: (row.phase_number as number | null) ?? null,
    sortOrder: Number(row.sort_order ?? 0),
  }));

  const vendorLines: ComparisonVendorLine[] = (vendorLinesResult.data ?? [])
    .map((row) => {
      const vb = vendorBidById.get(row.vendor_bid_id as string);
      if (!vb) return null; // defensive: orphaned row
      return {
        vendorBidLineItemId: row.id as string,
        vendorBidId: row.vendor_bid_id as string,
        vendorId: vb.vendor_id as string,
        lineItemId: row.line_item_id as string,
        unitPrice: row.unit_price === null ? null : Number(row.unit_price),
        totalPrice: row.total_price === null ? null : Number(row.total_price),
      } satisfies ComparisonVendorLine;
    })
    .filter((v): v is ComparisonVendorLine => v !== null);

  const input: ComparisonInput = { bidId, vendors, lines, vendorLines };
  const result = comparisonAgent(input);

  return {
    status: 'ok',
    result,
    bid: {
      id: bid.id as string,
      customerName: bid.customer_name as string,
      jobName: (bid.job_name as string | null) ?? null,
      dueDate: (bid.due_date as string | null) ?? null,
    },
  };
}
