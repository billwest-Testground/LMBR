/**
 * General utility helpers shared across web + mobile.
 *
 * Purpose:  Small, pure utilities used everywhere in LMBR.ai: class-name
 *           merging for Tailwind (`cn`), currency + board-foot display
 *           formatting, consolidation-key construction for the bid engine.
 * Inputs:   various primitive values.
 * Outputs:  cn(), formatCurrency(), formatBoardFeet(), consolidationKey().
 * Agent/API: none directly.
 * Imports:  ./lumber (normalizers).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import {
  normalizeDimension,
  normalizeGrade,
  normalizeLength,
  normalizeSpecies,
  normalizeUnit,
} from './lumber';

export function cn(
  ...inputs: Array<string | undefined | null | false>
): string {
  return inputs.filter(Boolean).join(' ');
}

export function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatBoardFeet(bf: number): string {
  if (bf >= 1000) {
    return `${(bf / 1000).toFixed(1)}M BF`;
  }
  return `${Math.round(bf).toLocaleString()} BF`;
}

/**
 * Build a stable consolidation key for a line item so like items across
 * houses / phases collapse to one mill-facing row while the original
 * house/phase breakdown is preserved for the customer quote.
 *
 * Key format: species|dimension|grade|length|unit — all normalized and
 * lowercased. Null or empty fields become "unknown" to prevent key
 * collisions (e.g. SPF|2x4||8|PCS vs SPF|2x4|unknown|8|PCS).
 */
export function consolidationKey(parts: {
  species: string;
  dimension: string;
  grade?: string | null;
  length?: string | null;
  unit?: string | null;
}): string {
  const seg = (val: string | null | undefined): string => {
    const normalized = (val ?? '').trim().toLowerCase();
    return normalized === '' ? 'unknown' : normalized;
  };
  return [
    seg(normalizeSpecies(parts.species)),
    seg(normalizeDimension(parts.dimension)),
    seg(normalizeGrade(parts.grade ?? '')),
    seg(normalizeLength(parts.length ?? '')),
    seg(normalizeUnit(parts.unit ?? '')),
  ].join('|');
}
