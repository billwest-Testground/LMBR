/**
 * Onboarding — Roles step.
 *
 * Purpose:  Invites initial users and assigns them LMBR.ai roles: Trader,
 *           Buyer, Trader-Buyer (unified), Manager-Owner. Seed rows land in
 *           `public.users` and `public.user_roles` and trigger a Supabase
 *           magic-link invitation email.
 * Inputs:   invitee list (client state).
 * Outputs:  Role-assignment form JSX.
 * Agent/API: Supabase Auth + @lmbr/lib.
 * Imports:  @lmbr/types (UserRole).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export default function OnboardingRolesPage() {
  return <div>Not implemented: OnboardingRolesPage</div>;
}
