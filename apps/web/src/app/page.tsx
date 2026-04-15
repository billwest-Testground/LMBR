/**
 * LMBR.ai root entry — hands off to /dashboard.
 *
 * Purpose:  The unauthenticated marketing surface is out of scope for the
 *           console build. Hitting `/` routes the visitor to /dashboard,
 *           where the middleware then takes over: authenticated users land
 *           in the right console, and unauthenticated visitors get bounced
 *           to /login.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { redirect } from 'next/navigation';

export default function HomePage() {
  redirect('/dashboard');
}
