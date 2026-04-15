/**
 * Lumber commodity catalog — species, dimensions, grades, board-foot math.
 *
 * Purpose:  Canonical reference data for the LMBR.ai platform. Every
 *           line-item extraction, consolidation key, vendor capability tag,
 *           and market-intel ticker row is grounded in this catalog. The
 *           `calculateBoardFeet` helper is the authoritative volume formula
 *           used by pricing-agent and the budget-quote fast-path.
 * Inputs:   none — declarative + one pure function.
 * Outputs:  LUMBER_SPECIES, STANDARD_DIMENSIONS, LUMBER_GRADES,
 *           calculateBoardFeet.
 * Agent/API: consumed by @lmbr/agents/extraction-agent,
 *            @lmbr/agents/qa-agent, @lmbr/agents/pricing-agent.
 * Imports:  none (pure data + math).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

export type LumberCategory = 'softwood' | 'engineered' | 'panel' | 'treated';

export interface LumberSpecies {
  id: string;
  name: string;
  category: LumberCategory;
  aliases?: readonly string[];
}

export const LUMBER_SPECIES: readonly LumberSpecies[] = [
  {
    id: 'df',
    name: 'Douglas Fir',
    category: 'softwood',
    aliases: ['DF', 'Doug Fir', 'DF-L', 'Douglas-Fir'],
  },
  {
    id: 'hf',
    name: 'Hem-Fir',
    category: 'softwood',
    aliases: ['HF', 'Hem Fir'],
  },
  {
    id: 'spf',
    name: 'SPF',
    category: 'softwood',
    aliases: ['Spruce-Pine-Fir', 'SPF-S', 'Spruce Pine Fir'],
  },
  {
    id: 'syp',
    name: 'Southern Yellow Pine',
    category: 'softwood',
    aliases: ['SYP', 'Yellow Pine', 'Southern Pine'],
  },
  {
    id: 'cedar',
    name: 'Cedar',
    category: 'softwood',
    aliases: ['Western Red Cedar', 'WRC', 'Cedar WRC'],
  },
  {
    id: 'lvl',
    name: 'LVL',
    category: 'engineered',
    aliases: ['Laminated Veneer Lumber', 'Microllam'],
  },
  {
    id: 'osb',
    name: 'OSB',
    category: 'panel',
    aliases: ['Oriented Strand Board'],
  },
  {
    id: 'ply',
    name: 'Plywood',
    category: 'panel',
    aliases: ['CDX', 'Sheathing Plywood'],
  },
  {
    id: 'treated',
    name: 'Pressure Treated',
    category: 'treated',
    aliases: ['PT', 'Treated', 'ACQ', 'MCA'],
  },
];

export interface StandardDimension {
  id: string;
  nominalThicknessIn: number;
  nominalWidthIn: number;
  actualThicknessIn: number;
  actualWidthIn: number;
  label: string;
}

/**
 * Actual (S4S) dimensions per US softwood lumber standard PS 20.
 * 1x: actual 0.75"; 2x: actual 1.5"; 4x: actual 3.5"; 6x: actual 5.5".
 * Widths: nominal - 0.5" under 8", nominal - 0.75" at 8"+.
 */
export const STANDARD_DIMENSIONS: readonly StandardDimension[] = [
  { id: '1x4', nominalThicknessIn: 1, nominalWidthIn: 4, actualThicknessIn: 0.75, actualWidthIn: 3.5, label: '1x4' },
  { id: '1x6', nominalThicknessIn: 1, nominalWidthIn: 6, actualThicknessIn: 0.75, actualWidthIn: 5.5, label: '1x6' },
  { id: '2x4', nominalThicknessIn: 2, nominalWidthIn: 4, actualThicknessIn: 1.5, actualWidthIn: 3.5, label: '2x4' },
  { id: '2x6', nominalThicknessIn: 2, nominalWidthIn: 6, actualThicknessIn: 1.5, actualWidthIn: 5.5, label: '2x6' },
  { id: '2x8', nominalThicknessIn: 2, nominalWidthIn: 8, actualThicknessIn: 1.5, actualWidthIn: 7.25, label: '2x8' },
  { id: '2x10', nominalThicknessIn: 2, nominalWidthIn: 10, actualThicknessIn: 1.5, actualWidthIn: 9.25, label: '2x10' },
  { id: '2x12', nominalThicknessIn: 2, nominalWidthIn: 12, actualThicknessIn: 1.5, actualWidthIn: 11.25, label: '2x12' },
  { id: '4x4', nominalThicknessIn: 4, nominalWidthIn: 4, actualThicknessIn: 3.5, actualWidthIn: 3.5, label: '4x4' },
  { id: '4x6', nominalThicknessIn: 4, nominalWidthIn: 6, actualThicknessIn: 3.5, actualWidthIn: 5.5, label: '4x6' },
  { id: '6x6', nominalThicknessIn: 6, nominalWidthIn: 6, actualThicknessIn: 5.5, actualWidthIn: 5.5, label: '6x6' },
];

export interface LumberGrade {
  id: string;
  name: string;
  description: string;
}

export const LUMBER_GRADES: readonly LumberGrade[] = [
  { id: 'no1', name: '#1', description: 'No. 1 — structural, tight knots, limited wane' },
  { id: 'no2', name: '#2', description: 'No. 2 — standard framing grade' },
  { id: 'no3', name: '#3', description: 'No. 3 — utility framing, more defects allowed' },
  { id: 'stud', name: 'Stud', description: 'Stud grade — optimized for vertical framing' },
  { id: 'ss', name: 'Select Structural', description: 'Select Structural — highest visually-graded' },
  { id: 'msr', name: 'MSR', description: 'Machine Stress Rated — mechanically graded' },
];

/**
 * Board-foot volume formula.
 *
 * BF = (thickness_in * width_in * length_ft * quantity) / 12
 *
 * Uses NOMINAL dimensions per US lumber industry convention.
 */
export function calculateBoardFeet(
  thicknessIn: number,
  widthIn: number,
  lengthFt: number,
  quantity: number,
): number {
  return (thicknessIn * widthIn * lengthFt * quantity) / 12;
}
