/**
 * User type — platform user within a company tenant.
 *
 * Purpose:  Represents a human operator in LMBR.ai. A user belongs to exactly
 *           one company and carries one or more roles that gate access to
 *           workflows (ingest, vendor bidding, margin, quoting, market intel).
 * Inputs:   none — declarative type module.
 * Outputs:  `User` type + `UserSchema` Zod schema, used by auth/session,
 *           role-switcher, and manager-only gated endpoints.
 * Agent/API: consumed by API routes to enforce role-based access on margin
 *            approval, quote release, etc.
 * Imports:  zod, ./role.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { z } from 'zod';
import { UserRoleSchema } from './role';

export const UserSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  email: z.string().email(),
  fullName: z.string().min(1),
  phone: z.string().optional(),
  avatarUrl: z.string().url().optional(),
  roles: z.array(UserRoleSchema).min(1),
  isActive: z.boolean().default(true),
  lastSignInAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type User = z.infer<typeof UserSchema>;
