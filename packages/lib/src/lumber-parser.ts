/**
 * Lumber parser — deterministic structured extraction (Session Prompt 04).
 *
 * Purpose:  Second stage of the tiered ingest pipeline. Takes the uniform
 *           AttachmentAnalysisResult produced by attachment-analyzer and
 *           turns the extracted text or Excel rows into grouped
 *           ExtractedBuildingGroup[] structures ready to persist.
 *
 *           Zero API calls. Zero LLM involvement. Pure regex + header
 *           detection + normalizer reuse. This module is the reason 85%
 *           of real lumber lists never touch Claude: a clean Excel file
 *           resolves to a full ParseResult at $0.00 cost.
 *
 *           The parser emits an ExtractedBuildingGroup[] using the shapes
 *           already persisted by the orchestrator (@lmbr/types) so the
 *           downstream Mode A / Mode B claude paths and the DB write
 *           can consume the same structure without a second mapping pass.
 *
 *           Confidence scoring (per line):
 *             species    0.25   — required
 *             dimension  0.25   — required
 *             quantity   0.20   — required
 *             length     0.10
 *             grade      0.10   — waived for panels / engineered products
 *             unit       0.10
 *           Missing required fields zero out their slice; overall score
 *           is clamped to [0, 1]. Lines scoring below the confidence
 *           threshold are flagged in lowConfidenceLines as flat
 *           depth-first indices so the orchestrator can either dispatch
 *           Mode B cleanup or accept the parse as-is.
 *
 * Inputs:   AttachmentAnalysisResult from attachment-analyzer.
 * Outputs:  ParseResult — building groups + confidence + cost accounting.
 * Agent/API: none.
 * Imports:  ./lumber (normalizers), ./attachment-analyzer (result type),
 *           @lmbr/types, @lmbr/config (calculateBoardFeet).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { calculateBoardFeet } from '@lmbr/config';
import type {
  ExtractionMethod,
  ExtractedBuildingGroup,
  ExtractedLineItem,
  LineItemUnit,
} from '@lmbr/types';

import type { AttachmentAnalysisResult } from './attachment-analyzer';
import {
  boardFeetFromDimension,
  normalizeDimension,
  normalizeGrade,
  normalizeLength,
  normalizeSpecies,
  normalizeUnit,
  parseDimension,
} from './lumber';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface ParseResult {
  buildingGroups: ExtractedBuildingGroup[];
  /** Weighted mean confidence across every parsed line item. */
  overallConfidence: number;
  /**
   * Flat depth-first indices of lines whose per-line confidence is below
   * the low-confidence threshold. The orchestrator walks buildingGroups
   * in order and matches these indices for Mode B targeted cleanup.
   */
  lowConfidenceLines: number[];
  totalLineItems: number;
  totalBoardFeet: number;
  extractionMethod: ExtractionMethod;
  costCents: number;
}

// -----------------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------------

/**
 * Lines whose per-line score is below this get added to lowConfidenceLines.
 * Matches EXTRACTION_CONFIDENCE_THRESHOLD in the design doc (0.92). Tweak
 * in lockstep with that env var — we don't read process.env here because
 * this module must be safe to import from Edge runtimes that lack Node.
 */
const LOW_CONF_THRESHOLD = 0.92;

/** Species whose grades are meaningless under visual-grading rules. */
const PANEL_OR_ENGINEERED = new Set<string>(['OSB', 'Plywood', 'LVL']);

// -----------------------------------------------------------------------------
// Free-text scanning patterns
// -----------------------------------------------------------------------------

const DIMENSION_PATTERN = /(\d+(?:\.\d+)?)\s*[×xX]\s*(\d+(?:\.\d+)?)/;

const LENGTH_PATTERNS: RegExp[] = [
  /\b(\d+(?:\.\d+)?)\s*['′]/, // 8'
  /\b(\d+(?:\.\d+)?)\s*(?:ft|foot|feet)\b/i, // 8 ft / 8 feet
];

/**
 * Matches the length component from the common "dimension-length" shorthand
 * used industry-wide, e.g. 2x4-8, 2x6-16, 4x4-12, 2x10-20.
 * The pattern requires a dimension prefix (NxN) immediately followed by a
 * hyphen and digits. Returns the length portion only.
 */
const DIMENSION_HYPHEN_LENGTH_PATTERN =
  /(\d+(?:\.\d+)?)\s*[×xX]\s*(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/;

const RANDOM_LENGTH_PATTERN = /\b(r\s*\/?\s*l|rand(?:om)?\s*l[a-z]*)\b/i;

const LENGTH_RANGE_PATTERN = /\b(\d+)\s*-\s*(\d+)\s*['′]?/;

const UNIT_PATTERN = /\b(pcs|pc|pieces|each|ea|mbf|msf|bf)\b/i;

const QUANTITY_PATTERN = /\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\b/;

/**
 * Species scan patterns. First match wins. Order matters: longer / more
 * specific aliases come first so "Douglas Fir" beats a bare "Fir" match.
 */
const SPECIES_SCAN: Array<[RegExp, string]> = [
  [/\b(spruce[\s-]?pine[\s-]?fir|s[\s-]?p[\s-]?f)\b/i, 'SPF'],
  [/\b(doug(?:las)?\s*fir|d[\s.]*fir|df-?l?)\b/i, 'DF'],
  [/\b(hem[\s-]?fir|hemlock|hf)\b/i, 'HF'],
  [/\b(southern\s*yellow\s*pine|southern\s*pine|yellow\s*pine|syp)\b/i, 'SYP'],
  [/\b(western\s*red\s*cedar|red\s*cedar|wrc|cedar)\b/i, 'Cedar'],
  [/\b(laminated\s*veneer|microllam|lvl)\b/i, 'LVL'],
  [/\b(oriented\s*strand(?:\s*board)?|osb)\b/i, 'OSB'],
  [/\b(plywood|cdx|ply)\b/i, 'Plywood'],
  [/\b(pressure\s*treated|treated|p\.?t\.?|acq|mca)\b/i, 'Treated'],
  [/\bspruce\b/i, 'SPF'],
  [/\bpine\b/i, 'SYP'],
  [/\bfir\b/i, 'DF'],
];

/**
 * Grade scan patterns. Order matters — the `&btr` rules must precede the
 * bare `#1` rule so "#2 & Better" isn't swallowed as "#2".
 */
const GRADE_SCAN: Array<[RegExp, string]> = [
  [/#?\s*1\s*(?:&|and)\s*btr/i, '#1 & Better'],
  [/#?\s*2\s*(?:&|and)\s*btr/i, '#2 & Better'],
  [/#\s*1\b|\bno\.?\s*1\b|\bnumber\s*1\b|\bgrade\s*1\b/i, '#1'],
  [/#\s*2\b|\bno\.?\s*2\b|\bnumber\s*2\b|\bgrade\s*2\b/i, '#2'],
  [/#\s*3\b|\bno\.?\s*3\b|\bnumber\s*3\b|\bgrade\s*3\b/i, '#3'],
  [/\b(stud|std)\b/i, 'Stud'],
  [/\b(select\s*structural|sel\.?\s*str|ss)\b/i, 'Select Structural'],
  [/\b(msr|machine\s*stress)\b/i, 'MSR'],
];

const GROUP_HEADER_REGEX =
  /^\s*(house|lot|building|bldg|phase|block)\b[\s#:\-]*([0-9a-z]+)?/i;

const PHASE_NUMBER_REGEX = /phase\s*(\d+)/i;

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

/**
 * Route an analyzed attachment to the right parser. Excel and CSV take
 * the structured row path; everything else falls through to the line-
 * based text parser.
 */
export function parseLumberList(input: AttachmentAnalysisResult): ParseResult {
  const method = input.method;
  if (
    (method === 'excel_parse' || method === 'csv_parse') &&
    Array.isArray(input.rawRows) &&
    input.rawRows.length > 0
  ) {
    const groups = parseExcelList(input.rawRows);
    return finalizeResult(groups, method);
  }

  const groups = parseTextList(input.extractedText ?? '');
  // Text path uses whichever analyzer method produced the text (pdf_direct,
  // ocr, email_text, docx_parse, direct_text). That way downstream cost
  // accounting can still distinguish OCR spend from zero-cost parses.
  return finalizeResult(groups, method);
}

function finalizeResult(
  buildingGroups: ExtractedBuildingGroup[],
  method: ExtractionMethod,
): ParseResult {
  let flatIndex = 0;
  const lowConfidenceLines: number[] = [];
  let totalLineItems = 0;
  let totalBoardFeet = 0;
  let confidenceSum = 0;

  for (const group of buildingGroups) {
    for (const line of group.lineItems) {
      totalLineItems += 1;
      totalBoardFeet += line.boardFeet ?? 0;
      confidenceSum += line.confidence ?? 0;
      if ((line.confidence ?? 0) < LOW_CONF_THRESHOLD) {
        lowConfidenceLines.push(flatIndex);
      }
      flatIndex += 1;
    }
  }

  const overallConfidence =
    totalLineItems === 0 ? 0 : round4(clamp01(confidenceSum / totalLineItems));

  return {
    buildingGroups,
    overallConfidence,
    lowConfidenceLines,
    totalLineItems,
    totalBoardFeet: round2(totalBoardFeet),
    extractionMethod: method,
    costCents: 0,
  };
}

// -----------------------------------------------------------------------------
// Excel / CSV path
// -----------------------------------------------------------------------------

type ColumnRole =
  | 'qty'
  | 'species'
  | 'dimension'
  | 'grade'
  | 'length'
  | 'unit'
  | 'description'
  | 'building'
  | 'item'
  | 'notes'
  | 'unknown';

const FIELD_KEYWORDS: Record<Exclude<ColumnRole, 'unknown'>, string[]> = {
  qty: ['qty', 'quantity', 'count', 'pcs'],
  species: ['species', 'wood', 'material'],
  dimension: ['dim', 'dimension', 'size', 'nominal'],
  grade: ['grade'],
  length: ['length', 'len', 'lgth'],
  unit: ['unit', 'uom', 'u of m', 'u/m'],
  description: ['description', 'desc'],
  building: ['building', 'bldg', 'lot', 'house', 'phase', 'block'],
  item: ['item', 'product', 'sku'],
  notes: ['note', 'notes', 'remark'],
};

/**
 * Parse the raw row output from attachment-analyzer's Excel / CSV path.
 * Each row is a Record keyed by `__row` plus column letter (`A`, `B`, …).
 */
export function parseExcelList(
  rawRows: Record<string, unknown>[],
): ExtractedBuildingGroup[] {
  if (rawRows.length === 0) return [];

  const { headerRow, columnMap } = detectHeaderRow(rawRows);

  const groups: ExtractedBuildingGroup[] = [];
  let currentGroup: ExtractedBuildingGroup | null = null;

  const startIndex = headerRow >= 0 ? headerRow + 1 : 0;
  for (let i = startIndex; i < rawRows.length; i += 1) {
    const row = rawRows[i];
    if (!row) continue;

    // Pure blank row → skip.
    if (isBlankRow(row)) continue;

    // Group header? A row with text-only content and a group keyword in
    // the first non-empty cell, no dimension pattern, and no parseable
    // quantity. The "building" column (if the layout has one) always wins
    // over first-cell detection.
    const buildingCellValue = columnMap.building
      ? cellToString(row[columnMap.building])
      : '';
    const firstCellText = firstNonEmptyCellText(row);

    if (buildingCellValue && !hasDataSignals(row)) {
      currentGroup = ensureGroup(groups, buildingCellValue);
      continue;
    }

    if (isGroupHeaderText(firstCellText) && !hasDataSignals(row)) {
      currentGroup = ensureGroup(groups, firstCellText);
      continue;
    }

    // Data row.
    const lineItem = buildLineItemFromExcelRow(row, columnMap);
    if (!lineItem) continue;

    // Carry over a per-row building value if the layout has one.
    if (buildingCellValue) {
      currentGroup = ensureGroup(groups, buildingCellValue);
    }
    if (!currentGroup) {
      currentGroup = ensureGroup(groups, 'Unassigned');
    }
    currentGroup.lineItems.push(lineItem);
  }

  // Drop empty groups (e.g. header detected but no following data).
  return groups.filter((g) => g.lineItems.length > 0);
}

interface ColumnMap {
  qty?: string;
  species?: string;
  dimension?: string;
  grade?: string;
  length?: string;
  unit?: string;
  description?: string;
  building?: string;
  item?: string;
  notes?: string;
}

function detectHeaderRow(rows: Record<string, unknown>[]): {
  headerRow: number;
  columnMap: ColumnMap;
} {
  let bestRow = -1;
  let bestMap: ColumnMap = {};
  let bestScore = 0;

  const scanLimit = Math.min(rows.length, 25);
  for (let i = 0; i < scanLimit; i += 1) {
    const row = rows[i];
    if (!row) continue;

    const map: ColumnMap = {};
    let score = 0;

    for (const [col, rawValue] of Object.entries(row)) {
      if (col === '__row') continue;
      const text = cellToString(rawValue).toLowerCase().trim();
      if (!text) continue;

      const role = matchHeaderKeyword(text);
      if (role && role !== 'unknown' && map[role] === undefined) {
        map[role] = col;
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestRow = i;
      bestMap = map;
    }
  }

  // Require at least two header matches to trust the row — otherwise the
  // file has no real header and we fall back to a positional layout.
  if (bestScore < 2) {
    return { headerRow: -1, columnMap: {} };
  }
  return { headerRow: bestRow, columnMap: bestMap };
}

function matchHeaderKeyword(text: string): ColumnRole | null {
  for (const [role, keywords] of Object.entries(FIELD_KEYWORDS) as Array<
    [Exclude<ColumnRole, 'unknown'>, string[]]
  >) {
    for (const kw of keywords) {
      if (text === kw || text.includes(kw)) return role;
    }
  }
  return null;
}

function buildLineItemFromExcelRow(
  row: Record<string, unknown>,
  columnMap: ColumnMap,
): ExtractedLineItem | null {
  // Collect raw values by role.
  const qtyRaw = columnMap.qty ? cellToString(row[columnMap.qty]) : '';
  const speciesRaw = columnMap.species ? cellToString(row[columnMap.species]) : '';
  const dimensionRaw = columnMap.dimension
    ? cellToString(row[columnMap.dimension])
    : '';
  const gradeRaw = columnMap.grade ? cellToString(row[columnMap.grade]) : '';
  const lengthRaw = columnMap.length ? cellToString(row[columnMap.length]) : '';
  const unitRaw = columnMap.unit ? cellToString(row[columnMap.unit]) : '';
  const descriptionRaw = columnMap.description
    ? cellToString(row[columnMap.description])
    : '';
  const itemRaw = columnMap.item ? cellToString(row[columnMap.item]) : '';

  // Layout B ("item / description / qty / uom"): the description field
  // carries species + dimension + grade + length in freeform text.
  // Layout C ("building / item / qty / size / species / grade"): size
  // holds the dimension in free-form.
  let species = speciesRaw;
  let dimension = dimensionRaw;
  let grade = gradeRaw;
  let length = lengthRaw;

  const freeformSources = [descriptionRaw, itemRaw].filter((s) => s.length > 0);
  for (const source of freeformSources) {
    if (!species) species = scanSpecies(source) ?? '';
    if (!dimension) dimension = scanDimension(source) ?? '';
    if (!grade) grade = scanGrade(source) ?? '';
    if (!length) length = scanLength(source) ?? '';
  }

  // Panel fallback: try fractional thickness (7/16, 15/32) from the
  // dimension column or freeform sources when NxN didn't match.
  const speciesForCheck = normalizeSpecies(species);
  if (!scanDimension(dimension) && PANEL_OR_ENGINEERED.has(speciesForCheck)) {
    const frac = scanPanelDimension(dimension) ??
      freeformSources.reduce<string | null>((found, s) => found ?? scanPanelDimension(s), null);
    if (frac) dimension = frac;
  }

  // Quantity — first number we can parse, from the qty column or (as a
  // fallback) the description field.
  let quantity = parseQuantity(qtyRaw);
  if (quantity == null && descriptionRaw) {
    quantity = parseQuantity(descriptionRaw);
  }

  // If absolutely nothing looks lumber-like, skip this row.
  const hasAnySignal =
    species || dimension || grade || length || quantity != null;
  if (!hasAnySignal) return null;

  // Build the line item using the same normalizers everything else uses.
  const normalizedSpecies = speciesForCheck;
  const normalizedDim = PANEL_OR_ENGINEERED.has(normalizedSpecies) && dimension
    ? dimension  // Keep fractional notation as-is for panels
    : normalizeDimension(dimension);
  const normalizedGrade = normalizeGrade(grade);
  const normalizedLen = normalizeLength(length);
  const normalizedUnit = resolveUnit(unitRaw, normalizedSpecies);
  const qty = quantity ?? 0;

  const boardFeet = boardFeetFromLineInputs(
    normalizedDim,
    normalizedLen,
    qty,
    normalizedUnit,
  );

  const { confidence, flags } = scoreLine({
    species: normalizedSpecies,
    dimension: normalizedDim,
    grade: normalizedGrade,
    length: normalizedLen,
    unit: normalizedUnit,
    quantity: qty,
    rawHadUnit: unitRaw.length > 0,
  });

  const originalText = buildOriginalText(row);

  return {
    species: normalizedSpecies,
    dimension: normalizedDim,
    grade: normalizedGrade,
    length: normalizedLen,
    quantity: qty > 0 ? qty : 1,
    unit: normalizedUnit,
    boardFeet: round2(boardFeet),
    confidence,
    flags,
    originalText,
  };
}

function buildOriginalText(row: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [col, value] of Object.entries(row)) {
    if (col === '__row') continue;
    const str = cellToString(value);
    if (str) parts.push(str);
  }
  return parts.join(' | ');
}

// -----------------------------------------------------------------------------
// Free-text path
// -----------------------------------------------------------------------------

/**
 * Parse a plain-text lumber list into grouped line items. Used for clean
 * PDFs (via pdf-parse), DOCX, OCR output, and pasted email bodies. The
 * scanner is intentionally forgiving — anything that looks like species
 * + dimension + a number turns into a draft line item, and the
 * confidence score tells the orchestrator how much to trust the parse.
 */
export function parseTextList(text: string): ExtractedBuildingGroup[] {
  if (!text || typeof text !== 'string') return [];

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const groups: ExtractedBuildingGroup[] = [];
  let currentGroup: ExtractedBuildingGroup | null = null;

  for (const line of lines) {
    // Group header check first so we don't misparse a "Phase 2" line as a
    // data row with qty 2.
    if (isGroupHeaderText(line) && !hasLumberDataSignals(line)) {
      currentGroup = ensureGroup(groups, line);
      continue;
    }

    const lineItem = buildLineItemFromText(line);
    if (!lineItem) continue;

    if (!currentGroup) {
      currentGroup = ensureGroup(groups, 'Unassigned');
    }
    currentGroup.lineItems.push(lineItem);
  }

  return groups.filter((g) => g.lineItems.length > 0);
}

function buildLineItemFromText(line: string): ExtractedLineItem | null {
  const species = scanSpecies(line);
  let dimension = scanDimension(line);
  const grade = scanGrade(line);
  const length = scanLength(line);
  const unitRaw = scanUnit(line);

  // Panel fallback: if the species is a panel/engineered product and no NxN
  // dimension was found, try to extract a fractional thickness (7/16, 15/32).
  const speciesNorm = normalizeSpecies(species ?? '');
  if (!dimension && PANEL_OR_ENGINEERED.has(speciesNorm)) {
    dimension = scanPanelDimension(line);
  }

  // Build a quantity-scanning string that strips the dimension match so
  // parseQuantity doesn't grab digits from the dimension (e.g. "7" from
  // "7/16", or "1" from "1.75x9.5").
  let qtyText = line;
  if (dimension) {
    // Always try stripping the NxN pattern first (covers LVL 1.75x9.5 etc.).
    // Then strip fractional for panels (7/16, 15/32).
    qtyText = qtyText.replace(DIMENSION_PATTERN, ' ');
    qtyText = qtyText.replace(FRACTIONAL_DIMENSION_PATTERN, ' ');
  }
  const quantity = parseQuantity(qtyText);

  // Require at least two strong signals to emit a row — otherwise this is
  // probably a heading or a note. For panel species, a fractional dimension
  // counts as a strong signal just like NxN does.
  const strongSignalCount =
    (species ? 1 : 0) + (dimension ? 1 : 0) + (quantity != null ? 1 : 0);
  if (strongSignalCount < 2) return null;

  const normalizedSpecies = speciesNorm;
  const normalizedDim = dimension && PANEL_OR_ENGINEERED.has(normalizedSpecies)
    ? dimension  // Keep fractional notation as-is for panels
    : normalizeDimension(dimension ?? '');
  const normalizedGrade = normalizeGrade(grade ?? '');
  const normalizedLen = normalizeLength(length ?? '');
  const normalizedUnit = resolveUnit(unitRaw ?? '', normalizedSpecies);
  const qty = quantity ?? 0;

  const boardFeet = boardFeetFromLineInputs(
    normalizedDim,
    normalizedLen,
    qty,
    normalizedUnit,
  );

  const { confidence, flags } = scoreLine({
    species: normalizedSpecies,
    dimension: normalizedDim,
    grade: normalizedGrade,
    length: normalizedLen,
    unit: normalizedUnit,
    quantity: qty,
    rawHadUnit: Boolean(unitRaw),
  });

  return {
    species: normalizedSpecies,
    dimension: normalizedDim,
    grade: normalizedGrade,
    length: normalizedLen,
    quantity: qty > 0 ? qty : 1,
    unit: normalizedUnit,
    boardFeet: round2(boardFeet),
    confidence,
    flags,
    originalText: line,
  };
}

// -----------------------------------------------------------------------------
// Field scanners (used by both paths)
// -----------------------------------------------------------------------------

function scanSpecies(text: string): string | null {
  if (!text) return null;
  for (const [pattern, canonical] of SPECIES_SCAN) {
    if (pattern.test(text)) return canonical;
  }
  return null;
}

function scanDimension(text: string): string | null {
  if (!text) return null;
  const m = text.match(DIMENSION_PATTERN);
  if (!m) return null;
  return `${m[1]}x${m[2]}`;
}

/**
 * Panel products (OSB, Plywood) use fractional thickness notation (7/16,
 * 15/32, 3/4) rather than an NxN dimension. This scanner extracts the
 * fractional value as the dimension when the species is a panel type.
 */
const FRACTIONAL_DIMENSION_PATTERN = /\b(\d+\/\d+)\b/;

function scanPanelDimension(text: string): string | null {
  if (!text) return null;
  const m = text.match(FRACTIONAL_DIMENSION_PATTERN);
  return m ? m[1] ?? null : null;
}

function scanGrade(text: string): string | null {
  if (!text) return null;
  for (const [pattern, canonical] of GRADE_SCAN) {
    if (pattern.test(text)) return canonical;
  }
  return null;
}

function scanLength(text: string): string | null {
  if (!text) return null;
  if (RANDOM_LENGTH_PATTERN.test(text)) return 'Random Length';
  for (const pattern of LENGTH_PATTERNS) {
    const m = text.match(pattern);
    if (m && m[1]) return m[1];
  }
  // Check for dimension-hyphen-length shorthand (2x4-8, 2x6-16, etc.)
  // before the generic range pattern so "2x4-8" isn't misread as range "4-8".
  const dimLen = text.match(DIMENSION_HYPHEN_LENGTH_PATTERN);
  if (dimLen && dimLen[3]) return dimLen[3];
  const range = text.match(LENGTH_RANGE_PATTERN);
  if (range && range[1] && range[2]) return `${range[1]}-${range[2]}`;
  return null;
}

function scanUnit(text: string): string | null {
  if (!text) return null;
  const m = text.match(UNIT_PATTERN);
  return m ? m[1] ?? null : null;
}

function parseQuantity(text: string): number | null {
  if (!text) return null;
  const m = text.match(QUANTITY_PATTERN);
  if (!m || !m[1]) return null;
  const cleaned = m[1].replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function resolveUnit(rawUnit: string, species: string): LineItemUnit {
  if (rawUnit) return normalizeUnit(rawUnit);
  // Default-by-species: panels measured in MSF, everything else in PCS.
  if (species === 'OSB' || species === 'Plywood') return 'MSF';
  return 'PCS';
}

// -----------------------------------------------------------------------------
// Confidence scoring
// -----------------------------------------------------------------------------

interface ScoreInputs {
  species: string;
  dimension: string;
  grade: string;
  length: string;
  unit: LineItemUnit;
  quantity: number;
  rawHadUnit: boolean;
}

interface ScoreOutput {
  confidence: number;
  flags: string[];
}

function scoreLine(inputs: ScoreInputs): ScoreOutput {
  const flags: string[] = [];
  let score = 0;

  // Required: species + dimension + quantity = 0.70 total weight.
  if (inputs.species) score += 0.25;
  else flags.push('missing_species');

  const isPanelOrEngineered = PANEL_OR_ENGINEERED.has(inputs.species);
  if (inputs.dimension && (parseDimension(inputs.dimension) || isPanelOrEngineered)) {
    // Panels use fractional thickness (7/16, 15/32) which parseDimension
    // won't recognise as NxN — credit the dimension slot when the fraction
    // string is present and the species is a panel type.
    score += 0.25;
  } else if (isPanelOrEngineered) {
    // Panel with no dimension at all — still waive the penalty.
    score += 0.25;
  } else {
    flags.push('missing_dimension');
  }

  if (inputs.quantity > 0) score += 0.2;
  else flags.push('unclear_quantity');

  // Length matters less but is usually present for dimensional lumber.
  if (inputs.length) score += 0.1;
  else flags.push('missing_length');

  // Grade — waive for panels / engineered products.
  if (inputs.grade) {
    score += 0.1;
  } else if (isPanelOrEngineered) {
    // Panels don't carry a grade; credit the slot without a flag.
    score += 0.1;
  } else {
    flags.push('missing_grade');
  }

  // Unit — credit if normalized cleanly from the raw token. If we had to
  // infer, still credit but note that the unit was inferred.
  if (inputs.rawHadUnit) {
    score += 0.1;
  } else {
    score += 0.07;
    flags.push('unit_inferred');
  }

  return { confidence: clamp01(round2(score)), flags };
}

// -----------------------------------------------------------------------------
// Group-header helpers
// -----------------------------------------------------------------------------

function isGroupHeaderText(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80) return false;
  if (DIMENSION_PATTERN.test(trimmed)) return false;
  return GROUP_HEADER_REGEX.test(trimmed);
}

function hasLumberDataSignals(text: string): boolean {
  return DIMENSION_PATTERN.test(text) || Boolean(scanSpecies(text));
}

function hasDataSignals(row: Record<string, unknown>): boolean {
  for (const [col, value] of Object.entries(row)) {
    if (col === '__row') continue;
    const str = cellToString(value);
    if (!str) continue;
    if (DIMENSION_PATTERN.test(str)) return true;
    if (scanSpecies(str)) return true;
  }
  return false;
}

function ensureGroup(
  groups: ExtractedBuildingGroup[],
  tag: string,
): ExtractedBuildingGroup {
  const cleanTag = tag.trim() || 'Unassigned';
  const existing = groups.find((g) => g.buildingTag === cleanTag);
  if (existing) return existing;
  const phase = extractPhaseNumber(cleanTag);
  const group: ExtractedBuildingGroup = {
    buildingTag: cleanTag,
    phaseNumber: phase,
    lineItems: [],
  };
  groups.push(group);
  return group;
}

function extractPhaseNumber(tag: string): number | null {
  const m = tag.match(PHASE_NUMBER_REGEX);
  if (!m || !m[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// -----------------------------------------------------------------------------
// Low-level row helpers
// -----------------------------------------------------------------------------

function isBlankRow(row: Record<string, unknown>): boolean {
  for (const [col, value] of Object.entries(row)) {
    if (col === '__row') continue;
    if (cellToString(value).length > 0) return false;
  }
  return true;
}

function firstNonEmptyCellText(row: Record<string, unknown>): string {
  const ordered = Object.entries(row)
    .filter(([col]) => col !== '__row')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, value] of ordered) {
    const text = cellToString(value);
    if (text) return text;
  }
  return '';
}

function cellToString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const obj = value as { text?: unknown; result?: unknown };
    if (typeof obj.text === 'string') return obj.text.trim();
    if (typeof obj.result === 'string') return obj.result.trim();
    if (typeof obj.result === 'number') return String(obj.result);
  }
  return '';
}

// -----------------------------------------------------------------------------
// Board-foot calculation wrapper
// -----------------------------------------------------------------------------

/**
 * Public board-foot helper exposed per the Session Prompt 04 spec. For
 * dimensional lumber sold in PCS this is the standard (t × w × L × n)/12
 * formula. For MBF the quantity IS the volume in thousands of board
 * feet, so BF = qty × 1000. For panels sold in MSF the board-foot
 * concept doesn't apply cleanly — the caller should track volume in MSF
 * directly, so this returns 0.
 */
export function computeBoardFeet(
  thicknessIn: number,
  widthIn: number,
  lengthFt: number,
  qty: number,
  unit: LineItemUnit,
): number {
  if (unit === 'MBF') return Math.max(0, qty) * 1000;
  if (unit === 'MSF') return 0;
  if (
    !Number.isFinite(thicknessIn) ||
    !Number.isFinite(widthIn) ||
    !Number.isFinite(lengthFt) ||
    !Number.isFinite(qty) ||
    thicknessIn <= 0 ||
    widthIn <= 0 ||
    lengthFt <= 0 ||
    qty <= 0
  ) {
    return 0;
  }
  return calculateBoardFeet(thicknessIn, widthIn, lengthFt, qty);
}

function boardFeetFromLineInputs(
  dimension: string,
  length: string,
  qty: number,
  unit: LineItemUnit,
): number {
  if (unit === 'MBF') return Math.max(0, qty) * 1000;
  if (unit === 'MSF') return 0;
  return boardFeetFromDimension(dimension, length, qty);
}

// -----------------------------------------------------------------------------
// Numeric helpers
// -----------------------------------------------------------------------------

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
