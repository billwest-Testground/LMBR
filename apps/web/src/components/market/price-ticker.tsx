/**
 * PriceTicker — scrolling market price strip.
 *
 * Purpose:  Shows recent cash vs Random Lengths prices across the
 *           distributor's active commodities.
 * Inputs:   { prices: MarketPrice[] }.
 * Outputs:  JSX.
 * Agent/API: /api/market.
 * Imports:  @lmbr/types (MarketPrice).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import type { MarketPrice } from '@lmbr/types';

export function PriceTicker(_props: { prices: MarketPrice[] }) {
  return <div>Not implemented: PriceTicker</div>;
}
