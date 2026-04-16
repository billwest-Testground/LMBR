/**
 * GET /api/vendors, POST /api/vendors — Vendor CRUD.
 *
 * Purpose:  List active vendors for the tenant and create new ones. Writes
 *           to public.vendors (RLS-scoped by company_id). Vendor tags feed
 *           the routing-agent's shortlist generator and the vendor selector
 *           UI in the buyer dispatch flow.
 * Inputs:   GET: optional { region?, commodity? }. POST: VendorSchema body
 *           minus server-owned fields (id, companyId, timestamps).
 * Outputs:  GET: { vendors: Vendor[] }. POST: { vendor: Vendor }.
 * Agent/API: Supabase.
 * Imports:  @lmbr/types (VendorSchema), @lmbr/lib (getSupabaseAdmin), zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getSupabaseAdmin, toNumber } from '@lmbr/lib';
import { VendorSchema, type Vendor } from '@lmbr/types';

import { getSupabaseRouteHandlerClient } from '../../../lib/supabase/server';

export const runtime = 'nodejs';

interface VendorRow {
  id: string;
  company_id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  vendor_type: 'mill' | 'wholesaler' | 'distributor' | 'retailer';
  commodities: string[];
  regions: string[];
  min_order_mbf: number | string;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function rowToVendor(row: VendorRow): Vendor {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    vendorType: row.vendor_type,
    commodities: row.commodities ?? [],
    regions: row.regions ?? [],
    minOrderMbf: toNumber(row.min_order_mbf),
    active: row.active,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const VendorCreateSchema = VendorSchema.omit({
  id: true,
  companyId: true,
  createdAt: true,
  updatedAt: true,
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const sessionClient = getSupabaseRouteHandlerClient();
    const {
      data: { session },
    } = await sessionClient.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: profile } = await sessionClient
      .from('users')
      .select('id, company_id')
      .eq('id', session.user.id)
      .maybeSingle();
    if (!profile?.company_id) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 403 });
    }

    const url = new URL(req.url);
    const region = url.searchParams.get('region');
    const commodity = url.searchParams.get('commodity');

    const admin = getSupabaseAdmin();
    let query = admin
      .from('vendors')
      .select(
        'id, company_id, name, contact_name, email, phone, vendor_type, commodities, regions, min_order_mbf, active, notes, created_at, updated_at',
      )
      .eq('company_id', profile.company_id)
      .eq('active', true)
      .order('name', { ascending: true });

    if (region) {
      query = query.contains('regions', [region]);
    }
    if (commodity) {
      query = query.contains('commodities', [commodity]);
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const vendors = (data ?? []).map((row) => rowToVendor(row as VendorRow));
    return NextResponse.json({ vendors });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list vendors';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = VendorCreateSchema.safeParse(await req.json());
    if (!body.success) {
      return NextResponse.json(
        { error: body.error.errors[0]?.message ?? 'Invalid vendor body' },
        { status: 400 },
      );
    }

    const sessionClient = getSupabaseRouteHandlerClient();
    const {
      data: { session },
    } = await sessionClient.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: profile } = await sessionClient
      .from('users')
      .select('id, company_id')
      .eq('id', session.user.id)
      .maybeSingle();
    if (!profile?.company_id) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 403 });
    }

    const v = body.data;
    const insert = {
      company_id: profile.company_id,
      name: v.name,
      contact_name: v.contactName ?? null,
      email: v.email ?? null,
      phone: v.phone ?? null,
      vendor_type: v.vendorType,
      commodities: v.commodities,
      regions: v.regions,
      min_order_mbf: v.minOrderMbf,
      active: v.active,
      notes: v.notes ?? null,
    };

    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('vendors')
      .insert(insert)
      .select(
        'id, company_id, name, contact_name, email, phone, vendor_type, commodities, regions, min_order_mbf, active, notes, created_at, updated_at',
      )
      .single();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: 'Insert returned no row' }, { status: 500 });
    }

    return NextResponse.json({ vendor: rowToVendor(data as VendorRow) }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create vendor';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
