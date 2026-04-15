/**
 * Mobile index — redirect to the tabs dashboard.
 *
 * Purpose:  The Expo Router entry for "/" — redirects authenticated users
 *           to the tab navigator dashboard; unauthenticated users are
 *           routed to the (auth) stack.
 * Inputs:   none.
 * Outputs:  <Redirect />.
 * Agent/API: none.
 * Imports:  expo-router.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { Redirect } from 'expo-router';

export default function Index() {
  return <Redirect href="/(tabs)/dashboard" />;
}
