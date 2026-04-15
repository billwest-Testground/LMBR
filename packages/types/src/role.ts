/**
 * Role types — Trader / Buyer / Trader-Buyer (unified) / Manager-Owner.
 *
 * Purpose:  Defines the four canonical LMBR.ai roles. Trader handles customer
 *           bids + margin; Buyer handles vendor bid solicitation + extraction;
 *           Trader-Buyer is the unified operator who does both (common in
 *           small distributors); Manager-Owner gates margin approval, quote
 *           release, and sees company-wide analytics.
 * Inputs:   none — declarative module.
 * Outputs:  `UserRole` enum, Zod schema, and helper predicates (`canApprove*`
 *           etc.) consumed by UI guards and API-route authorization.
 * Agent/API: consumed by routing-agent (to pick the right human inbox) and
 *            by pricing-agent (to surface manager approval prompts).
 * Imports:  zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';

export const USER_ROLES = [
  'trader',
  'buyer',
  'trader_buyer',
  'manager_owner',
] as const;

export const UserRoleSchema = z.enum(USER_ROLES);

export type UserRole = z.infer<typeof UserRoleSchema>;

export interface RoleCapabilities {
  canIngestBid: boolean;
  canRouteBid: boolean;
  canSolicitVendorBids: boolean;
  canExtractVendorPrices: boolean;
  canConsolidate: boolean;
  canCompare: boolean;
  canApplyMargin: boolean;
  canApproveMargin: boolean;
  canReleaseQuote: boolean;
  canViewCompanyAnalytics: boolean;
  canManageUsers: boolean;
  canManageBilling: boolean;
}
