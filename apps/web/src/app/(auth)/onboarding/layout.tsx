/**
 * Onboarding layout — 4-step wizard chrome.
 *
 * Purpose:  Shared container and progress indicator for the first-run
 *           wizard that provisions a brand-new LMBR.ai tenant. Shows a
 *           numbered stepper (company → roles → commodities → vendors)
 *           with the active step highlighted and completed steps marked
 *           via the accent ring. Step 1 is required; steps 2–4 are
 *           skippable and can be completed later from Settings.
 *
 * Inputs:   `children` — the current step page.
 * Outputs:  JSX.
 * Agent/API: none directly.
 * Imports:  next/navigation.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { cn } from '../../../lib/cn';

interface WizardStep {
  key: string;
  label: string;
  path: string;
  optional: boolean;
}

const STEPS: WizardStep[] = [
  { key: 'company', label: 'Company', path: '/onboarding/company', optional: false },
  { key: 'roles', label: 'Team', path: '/onboarding/roles', optional: true },
  { key: 'commodities', label: 'Commodities', path: '/onboarding/commodities', optional: true },
  { key: 'vendors', label: 'Vendors', path: '/onboarding/vendors', optional: true },
];

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? '';
  const currentIndex = Math.max(
    0,
    STEPS.findIndex((step) => pathname.startsWith(step.path)),
  );

  return (
    <div className="w-full max-w-[680px]">
      <ProgressIndicator currentIndex={currentIndex} />
      <div className="mt-8">{children}</div>
    </div>
  );
}

function ProgressIndicator({ currentIndex }: { currentIndex: number }) {
  return (
    <nav aria-label="Onboarding progress" className="flex items-center gap-2">
      {STEPS.map((step, index) => {
        const isActive = index === currentIndex;
        const isComplete = index < currentIndex;
        const isUpcoming = index > currentIndex;

        return (
          <React.Fragment key={step.key}>
            <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
              <div
                className={cn(
                  'h-1 w-full rounded-pill transition-colors duration-standard',
                  isComplete && 'bg-accent-primary',
                  isActive && 'bg-accent-primary shadow-accent',
                  isUpcoming && 'bg-bg-subtle',
                )}
                aria-hidden="true"
              />
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'inline-flex h-5 w-5 items-center justify-center rounded-pill text-caption font-semibold transition-colors duration-standard',
                    isComplete &&
                      'bg-accent-primary text-text-inverse',
                    isActive &&
                      'bg-accent-primary text-text-inverse shadow-accent',
                    isUpcoming && 'bg-bg-subtle text-text-tertiary',
                  )}
                >
                  {isComplete ? '\u2713' : index + 1}
                </span>
                <span
                  className={cn(
                    'text-label uppercase',
                    isActive ? 'text-text-primary' : 'text-text-tertiary',
                  )}
                >
                  {step.label}
                </span>
                {step.optional && (
                  <span className="text-caption text-text-tertiary">(optional)</span>
                )}
              </div>
            </div>
          </React.Fragment>
        );
      })}
    </nav>
  );
}
