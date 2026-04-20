/**
 * ConsoleSidebar — fixed-left console navigation.
 *
 * Purpose:  Shared sidebar for every LMBR.ai console page (dashboard,
 *           bids, vendors, market, archive, settings). Built strictly to
 *           README §5 "Sidebar Navigation" — 240px wide, bg-surface,
 *           border-right, 36px nav items with 16px icons, accent-primary
 *           left-border on the active item, small brand mark at the top.
 *
 * Inputs:   current pathname (client-side via usePathname).
 * Outputs:  <aside> JSX.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  FileBarChart,
  Building2,
  LineChart,
  Archive,
  Settings,
} from 'lucide-react';

import { cn } from '../../lib/cn';

// React.ElementType — lucide icons are ForwardRefExoticComponent whose
// `aria-hidden` signature is `Booleanish` (accepts "true" | "false" |
// boolean), which doesn't fit a narrower `{ 'aria-hidden'?: boolean }`
// local type. ElementType accepts any renderable component including
// refs and avoids the cross-version @types/react mismatch with
// lucide-react's prop declarations.
interface NavItem {
  label: string;
  href: Route;
  icon: React.ElementType;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Bids', href: '/bids', icon: FileBarChart },
  { label: 'Vendors', href: '/vendors', icon: Building2 },
  { label: 'Market', href: '/dashboard/market', icon: LineChart },
  { label: 'Archive', href: '/archive', icon: Archive },
  { label: 'Settings', href: '/settings', icon: Settings },
];

export function ConsoleSidebar() {
  const pathname = usePathname() ?? '';

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[240px] flex-col border-r border-border-subtle bg-bg-surface px-3 py-4 md:flex">
      <Link
        href="/dashboard"
        className="mb-6 flex items-center gap-2.5 px-3 py-1.5"
        aria-label="LMBR.ai dashboard"
      >
        <span
          aria-hidden="true"
          className="h-6 w-6 rounded-sm bg-gradient-brand shadow-accent"
        />
        <span className="text-h4 text-text-primary">
          LMBR<span className="text-accent-primary">.ai</span>
        </span>
      </Link>

      <nav className="flex flex-1 flex-col gap-0.5">
        {NAV_ITEMS.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'relative flex h-9 items-center gap-2.5 rounded-sm px-3 text-body transition-colors duration-micro',
                active
                  ? 'bg-[rgba(29,184,122,0.12)] text-accent-primary'
                  : 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary',
              )}
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-1.5 h-6 w-[2px] rounded-r bg-accent-primary"
                />
              )}
              <Icon
                className={cn(
                  'h-4 w-4 flex-none',
                  active ? 'text-accent-primary' : 'text-text-tertiary',
                )}
                aria-hidden={true}
              />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-4 border-t border-border-subtle px-3 pt-4 text-caption text-text-tertiary">
        LMBR.ai · Worklighter
      </div>
    </aside>
  );
}
