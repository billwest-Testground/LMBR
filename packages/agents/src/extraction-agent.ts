/**
 * Extraction agent — raw lumber list → structured ExtractionOutput.
 *
 * Purpose:  The most critical AI call in the LMBR.ai pipeline. Takes a
 *           customer RFQ in any of the supported forms (PDF, image,
 *           Excel-derived text, plain email text) and returns a fully
 *           structured, per-line, per-building set of lumber items ready
 *           to be written to public.line_items. Downstream agents
 *           (routing, comparison, pricing, consolidation) depend on
 *           this output being clean and faithful — if extraction slips,
 *           every later step slips with it.
 *
 *           Implementation:
 *           - Single Claude Sonnet 4.6 call via tool_use with a forced
 *             extract_lumber_list tool so the model can never return
 *             malformed JSON.
 *           - Building/phase structure is preserved verbatim. The
 *             system prompt hammers "NEVER consolidate building breaks"
 *             because hybrid mode depends on the source mapping.
 *           - Every line item is re-normalized post-model
 *             (species / dimension / grade / length / unit) and the
 *             board_feet column is recomputed locally so we don't trust
 *             the model's arithmetic — only its interpretation.
 *
 * Inputs:   { fileBytes?, mimeType?, rawText?, fileName? }.
 * Outputs:  ExtractionOutput (@lmbr/types).
 * Agent/API: Anthropic Claude (tool_use, forced tool_choice).
 * Imports:  @lmbr/lib (getAnthropic, lumber normalizers),
 *           @lmbr/types (ExtractionOutput).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import {
  getAnthropic,
  LMBR_DEFAULT_MODEL,
  normalizeSpecies,
  normalizeDimension,
  normalizeGrade,
  normalizeLength,
  normalizeUnit,
  boardFeetFromDimension,
} from '@lmbr/lib';
import type {
  ExtractionOutput,
  ExtractedBuildingGroup,
  ExtractedLineItem,
} from '@lmbr/types';

/**
 * Minimal local shape for an Anthropic tool definition. We intentionally
 * avoid importing the SDK's namespaced types (`Anthropic.Messages.Tool`)
 * because their exported path has shifted between SDK versions and
 * breaking TypeScript on an SDK bump is worse than a tiny local type.
 * This shape is structurally compatible with what messages.create()
 * accepts under @anthropic-ai/sdk v0.27+.
 */
interface LocalTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

// -----------------------------------------------------------------------------
// System prompt
// -----------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You are an expert lumber list extraction agent with deep knowledge of softwood lumber species, dimensions, grades, and industry terminology. Your job is to extract structured line items from raw lumber lists that arrive in PDFs, Excel exports, forwarded emails, and photographed/scanned paper takeoffs.

For each line item extract:
- building_tag: the house, building, lot, or phase header this item falls under. PRESERVE the tag exactly as written in the source document — if the list says "House 1" or "Building A" or "Lot 7" use that string verbatim.
- phase_number: integer if the source mentions a specific phase ("Phase 2", "Phase II"), otherwise null.
- species: normalize to one of these canonical tokens: SPF, DF, HF, SYP, Cedar, LVL, OSB, Plywood, Treated. "Fir" alone is ambiguous — flag it and guess DF unless context suggests otherwise.
- dimension: normalize to standard format like 2x4, 2x6, 2x8, 2x10, 2x12, 4x4, 4x6, 6x6, 1x4, 1x6, 1x8.
- grade: normalize to #1, #2, #3, Stud, Select Structural, MSR, or as-written for panel/engineered products.
- length: in feet as written (8, 10, 12, 14, 16, 18, 20, 24, or "Random Length").
- quantity: numeric.
- unit: PCS, MBF, or MSF. Infer from context if not stated (loose pieces → PCS, volume totals → MBF, panels → MSF).
- board_feet: compute as (thickness × width × length × quantity) / 12 for dimensional lumber. For panels or pieces where the formula doesn't apply, use 0.
- confidence: 0.0–1.0 score for how sure you are about THIS specific line. 1.0 = unambiguous, 0.5 = partial guess, < 0.5 = heavily uncertain.
- flags: array of strings from this vocabulary: ambiguous_species, missing_grade, unclear_quantity, unusual_dimension, possible_duplicate, non_standard_length, unit_inferred, engineered_without_grade.
- original_text: the raw source line you extracted this from — verbatim.

CRITICAL RULES:
1. NEVER consolidate building / phase breaks. If the list shows "House 1" with 40 lines, then "House 2" with 40 lines, those are TWO separate building_groups. Do not merge them under a single tag even if the quantities look similar.
2. If a species abbreviation is ambiguous (e.g. "Fir" could be DF or HF), flag it with ambiguous_species and make your best guess based on regional context or surrounding lines.
3. If a quantity seems unusually high or low for the dimension (e.g. 50000 PCS of 2x12), flag unclear_quantity.
4. Preserve all notes and special callouts from the original list in the original_text field.
5. Output ONLY the extract_lumber_list tool call with valid JSON input. No prose, no commentary, no explanation.

Your output will be validated against a strict JSON schema. The tool_use input is the only thing you return.`;

// -----------------------------------------------------------------------------
// Tool schema — forces strict JSON output
// -----------------------------------------------------------------------------

const EXTRACTION_TOOL: LocalTool = {
  name: 'extract_lumber_list',
  description:
    'Emit the fully structured extraction result for the lumber list. Call this tool exactly once with the complete result.',
  input_schema: {
    type: 'object',
    properties: {
      extraction_confidence: {
        type: 'number',
        description: 'Overall confidence for the whole list, 0.0 to 1.0.',
      },
      building_groups: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            building_tag: {
              type: 'string',
              description:
                'House/building/lot/phase header preserved verbatim from the source document.',
            },
            phase_number: {
              type: ['integer', 'null'],
            },
            line_items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  species: { type: 'string' },
                  dimension: { type: 'string' },
                  grade: { type: 'string' },
                  length: { type: 'string' },
                  quantity: { type: 'number' },
                  unit: {
                    type: 'string',
                    enum: ['PCS', 'MBF', 'MSF'],
                  },
                  board_feet: { type: 'number' },
                  confidence: { type: 'number' },
                  flags: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  original_text: { type: 'string' },
                },
                required: [
                  'species',
                  'dimension',
                  'grade',
                  'length',
                  'quantity',
                  'unit',
                  'board_feet',
                  'confidence',
                  'flags',
                  'original_text',
                ],
              },
            },
          },
          required: ['building_tag', 'phase_number', 'line_items'],
        },
      },
      total_line_items: { type: 'integer' },
      total_board_feet: { type: 'number' },
      flags_requiring_review: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: [
      'extraction_confidence',
      'building_groups',
      'total_line_items',
      'total_board_feet',
      'flags_requiring_review',
    ],
  },
};

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

export interface ExtractionInput {
  /** Raw bytes of the source file for PDF / image paths. */
  fileBytes?: Uint8Array;
  /** MIME type of fileBytes when present. */
  mimeType?: string;
  /** Pre-extracted text (Excel converted, email body, pasted text). */
  rawText?: string;
  /** Source file name, shown to the model for context. */
  fileName?: string;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

export async function extractionAgent(
  input: ExtractionInput,
): Promise<ExtractionOutput> {
  if (!input.rawText && !input.fileBytes) {
    throw new Error(
      'extractionAgent: must supply either rawText or fileBytes',
    );
  }

  const anthropic = getAnthropic();
  const userContent = buildUserContent(input);

  const response = await anthropic.messages.create({
    model: LMBR_DEFAULT_MODEL,
    max_tokens: 8192,
    system: EXTRACTION_SYSTEM_PROMPT,
    // Cast to the SDK-expected shape. Our LocalTool is structurally
    // compatible but avoids depending on the SDK's namespaced type path.
    tools: [EXTRACTION_TOOL] as never,
    tool_choice: { type: 'tool', name: EXTRACTION_TOOL.name } as never,
    messages: [
      {
        role: 'user',
        content: userContent as never,
      },
    ],
  });

  // Find the tool_use block in the response.
  type ResponseBlock =
    | { type: 'text'; text: string }
    | {
        type: 'tool_use';
        id: string;
        name: string;
        input: unknown;
      }
    | { type: string; [key: string]: unknown };

  const blocks = response.content as ResponseBlock[];
  const toolUse = blocks.find(
    (block): block is Extract<ResponseBlock, { type: 'tool_use' }> =>
      block.type === 'tool_use' && block.name === EXTRACTION_TOOL.name,
  );

  if (!toolUse) {
    // Log the raw response so we can see what Claude returned instead.
    console.error('[extraction-agent] no tool_use block found', {
      stopReason: response.stop_reason,
      blockTypes: blocks.map((b) => b.type),
      blocks: JSON.stringify(blocks).slice(0, 2000),
    });
    throw new Error(
      'extractionAgent: Claude did not invoke extract_lumber_list tool',
    );
  }

  const raw = toolUse.input as RawExtractionResult;

  console.log('[extraction-agent] tool_use.input summary', {
    extraction_confidence: raw.extraction_confidence,
    building_groups_count: Array.isArray(raw.building_groups)
      ? raw.building_groups.length
      : 'NOT_ARRAY',
    first_group_tag: raw.building_groups?.[0]?.building_tag ?? 'none',
    first_group_line_count: raw.building_groups?.[0]?.line_items?.length ?? 0,
    total_line_items: raw.total_line_items,
    total_board_feet: raw.total_board_feet,
  });

  return postProcess(raw);
}

// -----------------------------------------------------------------------------
// Content-block builder
// -----------------------------------------------------------------------------

type UserBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    }
  | {
      type: 'document';
      source: { type: 'base64'; media_type: 'application/pdf'; data: string };
    };

function buildUserContent(input: ExtractionInput): UserBlock[] {
  const blocks: UserBlock[] = [];

  if (input.fileBytes && input.mimeType) {
    const base64 = bytesToBase64(input.fileBytes);
    if (input.mimeType === 'application/pdf') {
      blocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: base64,
        },
      });
    } else if (input.mimeType.startsWith('image/')) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: input.mimeType,
          data: base64,
        },
      });
    }
  }

  const textPreamble: string[] = [];
  if (input.fileName) {
    textPreamble.push(`Source file: ${input.fileName}`);
  }
  textPreamble.push(
    'Extract every line item on the lumber list below. Preserve every building / phase / lot header exactly as written. Call the extract_lumber_list tool exactly once with the full structured result.',
  );
  if (input.rawText && input.rawText.trim().length > 0) {
    textPreamble.push('\n--- LUMBER LIST ---\n');
    textPreamble.push(input.rawText);
    textPreamble.push('\n--- END LIST ---');
  }

  blocks.push({ type: 'text', text: textPreamble.join('\n') });
  return blocks;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Works in both Node and modern runtime. Buffer is available under Node 20+.
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(sub) as number[]);
  }
  // btoa is available in Edge and browser runtimes.
  return btoa(binary);
}

// -----------------------------------------------------------------------------
// Post-processing (trust interpretation, re-derive math)
// -----------------------------------------------------------------------------

interface RawLineItem {
  species: string;
  dimension: string;
  grade: string;
  length: string;
  quantity: number;
  unit: string;
  board_feet: number;
  confidence: number;
  flags: string[];
  original_text: string;
}

interface RawBuildingGroup {
  building_tag: string;
  phase_number: number | null;
  line_items: RawLineItem[];
}

interface RawExtractionResult {
  extraction_confidence: number;
  building_groups: RawBuildingGroup[];
  total_line_items: number;
  total_board_feet: number;
  flags_requiring_review: string[];
}

function postProcess(raw: RawExtractionResult): ExtractionOutput {
  const buildingGroups: ExtractedBuildingGroup[] = (raw.building_groups ?? []).map(
    (group) => ({
      buildingTag: (group.building_tag ?? '').toString().trim() || 'Unassigned',
      phaseNumber:
        typeof group.phase_number === 'number' ? group.phase_number : null,
      lineItems: (group.line_items ?? []).map(normalizeLineItem),
    }),
  );

  const totalLineItems = buildingGroups.reduce(
    (sum, g) => sum + g.lineItems.length,
    0,
  );
  const totalBoardFeet = buildingGroups.reduce(
    (sum, g) => sum + g.lineItems.reduce((s, li) => s + (li.boardFeet ?? 0), 0),
    0,
  );

  return {
    extractionConfidence: clamp01(raw.extraction_confidence ?? 0),
    buildingGroups,
    totalLineItems,
    totalBoardFeet: round2(totalBoardFeet),
    flagsRequiringReview: raw.flags_requiring_review ?? [],
  };
}

function normalizeLineItem(item: RawLineItem): ExtractedLineItem {
  const species = normalizeSpecies(item.species);
  const dimension = normalizeDimension(item.dimension);
  const grade = normalizeGrade(item.grade);
  const length = normalizeLength(item.length);
  const unit = normalizeUnit(item.unit);
  const quantity = Number(item.quantity) || 0;

  // Re-derive board feet from the dimension/length/qty — ignore the
  // model's arithmetic because Claude is unreliable at multiplication.
  // Preserve the model's value only when we can't parse the dimension
  // (e.g. panels like OSB where there's no (t × w × L) formula).
  let boardFeet = boardFeetFromDimension(dimension, length, quantity);
  if (boardFeet === 0 && Number.isFinite(item.board_feet)) {
    boardFeet = Math.max(0, item.board_feet);
  }

  return {
    species,
    dimension,
    grade,
    length,
    quantity,
    unit,
    boardFeet: round2(boardFeet),
    confidence: clamp01(item.confidence ?? 0.5),
    flags: Array.isArray(item.flags) ? item.flags.filter(Boolean) : [],
    originalText: (item.original_text ?? '').toString(),
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// =============================================================================
// Mode B — targeted cleanup
// =============================================================================
//
// Session Prompt 04 tiered ingest engine. When the deterministic lumber-
// parser returns an overall confidence in the borderline band (0.60–0.92)
// we don't want to pay for a full-document Claude extraction — we only
// want to fix the specific lines the parser gave up on. Mode B does
// exactly that: pass the already-parsed high-confidence groups as
// grounding context so Claude preserves building tags, plus the short
// list of flagged rows with their raw source text and partial parse, and
// ask Claude to return clean line items for those rows only.
//
// Prompt design:
//   - Abridged system prompt: no "extract everything" rhetoric, just
//     "clean these specific lines".
//   - Grounding context keeps the building tags Claude saw in the high-
//     confidence groups so it doesn't invent new buildings.
//   - Forced tool_use keeps output JSON-safe.
//   - max_tokens 1024 — each fix is a handful of field values, not a
//     full takeoff.

/** Sonnet 4.6 list pricing (cents per 1M tokens). */
const SONNET_INPUT_CENTS_PER_MTOK = 300; // $3 / Mtok
const SONNET_OUTPUT_CENTS_PER_MTOK = 1500; // $15 / Mtok

export interface ModeBLowConfidenceLine {
  /** Building tag this flagged row belongs under. */
  buildingTag: string;
  /** Raw source text Claude should re-parse. */
  originalText: string;
  /**
   * What the deterministic parser managed to pull off the row before
   * giving up. Claude uses this as a starting point, not as gospel.
   */
  partialParse: Partial<ExtractedLineItem>;
  /** Flags the parser attached to this row (missing_species etc.). */
  flags: string[];
}

export interface ModeBInput {
  /** Already-parsed groups that Claude should preserve verbatim. */
  highConfidenceContext: ExtractedBuildingGroup[];
  lowConfidenceLines: ModeBLowConfidenceLine[];
  /**
   * Multitenant isolation tag — not sent to Claude, but used for cost
   * attribution when the orchestrator writes extraction_costs rows.
   */
  companyId: string;
}

export interface ModeBFixedLine {
  buildingTag: string;
  lineItem: ExtractedLineItem;
}

export interface ModeBResult {
  fixedLines: ModeBFixedLine[];
  /** Approximate Mode B spend in cents, computed from usage tokens. */
  costCents: number;
}

const MODE_B_SYSTEM_PROMPT = `You are a lumber list cleanup agent. A deterministic parser has already extracted most of this bid cleanly. Your job is narrow: take the SHORT LIST of flagged rows below and return a clean line item for each one. You are NOT re-extracting the whole document.

For each flagged row you receive:
- Use the raw source text to recover any missing species / dimension / grade / length / quantity / unit.
- Preserve the building_tag exactly as given — do not invent new groups.
- Canonicalize species to: SPF, DF, HF, SYP, Cedar, LVL, OSB, Plywood, Treated.
- Canonicalize grade to: #1, #2, #3, Stud, Select Structural, MSR, or panel/engineered grades as-written.
- Unit must be PCS, MBF, or MSF.
- Confidence 0.0–1.0 — how confident you are about the fix.
- Flags: array of tokens from {ambiguous_species, missing_grade, unclear_quantity, unusual_dimension, unit_inferred, engineered_without_grade}. Empty array if nothing is off.

Output ONLY via the fix_flagged_lines tool with the complete list of fixes. The high-confidence context is provided so you can ground building tags — do not try to re-parse it.`;

const MODE_B_TOOL: LocalTool = {
  name: 'fix_flagged_lines',
  description:
    'Emit clean line items for the flagged rows. Call exactly once with one fix per flagged line.',
  input_schema: {
    type: 'object',
    properties: {
      fixes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            building_tag: { type: 'string' },
            species: { type: 'string' },
            dimension: { type: 'string' },
            grade: { type: 'string' },
            length: { type: 'string' },
            quantity: { type: 'number' },
            unit: { type: 'string', enum: ['PCS', 'MBF', 'MSF'] },
            board_feet: { type: 'number' },
            confidence: { type: 'number' },
            flags: { type: 'array', items: { type: 'string' } },
            original_text: { type: 'string' },
          },
          required: [
            'building_tag',
            'species',
            'dimension',
            'grade',
            'length',
            'quantity',
            'unit',
            'board_feet',
            'confidence',
            'flags',
            'original_text',
          ],
        },
      },
    },
    required: ['fixes'],
  },
};

/**
 * Mode B — targeted cleanup. Runs a cheap Claude call on just the
 * flagged rows, using the surrounding high-confidence groups as
 * grounding context so building tags stay consistent. Returns the
 * fixes plus the approximate cost of the call so the orchestrator can
 * record it in extraction_costs.
 */
export async function extractionAgentTargetedCleanup(
  input: ModeBInput,
): Promise<ModeBResult> {
  if (input.lowConfidenceLines.length === 0) {
    return { fixedLines: [], costCents: 0 };
  }

  const anthropic = getAnthropic();

  const contextPreview = input.highConfidenceContext
    .map((group) => {
      const exemplar = group.lineItems
        .slice(0, 2)
        .map(
          (li) =>
            `${li.quantity} ${li.unit} ${li.dimension} ${li.species} ${li.grade}`.trim(),
        )
        .join(' / ');
      return `- ${group.buildingTag}${group.phaseNumber != null ? ` (Phase ${group.phaseNumber})` : ''}: ${exemplar || '(no sample lines)'}`;
    })
    .join('\n');

  const flaggedBlocks = input.lowConfidenceLines
    .map((line, index) => {
      const partial = line.partialParse;
      const partialSummary = [
        partial.species && `species=${partial.species}`,
        partial.dimension && `dimension=${partial.dimension}`,
        partial.grade && `grade=${partial.grade}`,
        partial.length && `length=${partial.length}`,
        partial.quantity != null && `quantity=${partial.quantity}`,
        partial.unit && `unit=${partial.unit}`,
      ]
        .filter(Boolean)
        .join(', ');

      return [
        `--- flagged_line ${index} ---`,
        `building_tag: ${line.buildingTag}`,
        `original_text: ${line.originalText}`,
        `parser_flags: ${line.flags.join(', ') || '(none)'}`,
        `partial_parse: ${partialSummary || '(empty)'}`,
      ].join('\n');
    })
    .join('\n\n');

  const userText = [
    '# High-confidence context (for grounding only — do not re-parse):',
    contextPreview || '(no context)',
    '',
    '# Flagged rows to fix:',
    flaggedBlocks,
    '',
    `Return exactly ${input.lowConfidenceLines.length} fixes via the fix_flagged_lines tool.`,
  ].join('\n');

  const response = await anthropic.messages.create({
    model: LMBR_DEFAULT_MODEL,
    max_tokens: 1024,
    system: MODE_B_SYSTEM_PROMPT,
    tools: [MODE_B_TOOL] as never,
    tool_choice: { type: 'tool', name: MODE_B_TOOL.name } as never,
    messages: [{ role: 'user', content: userText }],
  });

  const usage = response.usage;
  const costCents = usage
    ? (usage.input_tokens / 1_000_000) * SONNET_INPUT_CENTS_PER_MTOK +
      (usage.output_tokens / 1_000_000) * SONNET_OUTPUT_CENTS_PER_MTOK
    : 0;

  type ResponseBlock =
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'text'; text: string }
    | { type: string; [key: string]: unknown };

  const blocks = (response.content ?? []) as ResponseBlock[];
  const toolUse = blocks.find(
    (b): b is Extract<ResponseBlock, { type: 'tool_use' }> =>
      b.type === 'tool_use' && b.name === MODE_B_TOOL.name,
  );

  if (!toolUse) {
    console.warn('[extraction-agent] Mode B: no tool_use block', {
      stopReason: response.stop_reason,
      blockTypes: blocks.map((b) => b.type),
    });
    return { fixedLines: [], costCents };
  }

  interface RawFix {
    building_tag: string;
    species: string;
    dimension: string;
    grade: string;
    length: string;
    quantity: number;
    unit: string;
    board_feet: number;
    confidence: number;
    flags: string[];
    original_text: string;
  }
  const parsed = toolUse.input as { fixes?: RawFix[] };
  const rawFixes = Array.isArray(parsed.fixes) ? parsed.fixes : [];

  const fixedLines: ModeBFixedLine[] = rawFixes.map((fix) => {
    const lineItem: ExtractedLineItem = {
      ...normalizeLineItem({
        species: fix.species,
        dimension: fix.dimension,
        grade: fix.grade,
        length: fix.length,
        quantity: fix.quantity,
        unit: fix.unit,
        board_feet: fix.board_feet,
        confidence: fix.confidence,
        flags: fix.flags,
        original_text: fix.original_text,
      }),
      // Mode B produced these — tag them so downstream code and the
      // review UI can show the "needed AI help" badge.
      extractionMethod: 'claude_extraction',
    };

    return {
      buildingTag: (fix.building_tag ?? '').trim() || 'Unassigned',
      lineItem,
    };
  });

  return { fixedLines, costCents };
}
