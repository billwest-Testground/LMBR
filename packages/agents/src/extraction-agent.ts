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
    throw new Error(
      'extractionAgent: Claude did not invoke extract_lumber_list tool',
    );
  }

  return postProcess(toolUse.input as RawExtractionResult);
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
