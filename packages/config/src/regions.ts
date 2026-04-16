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
 * Shape of a vendor candidate passed into {@link preferredVendorsForRegion}.
 * Matches the rows returned by the `GET /api/vendors` route (Prompt 05,
 * Task 2). Kept local to this package so `@lmbr/config` stays dep-free.
 */
export interface PreferredVendorCandidate {
  id: string;
  name: string;
  vendorType: 'mill' | 'wholesaler' | 'distributor' | 'retailer';
  regions: string[];        // empty = wildcard (serves every region)
  commodities: string[];    // empty = no commodity match possible
  active: boolean;
  minOrderMbf: number;
}

/**
 * Rank order for `vendorType` tie-breaking. Lower = higher priority.
 * Mills sit at the top because they give the best mill-direct pricing
 * on consolidated volume; retailers are last because they're used only
 * as a fallback when no wholesale source is available.
 */
const VENDOR_TYPE_RANK: Readonly<Record<PreferredVendorCandidate['vendorType'], number>> =
  Object.freeze({
    mill: 0,
    wholesaler: 1,
    distributor: 2,
    retailer: 3,
  });

/**
 * Filter + rank vendor candidates for a bid's region/commodity shortlist.
 *
 * Pure function — pre-fetched vendors in, ordered id list out. The DB
 * query lives in the caller (GET /api/vendors returns the shape this
 * function consumes). Ranking favors explicit-region matches over
 * wildcards, then mill > wholesaler > distributor > retailer, then
 * alphabetical by name for stability.
 *
 * @param region      The bid's region, or null if unknown (wildcard).
 * @param commodityId Commodity / species token — matched case-insensitively.
 * @param vendors     Pre-fetched candidate list (e.g. from /api/vendors).
 * @returns           Ordered vendor ids. Empty when no candidates match.
 */
export function preferredVendorsForRegion(
  region: RegionId | null,
  commodityId: string,
  vendors: readonly PreferredVendorCandidate[],
): readonly string[] {
  // Early exits: no vendors, or no meaningful commodity token to match on.
  if (vendors.length === 0) return Object.freeze([]);
  const needle = commodityId?.trim().toLowerCase() ?? '';
  if (!needle) return Object.freeze([]);

  // Step 1: filter. Active, commodity match (case-insensitive), region match
  // (wildcard-aware on both sides: empty vendor.regions is a wildcard, and
  // null `region` means the bid itself has no regional constraint).
  const matched = vendors.filter((v) => {
    if (!v.active) return false;

    const commodityMatch = v.commodities.some(
      (c) => c.trim().toLowerCase() === needle,
    );
    if (!commodityMatch) return false;

    if (region === null) return true;           // null region → accept all
    if (v.regions.length === 0) return true;    // wildcard vendor
    return v.regions.includes(region);
  });

  // Step 2: sort. Invariant — the comparator enforces this ordering:
  //   (a) Vendors whose `regions[]` explicitly includes `region` rank
  //       ABOVE wildcard-region vendors. When `region` is null, no vendor
  //       can be "explicit" so all tie on this axis and we fall through.
  //   (b) Within the same explicit/wildcard bucket, mills (0) sort before
  //       wholesalers (1), distributors (2), retailers (3).
  //   (c) Final tie-break: case-insensitive alphabetical by `name`, which
  //       gives deterministic, test-friendly output across runs.
  const sorted = [...matched].sort((a, b) => {
    // (a) explicit-region priority
    const aExplicit = region !== null && a.regions.includes(region) ? 0 : 1;
    const bExplicit = region !== null && b.regions.includes(region) ? 0 : 1;
    if (aExplicit !== bExplicit) return aExplicit - bExplicit;

    // (b) vendor type rank (mill before wholesaler before distributor ...)
    const aRank = VENDOR_TYPE_RANK[a.vendorType];
    const bRank = VENDOR_TYPE_RANK[b.vendorType];
    if (aRank !== bRank) return aRank - bRank;

    // (c) alphabetical stability
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });

  // Step 3: dedupe by id defensively (preserve first occurrence).
  // Input shouldn't contain duplicates but a caller bug here could
  // silently ship duplicate dispatch rows, so we guard explicitly.
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const v of sorted) {
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    ids.push(v.id);
  }

  return Object.freeze(ids);
}
