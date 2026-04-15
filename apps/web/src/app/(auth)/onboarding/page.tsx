/**
 * Onboarding index — redirect to step 1.
 *
 * Purpose:  /onboarding is a passthrough route. Any landing here is routed
 *           straight to /onboarding/company (step 1 of the 4-step wizard).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { redirect } from 'next/navigation';

export default function OnboardingIndexPage() {
  redirect('/onboarding/company');
}
