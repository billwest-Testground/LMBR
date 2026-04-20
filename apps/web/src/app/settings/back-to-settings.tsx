/**
 * Back-to-settings breadcrumb link.
 *
 * Purpose:  Small navigation affordance placed at the top of every
 *           /settings/{section} page. The sidebar's Settings entry
 *           activates for the whole prefix but doesn't give a one-click
 *           path back to the section hub — this does.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

export function BackToSettingsLink() {
  return (
    <Link
      href="/settings"
      className="inline-flex w-fit items-center gap-1 text-body-sm text-text-tertiary transition-colors duration-micro hover:text-accent-primary"
    >
      <ChevronLeft className="h-4 w-4" aria-hidden={true} />
      <span>Back to settings</span>
    </Link>
  );
}
