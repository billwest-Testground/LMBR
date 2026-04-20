/**
 * ConsoleTopbar — 56px header with breadcrumb + user menu.
 *
 * Purpose:  Shared top strip across every LMBR.ai console page per
 *           README §5 "Header / Top Bar" — 56px high, bg-base, bottom
 *           border subtle, breadcrumb on the left, user actions on the
 *           right. Renders the current user's name + role and a sign-out
 *           button. Real-time clients (session hydration, logout) live
 *           here because the rest of the shell is a server component.
 *
 * Inputs:   fullName, companyName, primaryRole.
 * Outputs:  <header> JSX.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, Bell } from 'lucide-react';

import { getSupabaseBrowserClient } from '../../lib/supabase/browser';
import { Button } from '../ui/button';
import { ThemeToggle } from './theme-toggle';

const ROLE_LABELS: Record<string, string> = {
  trader: 'Trader',
  buyer: 'Buyer',
  trader_buyer: 'Trader + Buyer',
  manager: 'Manager',
  owner: 'Owner',
};

const SECTION_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  bids: 'Bids',
  vendors: 'Vendors',
  market: 'Market',
  archive: 'Archive',
  settings: 'Settings',
};

export interface ConsoleTopbarProps {
  fullName: string;
  companyName: string;
  primaryRole: string;
}

export function ConsoleTopbar({
  fullName,
  companyName,
  primaryRole,
}: ConsoleTopbarProps) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const supabase = React.useMemo(() => getSupabaseBrowserClient(), []);
  const [signingOut, setSigningOut] = React.useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
    router.replace('/login');
    router.refresh();
  }

  const segments = pathname.split('/').filter(Boolean);
  const topSegment = segments[0] ?? 'dashboard';
  const sectionLabel = SECTION_LABELS[topSegment] ?? topSegment;
  const subSegment = segments[1];

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border-subtle bg-bg-base px-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-body">
        <span className="text-text-tertiary">{companyName}</span>
        <span className="text-text-tertiary">/</span>
        <span
          className={
            subSegment ? 'text-text-tertiary' : 'text-text-primary'
          }
        >
          {sectionLabel}
        </span>
        {subSegment && (
          <>
            <span className="text-text-tertiary">/</span>
            <span className="text-text-primary">{prettifySegment(subSegment)}</span>
          </>
        )}
      </nav>

      <div className="flex items-center gap-3">
        <ThemeToggle />
        <button
          type="button"
          aria-label="Notifications"
          className="inline-flex h-9 w-9 items-center justify-center rounded-sm text-text-secondary transition-colors duration-micro hover:bg-bg-elevated hover:text-text-primary"
        >
          <Bell className="h-4 w-4" aria-hidden="true" />
        </button>

        <div className="hidden items-center gap-3 border-l border-border-subtle pl-3 sm:flex">
          <div className="text-right">
            <div className="text-body text-text-primary">{fullName}</div>
            <div className="text-caption uppercase tracking-wide text-text-tertiary">
              {ROLE_LABELS[primaryRole] ?? primaryRole}
            </div>
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleSignOut}
          loading={signingOut}
          aria-label="Sign out"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">Sign out</span>
        </Button>
      </div>
    </header>
  );
}

function prettifySegment(segment: string): string {
  return segment
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
