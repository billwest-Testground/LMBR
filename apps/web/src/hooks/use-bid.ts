/**
 * useBid — single-bid data hook.
 *
 * Purpose:  React Query hook that fetches a bid + its line items + vendor
 *           bids from Supabase, with real-time subscription for updates
 *           during the agent pipeline.
 * Inputs:   bidId.
 * Outputs:  { bid, lineItems, vendorBids, isLoading, error }.
 * Agent/API: Supabase realtime.
 * Imports:  @tanstack/react-query, @lmbr/types, @lmbr/lib.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export function useBid(_bidId: string): never {
  throw new Error('Not implemented');
}
