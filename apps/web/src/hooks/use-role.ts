/**
 * useRole — active role + capability helper.
 *
 * Purpose:  Returns the current user's active role and a RoleCapabilities
 *           object so components can gate actions (e.g. only Manager-Owner
 *           sees the "Release Quote" button).
 * Inputs:   none (reads session).
 * Outputs:  { role, capabilities }.
 * Agent/API: none.
 * Imports:  @lmbr/types (UserRole, RoleCapabilities).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export function useRole(): never {
  throw new Error('Not implemented');
}
