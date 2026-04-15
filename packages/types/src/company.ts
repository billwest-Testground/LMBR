/**
 * Company type — tenant root for LMBR.ai multi-tenant SaaS.
 *
 * Purpose:  Describes a wholesale lumber distributor tenant. Every other
 *           entity in the platform (users, bids, vendors, quotes, market
 *           prices) is scoped by `company_id`. Row-level security in
 *           Supabase keys off this id.
 * Inputs:   none — this is a declarative type + Zod schema module.
 * Outputs:  `Company` TS type and `CompanySchema` Zod schema used by the
 *           onboarding flow, settings page, and agent context.
 * Agent/API: consumed by every agent in @lmbr/agents for tenant scoping.
 * Imports:  zod.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';

export const CompanySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  legalName: z.string().optional(),
  address: z
    .object({
      line1: z.string(),
      line2: z.string().optional(),
      city: z.string(),
      state: z.string().length(2),
      postalCode: z.string(),
      country: z.string().default('US'),
    })
    .optional(),
  timezone: z.string().default('America/Los_Angeles'),
  defaultMarginPct: z.number().min(0).max(1).default(0.08),
  managerApprovalThreshold: z.number().nonnegative().default(0),
  randomLengthsSubscription: z.boolean().default(false),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Company = z.infer<typeof CompanySchema>;
