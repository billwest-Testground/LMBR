/**
 * format-datetime — shared timezone-pinned datetime formatter.
 *
 * Purpose:  Produce identical, timezone-stable strings for dates displayed
 *           to vendors and customers across both the printable PDF tally
 *           (server-rendered via @react-pdf/renderer) and the HTML vendor
 *           submission flow (client component). Without this, the two
 *           surfaces can disagree: on Vercel the Node process runs in UTC
 *           and `toLocaleString('en-US')` with no `timeZone` option prints
 *           UTC; on a developer laptop the same call prints local time.
 *           A vendor receiving a paper sheet printed on Vercel and a link
 *           rendered by a teammate's laptop could see two different due
 *           dates for the same bid.
 *
 *           Lives in `apps/web/src/lib/` (not inside `vendor-tally-pdf.tsx`)
 *           because the vendor submit form is a client component; importing
 *           from `vendor-tally-pdf.tsx` would drag `@react-pdf/renderer`
 *           into the client bundle.
 *
 * Inputs:   ISO-8601 strings (or null for the due-by helper).
 * Outputs:  en-US short-form strings with explicit timezone abbreviation,
 *           e.g. "Apr 16, 2026, 6:00 PM EDT".
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

/**
 * LMBR serves US lumber distributors; NY default until `companies.timezone`
 * column ships. When a company timezone is available, thread it through the
 * render props (PDF) and page props (submit form) and pass it to the
 * formatters below instead of relying on this default.
 */
export const TALLY_TIMEZONE = 'America/New_York';

const DATETIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: TALLY_TIMEZONE,
  timeZoneName: 'short',
};

/**
 * Format a "due by" ISO timestamp for display. Null / invalid → a stable
 * "Not specified" sentinel (the PDF and the form should both handle a
 * missing due date the same way).
 */
export function formatDueByLabel(iso: string | null | undefined): string {
  if (!iso) return 'Not specified';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Not specified';
  return d.toLocaleString('en-US', DATETIME_OPTIONS);
}

/**
 * Format a "generated at" / general timestamp ISO string. Invalid input
 * falls through to the raw string so we never crash the render.
 */
export function formatTimestampLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', DATETIME_OPTIONS);
}
