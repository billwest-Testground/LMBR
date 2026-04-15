/**
 * Login page — LMBR.ai authentication entry.
 *
 * Purpose:  Renders the Supabase-backed sign-in form. On success, resolves
 *           the user's role(s) and redirects to the appropriate dashboard:
 *           trader → /dashboard/trader, buyer → /dashboard/buyer,
 *           trader_buyer → /dashboard/unified, manager_owner →
 *           /dashboard/manager.
 * Inputs:   form { email, password } (client), optional redirectTo param.
 * Outputs:  Sign-in JSX surface.
 * Agent/API: Supabase Auth via @supabase/auth-helpers-nextjs.
 * Imports:  @lmbr/types (UserRole), @lmbr/lib (supabase client).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export default function LoginPage() {
  return <div>Not implemented: LoginPage</div>;
}
