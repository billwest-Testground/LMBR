/**
 * Dashboard index — role-aware redirect.
 *
 * Purpose:  Resolves the signed-in user's primary role and redirects to
 *           /dashboard/trader, /dashboard/buyer, /dashboard/unified, or
 *           /dashboard/manager. Trader-Buyer (unified) is the default for
 *           users holding both trader and buyer roles.
 * Inputs:   session user via Supabase server client.
 * Outputs:  redirect().
 * Agent/API: Supabase Auth.
 * Imports:  @lmbr/types (UserRole), @lmbr/lib.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export default function DashboardIndexPage() {
  return <div>Not implemented: DashboardIndexPage</div>;
}
