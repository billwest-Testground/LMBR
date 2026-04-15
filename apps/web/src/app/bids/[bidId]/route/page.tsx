/**
 * /bids/[bidId]/route — routing review surface.
 *
 * Purpose:  Destination for the "Proceed to routing" button in the
 *           ingest table. Server component that loads the bid +
 *           line_items + current bid_routings + tenant buyer list, then
 *           hands the data to the client-side RoutingMap. If no
 *           routings exist yet (first visit after ingest), the page
 *           auto-triggers /api/route-bid via a small client stub before
 *           rendering so the trader lands on a populated map.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { notFound, redirect } from 'next/navigation';

import { getSupabaseRSCClient } from '../../../../lib/supabase/server';
import { getSupabaseAdmin } from '@lmbr/lib';
import {
  RoutingMap,
  type RoutingMapBuyerOption,
  type RoutingMapLineItem,
  type RoutingMapRouting,
} from '../../../../components/bids/routing-map';
import { AutoRouteOnMount } from './auto-route-on-mount';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { bidId: string };
}

export default async function BidRoutingPage({ params }: PageProps) {
  const supabase = getSupabaseRSCClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  // Bid (RLS-gated).
  const { data: bid } = await supabase
    .from('bids')
    .select('id, company_id, customer_name, status')
    .eq('id', params.bidId)
    .maybeSingle();
  if (!bid) notFound();

  // Line items (RLS inherits via bid).
  const { data: lineItems } = await supabase
    .from('line_items')
    .select(
      'id, building_tag, species, dimension, grade, length, quantity, unit, board_feet, sort_order',
    )
    .eq('bid_id', bid.id)
    .order('sort_order', { ascending: true });

  const { data: routings } = await supabase
    .from('bid_routings')
    .select('id, buyer_user_id, commodity_group, line_item_ids, status')
    .eq('bid_id', bid.id)
    .order('commodity_group', { ascending: true });

  // Buyer pool for manual assign. We need the admin client here so we
  // can read every buyer in the tenant even if the caller is a pure
  // trader who wouldn't normally see other users' profiles.
  const admin = getSupabaseAdmin();
  const { data: buyerRoles } = await admin
    .from('roles')
    .select('user_id, role_type, users:users!inner(id, full_name)')
    .eq('company_id', bid.company_id)
    .in('role_type', ['buyer', 'trader_buyer']);

  type RoleRow = {
    user_id: string;
    role_type: string;
    users: { id: string; full_name: string } | { id: string; full_name: string }[] | null;
  };

  const buyerOptions: RoutingMapBuyerOption[] = (buyerRoles ?? [])
    .map((r: unknown) => {
      const row = r as RoleRow;
      const user = Array.isArray(row.users) ? row.users[0] : row.users;
      if (!user) return null;
      return {
        userId: row.user_id,
        fullName: user.full_name,
        roleType: row.role_type as 'buyer' | 'trader_buyer',
      };
    })
    .filter((b): b is RoutingMapBuyerOption => b !== null);

  const initialLineItems: RoutingMapLineItem[] = (lineItems ?? []).map((li) => ({
    id: li.id,
    building_tag: li.building_tag,
    species: li.species,
    dimension: li.dimension,
    grade: li.grade,
    length: li.length,
    quantity: Number(li.quantity),
    unit: li.unit,
    board_feet: li.board_feet != null ? Number(li.board_feet) : null,
  }));

  const initialRoutings: RoutingMapRouting[] = (routings ?? []).map((r) => ({
    id: r.id,
    buyer_user_id: r.buyer_user_id,
    commodity_group: r.commodity_group,
    line_item_ids: r.line_item_ids ?? [],
    status: r.status,
  }));

  const needsAutoRoute = initialRoutings.length === 0 && initialLineItems.length > 0;

  return (
    <div className="flex flex-col gap-6">
      {needsAutoRoute && <AutoRouteOnMount bidId={bid.id} />}
      <RoutingMap
        bidId={bid.id}
        customerName={bid.customer_name}
        lineItems={initialLineItems}
        initialRoutings={initialRoutings}
        buyerOptions={buyerOptions}
      />
    </div>
  );
}
