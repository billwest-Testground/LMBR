/**
 * (auth) stack layout — LMBR.ai mobile.
 *
 * Purpose:  Wraps the unauthenticated screens (login, onboarding) in a
 *           headerless Stack navigator with the LMBR.ai brand background.
 * Inputs:   none.
 * Outputs:  <Stack />.
 * Agent/API: none.
 * Imports:  expo-router.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { Stack } from 'expo-router';

export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
