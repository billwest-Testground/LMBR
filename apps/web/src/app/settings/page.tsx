/**
 * Settings index — landing page hub.
 *
 * Purpose:  Server component rendering the five settings cards (Company,
 *           Team, Integrations, Pricing, Notifications) with a live
 *           completion chip per card. The chip comes from
 *           loadSettingsStatus — a single parallel-fetch sweep that
 *           summarizes the tenant's configuration state at a glance.
 *
 *           Billing is intentionally excluded from the card grid —
 *           /settings/billing exists as a future stub, and exposing an
 *           empty surface would undermine the live-status indicator
 *           discipline (every card that ships has a real check backing
 *           its chip).
 *
 * Inputs:   session.
 * Outputs:  Settings landing page JSX.
 * Agent/API: Supabase session + admin (via loadSettingsStatus).
 * Imports:  next/navigation, lucide-react, ./settings-status,
 *           ../../lib/supabase/server, ../../components/ui/card.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import Link from 'next/link';
import type { Route } from 'next';
import { redirect } from 'next/navigation';
import {
  Bell,
  Building2,
  CheckCircle2,
  Circle,
  Mail,
  Percent,
  Users,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';

import { getSupabaseRSCClient } from '../../lib/supabase/server';
import { cn } from '../../lib/cn';
import {
  loadSettingsStatus,
  type SettingsSectionKind,
  type SettingsSectionStatus,
  type SettingsStatus,
} from './settings-status';

export const dynamic = 'force-dynamic';

interface SettingsCard {
  key: keyof SettingsStatus;
  title: string;
  description: string;
  href: string;
  icon: React.ElementType;
}

const CARDS: readonly SettingsCard[] = [
  {
    key: 'company',
    title: 'Company',
    description: 'Name, logo, timezone, default consolidation mode, and regions served.',
    href: '/settings/company',
    icon: Building2,
  },
  {
    key: 'team',
    title: 'Team',
    description: 'Invite teammates, assign roles, deactivate access.',
    href: '/settings/team',
    icon: Users,
  },
  {
    key: 'integrations',
    title: 'Integrations',
    description: 'Outlook mailbox subscription, personal connections, and email templates.',
    href: '/settings/integrations',
    icon: Mail,
  },
  {
    key: 'pricing',
    title: 'Pricing',
    description: 'Approval threshold, minimum margin, and margin presets.',
    href: '/settings/pricing',
    icon: Percent,
  },
  {
    key: 'notifications',
    title: 'Notifications',
    description: 'Toggle email alerts for new bids, vendor pricing, and approvals.',
    href: '/settings/notifications',
    icon: Bell,
  },
];

export default async function SettingsIndexPage() {
  const supabase = getSupabaseRSCClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect('/login');

  const { data: profile } = await supabase
    .from('users')
    .select('company_id')
    .eq('id', session.user.id)
    .maybeSingle();
  if (!profile?.company_id) redirect('/onboarding/company');

  const status = await loadSettingsStatus(profile.company_id);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-h1 text-text-primary">Settings</h1>
        <p className="mt-1 text-body text-text-secondary">
          Configure your company profile, team, integrations, pricing, and
          notifications. The chip on each card reflects live tenant state.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((card) => (
          <SettingsCardLink
            key={card.key}
            card={card}
            status={status[card.key]}
          />
        ))}
      </div>
    </div>
  );
}

function SettingsCardLink({
  card,
  status,
}: {
  card: SettingsCard;
  status: SettingsSectionStatus;
}) {
  const Icon = card.icon;
  return (
    <Link
      href={card.href as Route}
      className="group flex flex-col gap-3 rounded-md border border-border-base bg-bg-surface p-5 shadow-sm transition-[border-color,background-color,box-shadow] duration-micro hover:border-accent-primary hover:bg-bg-elevated"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-bg-elevated text-accent-primary">
          <Icon className="h-4 w-4" aria-hidden={true} />
        </div>
        <StatusChip status={status} />
      </div>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-h3 text-text-primary">{card.title}</h2>
        <p className="text-body-sm text-text-secondary">{card.description}</p>
      </div>
      <div className="mt-auto flex items-center gap-1 pt-1 text-body-sm text-text-tertiary transition-colors duration-micro group-hover:text-accent-primary">
        <span>Configure</span>
        <ChevronRight className="h-4 w-4" aria-hidden={true} />
      </div>
    </Link>
  );
}

function StatusChip({ status }: { status: SettingsSectionStatus }) {
  const palette = CHIP_PALETTE[status.kind];
  const Icon = palette.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption',
        palette.classes,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden={true} />
      <span>{status.label}</span>
    </span>
  );
}

const CHIP_PALETTE: Record<
  SettingsSectionKind,
  {
    icon: React.ElementType;
    classes: string;
  }
> = {
  ok: {
    icon: CheckCircle2,
    classes:
      'border-[rgba(29,184,122,0.3)] bg-[rgba(29,184,122,0.12)] text-accent-primary',
  },
  warn: {
    icon: AlertTriangle,
    classes:
      'border-[rgba(232,161,72,0.35)] bg-[rgba(232,161,72,0.14)] text-semantic-warning',
  },
  empty: {
    icon: Circle,
    classes: 'border-border-base bg-bg-elevated text-text-tertiary',
  },
};
