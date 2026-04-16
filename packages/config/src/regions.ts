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
 * Full state name → 2-letter abbreviation. Used by routeBidToRegion to
 * accept both "California" and "CA" as input.
 */
const STATE_NAME_TO_ABBR: Readonly<Record<string, string>> = Object.freeze({
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'district of columbia': 'DC', 'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI',
  'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA',
  'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME',
  'maryland': 'MD', 'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN',
  'mississippi': 'MS', 'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE',
  'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH',
  'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX',
  'utah': 'UT', 'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA',
  'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY',
});

/**
 * Resolve a state identifier to a region id. Accepts 2-letter abbreviations
 * (CA, ca) and full state names (California). Returns null for unknown input
 * rather than throwing — the routing agent treats null region as "no region
 * constraint" and falls back to species-only matching.
 */
export function routeBidToRegion(stateCode: string | null | undefined): string | null {
  if (!stateCode) return null;
  const trimmed = stateCode.trim();
  if (!trimmed) return null;

  // Try as 2-letter abbreviation first (most common path).
  const upper = trimmed.toUpperCase();
  if (upper in REGION_BY_STATE) return REGION_BY_STATE[upper] ?? null;

  // Try as full state name.
  const lower = trimmed.toLowerCase();
  const abbr = STATE_NAME_TO_ABBR[lower];
  if (abbr && abbr in REGION_BY_STATE) return REGION_BY_STATE[abbr] ?? null;

  return null;
}

/**
 * Given a region and commodity, return ordered preferred vendor ids.
 * // TODO: Prompt 05 — vendor dispatch will populate this
 */
export function preferredVendorsForRegion(
  _region: RegionId,
  _commodityId: string,
): readonly string[] {
  return [];
}
