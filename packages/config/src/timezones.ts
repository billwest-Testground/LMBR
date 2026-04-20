/**
 * Supported company timezones.
 *
 * Purpose:  Curated list of IANA timezones surfaced in the /settings/company
 *           picker. The companies.timezone column (migration 022) accepts
 *           any string — Intl.DateTimeFormat validates at format time —
 *           but the UI constrains the picker to a small list covering
 *           every US zone plus the handful of international zones where
 *           wholesale lumber distributors operate today.
 *
 *           Kept deliberately short so onboarding stays decisive. When a
 *           tenant needs a zone outside this list, the DB column still
 *           accepts it — the fallback path is a customer-support ticket,
 *           not a failed format call.
 *
 * Inputs:   none — declarative module.
 * Outputs:  COMPANY_TIMEZONES (array), isKnownTimezone predicate.
 * Agent/API: consumed by /settings/company page + API route.
 * Imports:  none.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export interface CompanyTimezone {
  id: string;              // IANA identifier (e.g. 'America/Los_Angeles')
  label: string;           // Human-readable (e.g. 'Pacific — Los Angeles')
  offsetHint: string;      // Coarse offset used for labeling the picker
}

export const COMPANY_TIMEZONES: readonly CompanyTimezone[] = [
  { id: 'America/Los_Angeles', label: 'Pacific — Los Angeles',   offsetHint: 'UTC−08 / −07' },
  { id: 'America/Denver',      label: 'Mountain — Denver',       offsetHint: 'UTC−07 / −06' },
  { id: 'America/Phoenix',     label: 'Mountain (no DST) — Phoenix', offsetHint: 'UTC−07' },
  { id: 'America/Chicago',     label: 'Central — Chicago',       offsetHint: 'UTC−06 / −05' },
  { id: 'America/New_York',    label: 'Eastern — New York',      offsetHint: 'UTC−05 / −04' },
  { id: 'America/Anchorage',   label: 'Alaska — Anchorage',      offsetHint: 'UTC−09 / −08' },
  { id: 'Pacific/Honolulu',    label: 'Hawaii — Honolulu',       offsetHint: 'UTC−10' },
  { id: 'America/Toronto',     label: 'Eastern — Toronto',       offsetHint: 'UTC−05 / −04' },
  { id: 'America/Vancouver',   label: 'Pacific — Vancouver',     offsetHint: 'UTC−08 / −07' },
];

const KNOWN_IDS = new Set(COMPANY_TIMEZONES.map((t) => t.id));

export function isKnownTimezone(id: string): boolean {
  return KNOWN_IDS.has(id);
}
