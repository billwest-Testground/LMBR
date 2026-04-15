/**
 * US regions + routing rule stubs.
 *
 * Purpose:  Defines the five US census-style regions LMBR.ai uses to route
 *           customer bids to the appropriate Buyer and to filter vendor
 *           capability. Routing-agent uses `routeBidToRegion` to resolve a
 *           job state into a region and, downstream, a preferred buyer/mill
 *           set.
 * Inputs:   state code (2-letter) → region.
 * Outputs:  US_REGIONS, REGION_BY_STATE, routeBidToRegion (stub).
 * Agent/API: consumed by routing-agent and the /api/route-bid route.
 * Imports:  none.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export type RegionId = 'west' | 'mountain' | 'midwest' | 'south' | 'northeast';

export interface UsRegion {
  id: RegionId;
  name: string;
  states: readonly string[];
}

export const US_REGIONS: readonly UsRegion[] = [
  {
    id: 'west',
    name: 'West',
    states: ['WA', 'OR', 'CA', 'AK', 'HI'],
  },
  {
    id: 'mountain',
    name: 'Mountain',
    states: ['ID', 'MT', 'WY', 'NV', 'UT', 'CO', 'AZ', 'NM'],
  },
  {
    id: 'midwest',
    name: 'Midwest',
    states: ['ND', 'SD', 'NE', 'KS', 'MN', 'IA', 'MO', 'WI', 'IL', 'MI', 'IN', 'OH'],
  },
  {
    id: 'south',
    name: 'South',
    states: ['TX', 'OK', 'AR', 'LA', 'MS', 'AL', 'TN', 'KY', 'GA', 'FL', 'SC', 'NC', 'VA', 'WV'],
  },
  {
    id: 'northeast',
    name: 'Northeast',
    states: ['MD', 'DE', 'DC', 'PA', 'NJ', 'NY', 'CT', 'RI', 'MA', 'VT', 'NH', 'ME'],
  },
];

export const REGION_BY_STATE: Readonly<Record<string, RegionId>> = Object.freeze(
  US_REGIONS.reduce<Record<string, RegionId>>((acc, region) => {
    for (const state of region.states) acc[state] = region.id;
    return acc;
  }, {}),
);

/**
 * Resolve a 2-letter state code to a region id.
 * Implementation stub — routing rules not yet finalized.
 */
export function routeBidToRegion(_stateCode: string): RegionId {
  throw new Error('Not implemented');
}

/**
 * Given a region and commodity, return ordered preferred vendor ids.
 * Implementation stub — policy engine pending.
 */
export function preferredVendorsForRegion(
  _region: RegionId,
  _commodityId: string,
): readonly string[] {
  throw new Error('Not implemented');
}
