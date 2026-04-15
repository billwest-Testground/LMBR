/**
 * GET /api/vendors, POST /api/vendors — Vendor CRUD.
 *
 * Purpose:  List vendors for the tenant and create new ones. Writes to
 *           public.vendors (RLS-scoped by company_id). Vendor tags feed
 *           the routing-agent's shortlist generator.
 * Inputs:   GET: optional { region, commodity }. POST: VendorSchema body.
 * Outputs:  GET: { vendors[] }. POST: { vendor }.
 * Agent/API: Supabase.
 * Imports:  @lmbr/types (VendorSchema), @lmbr/lib.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

export async function GET(_req: NextRequest): Promise<NextResponse> {
  throw new Error('Not implemented');
}

export async function POST(_req: NextRequest): Promise<NextResponse> {
  throw new Error('Not implemented');
}
