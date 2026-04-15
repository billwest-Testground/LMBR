/**
 * Lumber normalization helpers.
 *
 * Purpose:  Canonicalize messy trader/customer text into the LMBR.ai
 *           vocabulary. Claude is good at extraction but ambiguous
 *           shorthand ("DougFir", "2×4", "Rand Lgth", "BdFt") still
 *           needs deterministic cleanup before anything touches the
 *           DB — downstream agents depend on consistent species /
 *           dimension / grade / unit tokens.
 *
 *           Also houses the authoritative board-foot calculator that
 *           takes a "2x4" × length × qty and returns BF directly. Used
 *           by extraction-agent post-processing AND qa-agent validation.
 *
 * Inputs:   raw text fragments.
 * Outputs:  canonical strings + numeric board-foot volume.
 * Agent/API: none — pure functions.
 * Imports:  @lmbr/config (LUMBER_SPECIES, STANDARD_DIMENSIONS, LUMBER_GRADES).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import {
  LUMBER_SPECIES,
  STANDARD_DIMENSIONS,
  LUMBER_GRADES,
  calculateBoardFeet,
} from '@lmbr/config';

// -----------------------------------------------------------------------------
// Species
// -----------------------------------------------------------------------------

/**
 * Canonical species tokens LMBR uses on every line_item row and in the
 * @lmbr/config catalog. Claude is instructed to output these directly; we
 * re-apply the normalization on the client side to catch drift.
 */
export const CANONICAL_SPECIES = [
  'SPF',
  'DF',
  'HF',
  'SYP',
  'Cedar',
  'LVL',
  'OSB',
  'Plywood',
  'Treated',
] as const;
export type CanonicalSpecies = (typeof CANONICAL_SPECIES)[number];

const SPECIES_ALIAS_MAP: Record<string, CanonicalSpecies> = (() => {
  const map: Record<string, CanonicalSpecies> = {};
  const add = (alias: string, target: CanonicalSpecies) => {
    map[alias.toLowerCase().replace(/[^a-z0-9]/g, '')] = target;
  };
  // Douglas Fir
  add('DF', 'DF');
  add('Doug Fir', 'DF');
  add('DougFir', 'DF');
  add('Douglas Fir', 'DF');
  add('Douglas-Fir', 'DF');
  add('DF-L', 'DF');
  add('DFL', 'DF');
  // Hem-Fir
  add('HF', 'HF');
  add('Hem Fir', 'HF');
  add('HemFir', 'HF');
  add('Hem-Fir', 'HF');
  // SPF
  add('SPF', 'SPF');
  add('Spruce Pine Fir', 'SPF');
  add('Spruce-Pine-Fir', 'SPF');
  add('SPF-S', 'SPF');
  // Southern Yellow Pine
  add('SYP', 'SYP');
  add('Southern Yellow Pine', 'SYP');
  add('Southern Pine', 'SYP');
  add('Yellow Pine', 'SYP');
  add('SoYP', 'SYP');
  // Cedar
  add('Cedar', 'Cedar');
  add('Western Red Cedar', 'Cedar');
  add('WRC', 'Cedar');
  add('Red Cedar', 'Cedar');
  // LVL
  add('LVL', 'LVL');
  add('Laminated Veneer Lumber', 'LVL');
  add('Microllam', 'LVL');
  // OSB
  add('OSB', 'OSB');
  add('Oriented Strand Board', 'OSB');
  // Plywood
  add('Plywood', 'Plywood');
  add('CDX', 'Plywood');
  add('Plyw', 'Plywood');
  add('Sheathing Plywood', 'Plywood');
  // Treated
  add('Treated', 'Treated');
  add('Pressure Treated', 'Treated');
  add('PT', 'Treated');
  add('ACQ', 'Treated');
  add('MCA', 'Treated');
  return map;
})();

export function normalizeSpecies(input: string | null | undefined): string {
  if (!input) return '';
  const key = input.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SPECIES_ALIAS_MAP[key] ?? input.trim();
}

export function isCanonicalSpecies(value: string): value is CanonicalSpecies {
  return (CANONICAL_SPECIES as readonly string[]).includes(value);
}

// -----------------------------------------------------------------------------
// Dimension (e.g. "2x4")
// -----------------------------------------------------------------------------

export const CANONICAL_DIMENSIONS = STANDARD_DIMENSIONS.map((d) => d.label);

/**
 * Parse a freeform dimension token into its nominal thickness + width.
 * Accepts "2x4", "2×4", "2 X 4", "4X4", "2 x 10", "1x6", etc. Returns
 * null if the input doesn't parse as a rectangular nominal section.
 */
export function parseDimension(
  input: string | null | undefined,
): { thickness: number; width: number; label: string } | null {
  if (!input) return null;
  const match = input
    .replace(/[×xX]/g, 'x')
    .replace(/\s+/g, '')
    .match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const thickness = Number(match[1]);
  const width = Number(match[2]);
  if (!Number.isFinite(thickness) || !Number.isFinite(width)) return null;
  return {
    thickness,
    width,
    // Present as integers when whole, otherwise keep decimal.
    label: `${formatDimPart(thickness)}x${formatDimPart(width)}`,
  };
}

function formatDimPart(n: number): string {
  return Number.isInteger(n) ? n.toFixed(0) : n.toString();
}

export function normalizeDimension(input: string | null | undefined): string {
  const parsed = parseDimension(input);
  if (parsed) return parsed.label;
  return (input ?? '').trim();
}

// -----------------------------------------------------------------------------
// Grade
// -----------------------------------------------------------------------------

const GRADE_ALIAS_MAP: Record<string, string> = {
  '1': '#1',
  no1: '#1',
  '#1': '#1',
  '2': '#2',
  no2: '#2',
  '#2': '#2',
  '3': '#3',
  no3: '#3',
  '#3': '#3',
  stud: 'Stud',
  studs: 'Stud',
  select: 'Select Structural',
  selectstructural: 'Select Structural',
  ss: 'Select Structural',
  msr: 'MSR',
  machinestressrated: 'MSR',
  'no1better': '#1 & Better',
  '1better': '#1 & Better',
  '2better': '#2 & Better',
  'no2better': '#2 & Better',
};

export function normalizeGrade(input: string | null | undefined): string {
  if (!input) return '';
  const key = input.toLowerCase().replace(/[^a-z0-9]/g, '');
  return GRADE_ALIAS_MAP[key] ?? input.trim();
}

export const CANONICAL_GRADES = LUMBER_GRADES.map((g) => g.name);

// -----------------------------------------------------------------------------
// Length (as written)
// -----------------------------------------------------------------------------

export function normalizeLength(input: string | null | undefined): string {
  if (!input) return '';
  const trimmed = input.trim();
  // "Random Length", "Rand Lgth", "RL"
  if (/^r(and(om)?)?\s*l(en?g?th?)?$/i.test(trimmed) || /^rl$/i.test(trimmed)) {
    return 'Random Length';
  }
  // "8'", "8 ft", "8ft", "8" → "8"
  const numeric = trimmed.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|foot|feet)?$/i);
  if (numeric) return numeric[1];
  return trimmed;
}

// -----------------------------------------------------------------------------
// Unit
// -----------------------------------------------------------------------------

export type CanonicalUnit = 'PCS' | 'MBF' | 'MSF';

export function normalizeUnit(input: string | null | undefined): CanonicalUnit {
  if (!input) return 'PCS';
  const normalized = input.toLowerCase().replace(/[^a-z]/g, '');
  if (normalized === 'mbf' || normalized === 'thousandbf') return 'MBF';
  if (normalized === 'msf' || normalized === 'thousandsf') return 'MSF';
  if (normalized === 'bf' || normalized === 'boardfeet' || normalized === 'boardfoot') {
    // Plain BF maps to MBF aggregate so the totals add up cleanly.
    return 'MBF';
  }
  return 'PCS';
}

// -----------------------------------------------------------------------------
// Board-foot math
// -----------------------------------------------------------------------------

/**
 * Compute board feet from a dimension token ("2x4"), a length in feet,
 * and a piece quantity. Returns 0 if the inputs don't parse.
 */
export function boardFeetFromDimension(
  dimension: string | null | undefined,
  length: string | null | undefined,
  quantity: number,
): number {
  const dim = parseDimension(dimension);
  if (!dim) return 0;
  const lengthFt = parseLengthFeet(length);
  if (lengthFt === null) return 0;
  return calculateBoardFeet(dim.thickness, dim.width, lengthFt, quantity);
}

function parseLengthFeet(input: string | null | undefined): number | null {
  if (!input) return null;
  const normalized = normalizeLength(input);
  if (normalized === 'Random Length') return 14; // industry average
  const n = Number(normalized);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// -----------------------------------------------------------------------------
// Known-plausible species × grade combinations
// -----------------------------------------------------------------------------

/**
 * Flags combinations that are technically legal but rare in practice, so
 * qa-agent can prompt the trader to double-check before the bid fans out
 * to vendors. Not exhaustive — covers the top few red flags.
 */
export function isUnusualSpeciesGradeCombo(
  species: string,
  grade: string,
): boolean {
  const s = normalizeSpecies(species);
  const g = normalizeGrade(grade);
  if (!s || !g) return false;
  // Panel products don't carry structural grades.
  if ((s === 'OSB' || s === 'Plywood') && g.startsWith('#')) return true;
  if ((s === 'OSB' || s === 'Plywood') && g === 'Stud') return true;
  // SPF Select Structural is technically valid but rarely specified —
  // usually a miskey of "SPF #2 SS combo" or "DF Select Structural".
  if (s === 'SPF' && g === 'Select Structural') return true;
  // LVL doesn't use visual grades.
  if (s === 'LVL' && (g.startsWith('#') || g === 'Stud' || g === 'Select Structural')) {
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Catalog-aware guesses (for routing-agent later)
// -----------------------------------------------------------------------------

export function categoryOfSpecies(species: string): string | null {
  const s = normalizeSpecies(species);
  const match = LUMBER_SPECIES.find(
    (entry) =>
      entry.name.toLowerCase() === s.toLowerCase() ||
      (entry.aliases ?? []).some(
        (alias) => alias.toLowerCase() === s.toLowerCase(),
      ),
  );
  return match?.category ?? null;
}
