/**
 * Routing agent — commodity + geography → buyer assignment.
 *
 * Purpose:  After a bid is ingested and QA'd, the trader presses
 *           "Proceed to routing". The routing agent decides which
 *           commodity buyer (or trader_buyer) should own each line
 *           item based on:
 *             1. The commodity_assignments table — which buyer handles
 *                which species in which regions.
 *             2. The bid's job_region — if the assignment declares
 *                specific regions, the bid must land in one.
 *             3. Role type — trader_buyer roles short-circuit to a
 *                self-route regardless of assignments, so solo
 *                operators never forward to themselves.
 *
 *           The routing logic is deterministic and runs in pure
 *           TypeScript (no Claude call) — matching and region filter
 *           are rule-based and need to be testable, auditable, and
 *           instant. Future soft-routing (tie-breaking when multiple
 *           buyers match, load balancing, fairness) can layer an LLM
 *           pass on top of this deterministic seed.
 *
 *           Output shape: an array of RoutingEntry, each carrying the
 *           assigned buyer, a commodity_group label for UI grouping,
 *           and the line_item_ids that buyer should own. Line items
 *           with no matching buyer land in unroutedLineItemIds.
 *
 * Inputs:   pre-fetched bid + line items + submitting user roles +
 *           buyer candidates (this keeps the agent pure and testable —
 *           the API route does all DB I/O).
 * Outputs:  RoutingResult — entries, unroutedLineItemIds, strategy.
 * Agent/API: none — pure TypeScript.
 * Imports:  @lmbr/lib (normalizeSpecies).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { normalizeSpecies } from '@lmbr/lib';

// -----------------------------------------------------------------------------
// Input / output types
// -----------------------------------------------------------------------------

export type RoutingRoleType =
  | 'trader'
  | 'buyer'
  | 'trader_buyer'
  | 'manager'
  | 'owner';

export interface RoutingBidInput {
  id: string;
  jobRegion: string | null;
}

export interface RoutingLineItemInput {
  id: string;
  species: string;
}

export interface RoutingSubmittingUser {
  id: string;
  fullName: string;
  roles: RoutingRoleType[];
}

export interface RoutingBuyerCandidate {
  userId: string;
  fullName: string;
  roleType: 'buyer' | 'trader_buyer';
  assignments: Array<{
    commodityType: string;
    regions: string[];
  }>;
}

export interface RoutingInput {
  bid: RoutingBidInput;
  lineItems: RoutingLineItemInput[];
  submittingUser: RoutingSubmittingUser;
  buyerCandidates: RoutingBuyerCandidate[];
}

export interface RoutingEntry {
  buyerUserId: string;
  buyerName: string;
  commodityGroup: string;
  lineItemIds: string[];
  reason: string;
}

export type RoutingStrategy =
  | 'self' // trader_buyer short-circuit
  | 'single_buyer' // all items land on one buyer
  | 'split' // multi-buyer routing
  | 'unrouted'; // nothing matched — fully manual

export interface RoutingResult {
  bidId: string;
  entries: RoutingEntry[];
  unroutedLineItemIds: string[];
  strategy: RoutingStrategy;
  summary: {
    totalLineItems: number;
    routedLineItems: number;
    unroutedLineItems: number;
    buyersAssigned: number;
  };
}

// -----------------------------------------------------------------------------
// Commodity grouping — for UI display + persistence
// -----------------------------------------------------------------------------

/**
 * Map a normalized species token to a coarser commodity group label that
 * we surface in the UI and persist on bid_routings.commodity_group. The
 * actual MATCHING still happens species-by-species against
 * commodity_assignments.commodity_type; this grouping only affects how
 * we aggregate routed line items into fewer, denser routing cards.
 */
export function commodityGroupFor(species: string): string {
  const s = normalizeSpecies(species);
  if (['SPF', 'DF', 'HF', 'SYP'].includes(s)) return 'Dimensional';
  if (s === 'Cedar') return 'Cedar';
  if (s === 'LVL') return 'Engineered';
  if (s === 'OSB' || s === 'Plywood') return 'Panels';
  if (s === 'Treated') return 'Treated';
  return s || 'Other';
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

export function routingAgent(input: RoutingInput): RoutingResult {
  const { bid, lineItems, submittingUser, buyerCandidates } = input;

  // --- Trader-buyer self-route short-circuit --------------------------------
  if (submittingUser.roles.includes('trader_buyer')) {
    if (lineItems.length === 0) {
      return {
        bidId: bid.id,
        entries: [],
        unroutedLineItemIds: [],
        strategy: 'unrouted',
        summary: {
          totalLineItems: 0,
          routedLineItems: 0,
          unroutedLineItems: 0,
          buyersAssigned: 0,
        },
      };
    }
    return {
      bidId: bid.id,
      entries: [
        {
          buyerUserId: submittingUser.id,
          buyerName: submittingUser.fullName,
          commodityGroup: 'All',
          lineItemIds: lineItems.map((li) => li.id),
          reason: 'Trader-buyer unified self-route',
        },
      ],
      unroutedLineItemIds: [],
      strategy: 'self',
      summary: {
        totalLineItems: lineItems.length,
        routedLineItems: lineItems.length,
        unroutedLineItems: 0,
        buyersAssigned: 1,
      },
    };
  }

  // --- Match each line item to the first matching buyer --------------------
  // bucket: buyer_user_id → commodity_group → line_item_ids
  const bucket = new Map<
    string,
    Map<string, { buyerName: string; lineItemIds: string[] }>
  >();
  const unroutedLineItemIds: string[] = [];

  const bidRegion = (bid.jobRegion ?? '').trim();

  for (const lineItem of lineItems) {
    const species = normalizeSpecies(lineItem.species);
    if (!species) {
      unroutedLineItemIds.push(lineItem.id);
      continue;
    }
    const group = commodityGroupFor(species);

    const match = findMatchingBuyer(species, bidRegion, buyerCandidates);
    if (!match) {
      unroutedLineItemIds.push(lineItem.id);
      continue;
    }

    const buyerBucket = bucket.get(match.userId) ?? new Map();
    const groupBucket = buyerBucket.get(group) ?? {
      buyerName: match.fullName,
      lineItemIds: [] as string[],
    };
    groupBucket.lineItemIds.push(lineItem.id);
    buyerBucket.set(group, groupBucket);
    bucket.set(match.userId, buyerBucket);
  }

  // --- Flatten the bucket into RoutingEntry list ---------------------------
  const entries: RoutingEntry[] = [];
  bucket.forEach((groups, buyerUserId) => {
    groups.forEach((payload, commodityGroup) => {
      entries.push({
        buyerUserId,
        buyerName: payload.buyerName,
        commodityGroup,
        lineItemIds: payload.lineItemIds,
        reason: `Commodity assignment match${bidRegion ? ` · region "${bidRegion}"` : ''}`,
      });
    });
  });

  // --- Strategy label -------------------------------------------------------
  const buyersAssigned = bucket.size;
  const totalRouted = entries.reduce((s, e) => s + e.lineItemIds.length, 0);

  let strategy: RoutingStrategy;
  if (buyersAssigned === 0) {
    strategy = 'unrouted';
  } else if (buyersAssigned === 1) {
    strategy = 'single_buyer';
  } else {
    strategy = 'split';
  }

  return {
    bidId: bid.id,
    entries,
    unroutedLineItemIds,
    strategy,
    summary: {
      totalLineItems: lineItems.length,
      routedLineItems: totalRouted,
      unroutedLineItems: unroutedLineItemIds.length,
      buyersAssigned,
    },
  };
}

// -----------------------------------------------------------------------------
// Matching
// -----------------------------------------------------------------------------

function findMatchingBuyer(
  species: string,
  bidRegion: string,
  candidates: RoutingBuyerCandidate[],
): { userId: string; fullName: string } | null {
  const normalizedSpecies = normalizeSpecies(species).toLowerCase();

  // Pass 1: exact species + region match.
  for (const candidate of candidates) {
    for (const assignment of candidate.assignments) {
      const commodityMatch =
        normalizeSpecies(assignment.commodityType).toLowerCase() ===
        normalizedSpecies;
      if (!commodityMatch) continue;

      const regionsEmpty = assignment.regions.length === 0;
      const regionMatch =
        regionsEmpty || (bidRegion && assignment.regions.includes(bidRegion));
      if (!regionMatch) continue;

      return { userId: candidate.userId, fullName: candidate.fullName };
    }
  }

  // Pass 2: species match with a wildcard (empty regions) assignment.
  // This catches the case where the bid has no job_region populated yet
  // and a buyer has an unrestricted assignment for the commodity.
  for (const candidate of candidates) {
    for (const assignment of candidate.assignments) {
      const commodityMatch =
        normalizeSpecies(assignment.commodityType).toLowerCase() ===
        normalizedSpecies;
      if (!commodityMatch) continue;
      if (assignment.regions.length === 0) {
        return { userId: candidate.userId, fullName: candidate.fullName };
      }
    }
  }

  return null;
}
