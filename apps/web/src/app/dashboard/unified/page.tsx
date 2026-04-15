/**
 * /dashboard/unified — Trader + Buyer flagship dashboard.
 *
 * Purpose:  The most important surface in LMBR.ai for solo operators
 *           and trader_buyer-role users. Split-panel layout with the
 *           trader view on the left and the buyer view on the right.
 *           Both panels poll independently via TanStack Query so the
 *           dashboard feels live without any manual refresh. On small
 *           screens the panels collapse to a tab switcher.
 *
 *           Design: feels like a trading terminal. Dense, fast,
 *           accent-primary highlights per README §10 "Unified
 *           Trader-Buyer Dashboard" spec.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import * as React from 'react';

import { TraderPanel } from '../../../components/dashboard/trader-panel';
import { BuyerPanel } from '../../../components/dashboard/buyer-panel';
import { cn } from '../../../lib/cn';

type ActiveTab = 'trader' | 'buyer';

export default function UnifiedDashboardPage() {
  const [activeTab, setActiveTab] = React.useState<ActiveTab>('trader');

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-label uppercase text-text-tertiary">Unified</div>
          <h1 className="mt-1 flex items-center gap-3 text-h1 text-text-primary">
            Trading terminal
            <span className="inline-flex items-center gap-1 rounded-pill border border-[rgba(143,212,74,0.3)] bg-[rgba(143,212,74,0.12)] px-3 py-0.5 text-label uppercase text-accent-warm">
              Trader + Buyer
            </span>
          </h1>
        </div>
      </header>

      {/* Mobile tab switcher — hidden on lg+ */}
      <div
        className="inline-flex self-start rounded-pill border border-border-base bg-bg-subtle p-1 lg:hidden"
        role="tablist"
        aria-label="Dashboard panel"
      >
        <TabButton
          active={activeTab === 'trader'}
          onClick={() => setActiveTab('trader')}
          label="Trader"
        />
        <TabButton
          active={activeTab === 'buyer'}
          onClick={() => setActiveTab('buyer')}
          label="Buyer"
        />
      </div>

      {/* Desktop split panel (lg+) */}
      <div className="hidden grid-cols-2 gap-0 lg:grid">
        <section
          aria-label="Trader panel"
          className="border-r border-border-base pr-6"
        >
          <TraderPanel compact />
        </section>
        <section aria-label="Buyer panel" className="pl-6">
          <BuyerPanel compact />
        </section>
      </div>

      {/* Mobile single-panel view */}
      <div className="lg:hidden">
        {activeTab === 'trader' ? <TraderPanel compact /> : <BuyerPanel compact />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center rounded-pill px-4 text-caption uppercase tracking-wide transition-colors duration-micro',
        active
          ? 'bg-accent-primary text-text-inverse shadow-accent'
          : 'text-text-tertiary hover:text-text-primary',
      )}
    >
      {label}
    </button>
  );
}
