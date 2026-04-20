/**
 * Settings index live-completion status loader.
 *
 * Purpose:  Derives the five per-section status indicators shown as
 *           chips on the /settings landing page cards (Company, Team,
 *           Integrations, Pricing, Notifications). This is intentionally
 *           a shallow health check, not a deep audit — the goal is to
 *           surface obvious onboarding gaps ("you have 1 pending invite",
 *           "you haven't uploaded a logo") at a glance.
 *
 *           Loads the company row + tenant user list + outlook
 *           subscription in parallel via the admin client. The admin
 *           client is safe here because the route is already session +
 *           tenant gated by the caller; we use it to reach across the
 *           auth.users schema for pending-invite detection without
 *           leaking across tenants.
 *
 * Inputs:   companyId.
 * Outputs:  `SettingsStatus` — a status kind + optional badge label per
 *           section.
 * Agent/API: Supabase (admin).
 * Imports:  @lmbr/lib, next/server runtime only.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { getSupabaseAdmin } from '@lmbr/lib';

export type SettingsSectionKind = 'ok' | 'warn' | 'empty';

export interface SettingsSectionStatus {
  kind: SettingsSectionKind;
  label: string;
}

export interface SettingsStatus {
  company: SettingsSectionStatus;
  team: SettingsSectionStatus;
  integrations: SettingsSectionStatus;
  pricing: SettingsSectionStatus;
  notifications: SettingsSectionStatus;
}

// Kept in sync with migration 028 default.
const NOTIFICATION_DEFAULTS = {
  new_bid_received: true,
  vendor_bid_submitted: true,
  quote_approved_rejected: true,
  vendor_nudge_due: true,
} as const;

export async function loadSettingsStatus(
  companyId: string,
): Promise<SettingsStatus> {
  const admin = getSupabaseAdmin();

  // Three parallel reads — the heaviest is auth.admin.listUsers, which
  // defaults to 50/page and we only need the head count + invited-but-
  // never-signed-in subset for a tenant. For a distributor with < 50
  // seats (the target ICP) this is a single page fetch.
  const [companyRes, tenantUsersRes, subscriptionRes, authListRes] =
    await Promise.all([
      admin
        .from('companies')
        .select(
          'name, logo_url, timezone, default_consolidation_mode, job_regions_served, notification_prefs',
        )
        .eq('id', companyId)
        .maybeSingle(),
      admin.from('users').select('id, email').eq('company_id', companyId),
      admin
        .from('outlook_subscriptions')
        .select('status, expiration_datetime')
        .eq('company_id', companyId)
        .eq('status', 'active')
        .order('expiration_datetime', { ascending: false })
        .limit(1)
        .maybeSingle(),
      admin.auth.admin.listUsers({ page: 1, perPage: 200 }),
    ]);

  const company = companyRes.data;
  const tenantUsers = tenantUsersRes.data ?? [];
  const subscription = subscriptionRes.data;
  const authUsers = authListRes.data?.users ?? [];

  // --- Company section ------------------------------------------------
  // ✓ when the tenant has both a logo uploaded AND at least one region
  // flagged. Timezone always has a default (migration 022) and name is
  // collected at onboarding, so they're never blank — those gate nothing.
  let companyStatus: SettingsSectionStatus;
  const hasLogo = !!company?.logo_url;
  const regionsServed = Array.isArray(company?.job_regions_served)
    ? company!.job_regions_served
    : [];
  if (hasLogo && regionsServed.length > 0) {
    companyStatus = {
      kind: 'ok',
      label: `${regionsServed.length} region${regionsServed.length === 1 ? '' : 's'} served`,
    };
  } else if (!hasLogo && regionsServed.length === 0) {
    companyStatus = { kind: 'warn', label: 'Logo + regions not set' };
  } else if (!hasLogo) {
    companyStatus = { kind: 'warn', label: 'Logo not uploaded' };
  } else {
    companyStatus = { kind: 'warn', label: 'No regions served set' };
  }

  // --- Team section ---------------------------------------------------
  // Pending invite = public.users row present for tenant AND matching
  // auth.users record has last_sign_in_at == null.
  const authByEmail = new Map<string, { lastSignInAt: string | null }>();
  for (const u of authUsers) {
    if (!u.email) continue;
    authByEmail.set(u.email.toLowerCase(), {
      lastSignInAt: (u.last_sign_in_at as string | null) ?? null,
    });
  }
  let pending = 0;
  let active = 0;
  for (const u of tenantUsers) {
    const match = authByEmail.get((u.email as string).toLowerCase());
    if (match && !match.lastSignInAt) pending += 1;
    else active += 1;
  }
  let teamStatus: SettingsSectionStatus;
  if (pending > 0) {
    teamStatus = {
      kind: 'warn',
      label: `${pending} pending invite${pending === 1 ? '' : 's'}`,
    };
  } else if (active >= 2) {
    teamStatus = {
      kind: 'ok',
      label: `${active} active user${active === 1 ? '' : 's'}`,
    };
  } else {
    teamStatus = { kind: 'empty', label: 'Solo — invite teammates' };
  }

  // --- Integrations section -------------------------------------------
  const integrationsStatus: SettingsSectionStatus = subscription
    ? { kind: 'ok', label: 'Outlook connected' }
    : { kind: 'empty', label: 'Not connected' };

  // --- Pricing section -------------------------------------------------
  // These four columns are NOT NULL with sensible defaults (migration
  // 018), so they always exist. We still mark ✓ unconditionally because
  // the defaults are usable out-of-box — the check is purely "does the
  // settings row exist?" which migration 018 guarantees.
  const pricingStatus: SettingsSectionStatus = {
    kind: 'ok',
    label: 'Configured',
  };

  // --- Notifications section -------------------------------------------
  // ✓ when the tenant has actively edited (any toggle differs from the
  // migration default). ○ when the row exactly matches defaults —
  // "using defaults" is a benign state but we surface it so the card
  // communicates that the tenant hasn't actively reviewed the toggles.
  const prefs =
    (company?.notification_prefs as Record<string, boolean> | null) ?? {};
  const differs = Object.entries(NOTIFICATION_DEFAULTS).some(
    ([k, v]) => prefs[k] !== undefined && prefs[k] !== v,
  );
  const notificationsStatus: SettingsSectionStatus = differs
    ? { kind: 'ok', label: 'Configured' }
    : { kind: 'empty', label: 'Using defaults' };

  return {
    company: companyStatus,
    team: teamStatus,
    integrations: integrationsStatus,
    pricing: pricingStatus,
    notifications: notificationsStatus,
  };
}
