/**
 * slugify — deterministic URL-safe slug for a company name.
 *
 * Purpose:  Used during onboarding to derive a default company slug from
 *           the company name (e.g. "Cascade Lumber Co." → "cascade-lumber").
 *           Stripped of punctuation, lowercased, hyphen-separated,
 *           collapsed whitespace, max 48 chars.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

export function extractEmailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at === -1) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (domain.length === 0 || !domain.includes('.')) return null;
  return domain;
}
