/**
 * Scan-back agent — OCR text + known line items → matched vendor prices.
 *
 * Purpose:  Closes the paper workflow loop for vendors who print the
 *           Task 4 tally PDF, write prices by hand, and scan/photograph
 *           the sheet back. The route that calls this agent has already:
 *             1. Authenticated the caller via the HMAC-signed token from
 *                the PDF footer.
 *             2. Run Azure Document Intelligence OCR over the scanned
 *                image/PDF to recover the raw text grid.
 *             3. Loaded the exact set of line_items this vendor was
 *                asked to price (by vendorVisibleIsConsolidatedFlag).
 *           This agent's only job is narrow matching — zip each OCR'd
 *           row to one of the known line_item_ids and extract the
 *           unit_price + any vendor notes. It is NOT a re-extraction:
 *           the schema is already fixed. That's why this uses Haiku
 *           (claude-haiku-4-5-20251001) instead of Sonnet — per CLAUDE.md
 *           the Model Split pins the scan-back price matcher to Haiku
 *           explicitly.
 *
 *           Design notes:
 *           - Forced tool_use. The tool schema takes the entire list
 *             in a single call so Claude can reason about relative
 *             ordering (row 3 on the sheet ↔ expected line 3) before
 *             emitting a verdict per line.
 *           - Prices are clamped post-model. Lumber unit prices cluster
 *             in $200–$2000/MBF or per-PCS ranges; any value outside
 *             [$0.01, $100,000] is a near-certain OCR misread (comma
 *             placement, stray digit) and is returned as null so the
 *             route doesn't poison vendor_bid_line_items with garbage.
 *           - costCents is derived from response.usage + Haiku 4.5
 *             pricing so the caller can roll the spend into the
 *             extraction_costs ledger.
 *
 * Inputs:   { ocrText, ocrConfidence, expectedLines, companyId }.
 * Outputs:  ScanbackResult — per-line matches + unmatched IDs + cost.
 * Agent/API: Anthropic Claude Haiku (tool_use, forced tool_choice).
 * Imports:  @lmbr/lib (getAnthropic).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { getAnthropic } from '@lmbr/lib';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/**
 * A single line item the vendor was asked to price. The route builds
 * this array from vendor-visible line_items before calling the agent.
 * `sortOrder` matches the row number printed on the scan-back sheet
 * (1-indexed to the vendor's eye, 0-indexed to us — the agent is told
 * to interpret ordering, not assume it).
 */
export interface ScanbackExpectedLine {
  lineItemId: string;
  sortOrder: number;
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number;
  unit: string;
}

export interface ScanbackMatchedLine {
  lineItemId: string;
  /** Null when Haiku could not recover a confident price for this line. */
  unitPrice: number | null;
  /** Vendor's handwritten note for this line, if any. */
  notes: string | null;
  /** 0..1 — Haiku's self-reported confidence in the match. */
  confidence: number;
  /** The OCR'd text Haiku attributed to this line, for debug/audit. */
  rawSnippet: string | null;
}

export interface ScanbackResult {
  matchedLines: ScanbackMatchedLine[];
  /** Expected line IDs with no priced match — UI highlights these. */
  unmatchedExpectedIds: string[];
  /** OCR rows Haiku saw but couldn't attribute — surfaced for sanity. */
  extraRowsFound: string[];
  /** Haiku call cost in cents (cost-tracker also gets OCR cost separately). */
  costCents: number;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Explicit per CLAUDE.md "Model Split" — scan-back matcher is always Haiku. */
const SCANBACK_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Haiku 4.5 pricing (cents per 1M tokens). The task spec calls for 80/400
 * (based on the $0.80 / $4.00 list rate). The ledger is approximate —
 * minor rate drift here doesn't distort analytics.
 */
const HAIKU_INPUT_CENTS_PER_MTOK = 80;
const HAIKU_OUTPUT_CENTS_PER_MTOK = 400;

/**
 * Plausibility band for unit prices. Lumber prices cluster between a few
 * dollars per piece and low-thousands per MBF; anything outside this
 * window is nearly always an OCR misread (comma in the wrong place,
 * stray digit, decimal dropped). Clamp to null rather than pollute the
 * comparison matrix with an obviously wrong number.
 */
const PRICE_MIN = 0.01;
const PRICE_MAX = 100_000;

/** Upper bound on notes length written to DB. Matches vendor-submit API. */
const NOTES_MAX_LEN = 1000;

/** Truncate the raw OCR text before sending — Haiku context is cheap but finite. */
const OCR_TEXT_MAX_CHARS = 12_000;

// -----------------------------------------------------------------------------
// Prompt
// -----------------------------------------------------------------------------

const SCANBACK_SYSTEM_PROMPT = `You are a scan-back price matcher for lumber bids.

You receive two inputs:
1. The OCR text of a vendor's hand-written price sheet (they printed a bid tally, wrote prices by hand, and scanned it back).
2. The EXPECTED LINE ITEMS they were asked to price, each with a stable line_item_id and the row number the vendor would see on the printed sheet.

Your job: match each expected line to a unit price on the sheet. For each expected line, emit one match with:
- line_item_id (copied verbatim from the expected list)
- unit_price (number, or null if no clear price was written)
- notes (short string if the vendor wrote a note next to that row, otherwise null)
- confidence (0.0–1.0 — how sure you are about this specific match)
- raw_snippet (the OCR fragment you read this price from, for debugging — or null if none)

CRITICAL RULES:
- Lumber unit prices are almost always between ~$200–$2000 per MBF or a few dollars per PCS. Prices outside $0.01–$100,000 are nearly always OCR misreads — return null for unit_price in that case.
- If a row is crossed out, blank, or illegible, return null for unit_price. Do NOT guess.
- If the vendor wrote a note (e.g. "no mill", "call me", "3-week lead"), capture it verbatim in notes.
- Use the row ordering as a strong prior but not gospel — vendors sometimes re-order rows, skip lines, or squeeze in annotations. Prefer matching by dimension/species/quantity when there is disagreement.
- Report any OCR rows that look like priced entries but don't map to any expected line in the extra_rows array — this is a sanity check for trader review, not grounds to invent a line_item_id.

You MUST call the match_scanback_prices tool exactly once with matches covering every expected line_item_id supplied. Do NOT return text, commentary, or explanation — only the tool call.`;

// -----------------------------------------------------------------------------
// Tool schema
// -----------------------------------------------------------------------------

interface LocalTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

const SCANBACK_TOOL: LocalTool = {
  name: 'match_scanback_prices',
  description:
    'Emit per-line scan-back match results plus any OCR rows that could not be mapped to an expected line. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line_item_id: { type: 'string' },
            unit_price: { type: ['number', 'null'] },
            notes: { type: ['string', 'null'] },
            confidence: { type: 'number' },
            raw_snippet: { type: ['string', 'null'] },
          },
          required: [
            'line_item_id',
            'unit_price',
            'notes',
            'confidence',
            'raw_snippet',
          ],
        },
      },
      extra_rows: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['matches', 'extra_rows'],
  },
};

// -----------------------------------------------------------------------------
// Input / main
// -----------------------------------------------------------------------------

export interface ScanbackInput {
  ocrText: string;
  ocrConfidence: number;
  expectedLines: ScanbackExpectedLine[];
  /**
   * Tenant isolation tag — never sent to Claude. The route uses it to
   * attribute cost-ledger rows; the agent takes it so the contract is
   * symmetric with other agents that do the same.
   */
  companyId: string;
}

export async function scanbackAgent(
  input: ScanbackInput,
): Promise<ScanbackResult> {
  if (input.expectedLines.length === 0) {
    return {
      matchedLines: [],
      unmatchedExpectedIds: [],
      extraRowsFound: [],
      costCents: 0,
    };
  }

  // Short-circuit if OCR returned nothing usable. Don't spend a Haiku
  // call just to emit "null for every line" — we can do that locally.
  const trimmed = (input.ocrText ?? '').trim();
  if (trimmed.length === 0) {
    return {
      matchedLines: input.expectedLines.map((line) => ({
        lineItemId: line.lineItemId,
        unitPrice: null,
        notes: null,
        confidence: 0,
        rawSnippet: null,
      })),
      unmatchedExpectedIds: input.expectedLines.map((l) => l.lineItemId),
      extraRowsFound: [],
      costCents: 0,
    };
  }

  const anthropic = getAnthropic();

  const expectedBlocks = input.expectedLines
    .map((line, idx) => {
      const parts = [
        `row ${idx + 1}`,
        `line_item_id=${line.lineItemId}`,
        `qty=${line.quantity} ${line.unit}`,
        `dim=${line.dimension}`,
        `species=${line.species}`,
      ];
      if (line.grade) parts.push(`grade=${line.grade}`);
      if (line.length) parts.push(`length=${line.length}`);
      return `- ${parts.join(' | ')}`;
    })
    .join('\n');

  const userText = [
    `# Expected line items (${input.expectedLines.length} rows, printed in this order on the sheet):`,
    expectedBlocks,
    '',
    `# OCR text (confidence=${input.ocrConfidence.toFixed(2)}):`,
    '```',
    trimmed.slice(0, OCR_TEXT_MAX_CHARS),
    '```',
    '',
    `Emit exactly ${input.expectedLines.length} match entries via the match_scanback_prices tool — one per expected line_item_id.`,
  ].join('\n');

  const response = await anthropic.messages.create({
    model: SCANBACK_MODEL,
    max_tokens: 2048,
    system: SCANBACK_SYSTEM_PROMPT,
    tools: [SCANBACK_TOOL] as never,
    tool_choice: { type: 'tool', name: SCANBACK_TOOL.name } as never,
    messages: [{ role: 'user', content: userText }],
  });

  const usage = response.usage;
  const costCents = usage
    ? (usage.input_tokens / 1_000_000) * HAIKU_INPUT_CENTS_PER_MTOK +
      (usage.output_tokens / 1_000_000) * HAIKU_OUTPUT_CENTS_PER_MTOK
    : 0;

  type ResponseBlock =
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'text'; text: string }
    | { type: string; [key: string]: unknown };

  const blocks = (response.content ?? []) as ResponseBlock[];
  const toolUse = blocks.find(
    (b): b is Extract<ResponseBlock, { type: 'tool_use' }> =>
      b.type === 'tool_use' && b.name === SCANBACK_TOOL.name,
  );

  if (!toolUse) {
    console.warn('[scanback-agent] no tool_use block returned', {
      stopReason: response.stop_reason,
      blockTypes: blocks.map((b) => b.type),
    });
    return {
      matchedLines: input.expectedLines.map((line) => ({
        lineItemId: line.lineItemId,
        unitPrice: null,
        notes: null,
        confidence: 0,
        rawSnippet: null,
      })),
      unmatchedExpectedIds: input.expectedLines.map((l) => l.lineItemId),
      extraRowsFound: [],
      costCents: round4(costCents),
    };
  }

  interface RawMatch {
    line_item_id: string;
    unit_price: number | null;
    notes: string | null;
    confidence: number;
    raw_snippet: string | null;
  }
  interface RawResult {
    matches?: RawMatch[];
    extra_rows?: string[];
  }
  const parsed = toolUse.input as RawResult;
  const rawMatches = Array.isArray(parsed.matches) ? parsed.matches : [];
  const extraRowsFound = Array.isArray(parsed.extra_rows)
    ? parsed.extra_rows
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  // Re-align to the expected-line order so the route can zip strictly by
  // lineItemId. Drop any matches for IDs we didn't ask about — the tenant
  // can't be allowed to write a price onto someone else's line_item.
  const expectedIds = new Set(input.expectedLines.map((l) => l.lineItemId));
  const matchById = new Map<string, RawMatch>();
  for (const m of rawMatches) {
    if (m && typeof m.line_item_id === 'string' && expectedIds.has(m.line_item_id)) {
      matchById.set(m.line_item_id, m);
    }
  }

  const matchedLines: ScanbackMatchedLine[] = input.expectedLines.map((line) => {
    const m = matchById.get(line.lineItemId);
    if (!m) {
      return {
        lineItemId: line.lineItemId,
        unitPrice: null,
        notes: null,
        confidence: 0,
        rawSnippet: null,
      };
    }
    const unitPrice = clampPrice(m.unit_price);
    const notes = sanitizeNote(m.notes);
    const confidence = clamp01(m.confidence);
    const rawSnippet =
      typeof m.raw_snippet === 'string' && m.raw_snippet.trim().length > 0
        ? m.raw_snippet.trim().slice(0, 500)
        : null;
    return {
      lineItemId: line.lineItemId,
      unitPrice,
      notes,
      confidence,
      rawSnippet,
    };
  });

  const unmatchedExpectedIds = matchedLines
    .filter((m) => m.unitPrice == null)
    .map((m) => m.lineItemId);

  return {
    matchedLines,
    unmatchedExpectedIds,
    extraRowsFound,
    costCents: round4(costCents),
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function clampPrice(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw < PRICE_MIN || raw > PRICE_MAX) return null;
  // Prices in vendor_bid_line_items.unit_price are numeric(10,4). Round
  // to 4dp here so the server's computed total_price reconciles with the
  // stored price exactly.
  return Math.round(raw * 10000) / 10000;
}

function sanitizeNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, NOTES_MAX_LEN);
}

function clamp01(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
