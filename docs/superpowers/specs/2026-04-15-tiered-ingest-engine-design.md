# Tiered Ingest Engine — Design

**Date:** 2026-04-15
**Status:** Draft for approval
**Owner:** billwest-Testground
**Module:** LMBR.ai Session Prompt 04 — Ingest Engine v2

---

## 1. Goal

Replace the current Claude-first extraction pipeline with a **tiered pipeline** that uses the cheapest method capable of reaching a per-line confidence of `>= 0.92`. Claude becomes a fallback, not the default.

**Cost targets per document:**

| Source type | Method | Cost |
|---|---|---|
| Excel / CSV | exceljs / csv-parse | $0.000 |
| Clean text PDF | pdf-parse + regex | $0.000 |
| DOCX | mammoth + regex | $0.000 |
| Scanned PDF / image | Azure Document Intelligence | ~$0.0015 |
| Truly ambiguous | Claude Sonnet (fallback) | ~$0.14 |

**Target mix:** < 15% of documents reach Claude extraction. Excel and clean-PDF lumber lists must never touch the LLM.

---

## 2. Architectural principles

1. **Cheapest first, fallback on evidence.** Router chooses the extraction method by file type. Parser runs deterministic normalization. Claude only fires when per-line confidence is below threshold.
2. **Re-use, don't duplicate.** `packages/lib/src/lumber.ts` already owns species/dimension/grade/length/unit normalization and board-feet math. The new `lumber-parser.ts` composes these primitives — it does not reimplement them.
3. **Two Claude modes, chosen by confidence.**
   - **Mode A** (full extraction) — confidence `< 0.60`. Use the existing, battle-tested extraction-agent. Full document text passed to Sonnet.
   - **Mode B** (targeted cleanup) — confidence `0.60 – 0.92`. Pass only low-confidence lines plus high-confidence lines as context. Much cheaper (smaller prompt, lower `max_tokens`).
4. **QA stays mostly deterministic.** The current pure-TS rules engine remains the primary QA. Haiku is added as a second pass for subjective checks only (species/grade plausibility, building-header sanity, unusual-spec catch). Haiku is ~10x cheaper than Sonnet.
5. **Cost recorded per extraction.** Every line item gets `extraction_method`, `extraction_confidence`, `cost_cents` columns. An `extraction_costs` table aggregates per-bid / per-company spend for the manager dashboard.
6. **Async is optional.** Large files route through BullMQ if `REDIS_URL` is set; otherwise the orchestrator processes synchronously in-request. Orchestrator does not know which path it is taking — the queue module exposes a unified `enqueueOrRun()` API.
7. **Building/phase structure is preserved verbatim.** This is a CLAUDE.md non-negotiable. The parser never flattens groups.
8. **Vendor names never surface on customer-facing output.** Not directly relevant to extraction, but worth restating: the uploader and review UI treat raw file content as internal-only.

---

## 3. Module contracts

### 3.1 `packages/lib/src/attachment-analyzer.ts` (NEW)

```ts
export type ExtractionMethod =
  | 'excel_parse'
  | 'csv_parse'
  | 'docx_parse'
  | 'pdf_direct'
  | 'ocr'
  | 'email_text'
  | 'direct_text'
  | 'claude_extraction';   // set on lines produced/fixed by Mode A or Mode B

export interface AttachmentAnalysisResult {
  method: ExtractionMethod;
  extractedText: string;
  rawRows?: Record<string, unknown>[];   // Excel / CSV only
  pageCount?: number;
  confidence: number;                     // 0.0–1.0 — quality of extraction, not parse
  costCents: number;
  metadata: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    detectedEncoding?: string;
    ocrPages?: number;
    fellBackToOcr?: boolean;
  };
}

export async function analyzeAttachment(
  file: Buffer,
  mimeType: string,
  filename: string,
): Promise<AttachmentAnalysisResult>;
```

**Routing rules** (first match wins):
- `.xlsx` / `.xls` → exceljs
- `.csv` → csv-parse
- `.docx` → mammoth
- `.pdf` → pdf-parse; if extractable char count `<= 50`, fall back to OCR and set `fellBackToOcr: true`
- `.jpg .jpeg .png .tiff .bmp` → OCR
- `.txt` → UTF-8 decode
- email body passed as `mimeType: 'text/plain'` → direct
- unknown → OCR fallback

**Cost accounting:**
- All non-OCR paths: `costCents = 0`
- OCR: `costCents = pages * 0.15` (Azure at $1.50/1k pages)

### 3.2 `packages/lib/src/lumber-parser.ts` (NEW)

Pure deterministic parser. Zero API calls. Composes existing normalizers from `lumber.ts`.

```ts
export interface LumberLineItemDraft {
  species: string;
  dimension: string;
  grade: string;
  length: string;
  quantity: number;
  unit: 'PCS' | 'MBF' | 'MSF';
  boardFeet: number;
  confidence: number;           // 0.0–1.0 — fields matched / expected
  flags: string[];
  originalText: string;
}

export interface BuildingGroupDraft {
  buildingTag: string;          // verbatim from source
  phaseNumber: number | null;
  lineItems: LumberLineItemDraft[];
}

export interface ParseResult {
  buildingGroups: BuildingGroupDraft[];
  overallConfidence: number;     // mean across all lines
  lowConfidenceIndices: {        // flat addressing for Mode B targeting
    buildingIndex: number;
    lineIndex: number;
  }[];
  totalLineItems: number;
  totalBoardFeet: number;
  extractionMethod: ExtractionMethod;
  costCents: number;
}

export function parseLumberList(input: AttachmentAnalysisResult): ParseResult;
```

**Sub-parsers:**
- `parseExcelRows(rows)` — header-row detection by keyword match (species / dimension / grade / qty / length); supports three known layouts (qty-species-dim-grade-len, item-desc-qty-uom, building-item-qty-size-species-grade); detects group-header rows (text in col A + empty numeric cols).
- `parseTextList(text)` — line splitter; group-header detection by regex (`house|lot|building|phase|unit|bldg`); per-line regex for qty / dimension / species / grade / length / unit.

**Confidence scoring:** Per line = `(fields matched cleanly) / (fields expected)`. Expected fields: species, dimension, grade (optional for panels/engineered), length, quantity, unit. Missing required fields → flag + confidence penalty.

**Reused primitives** (from `lumber.ts`):
- `normalizeSpecies`, `normalizeDimension`, `normalizeGrade`, `normalizeLength`, `normalizeUnit`
- `boardFeetFromDimension(dim, length, qty, unit)`

No new normalization maps — if a token is missing, add it to `lumber.ts` and reuse.

### 3.3 `packages/lib/src/ocr.ts` (REWRITE)

Replace the stub with a real `@azure/ai-form-recognizer` client.

```ts
export interface OcrResult {
  text: string;
  pages: number;
  confidence: number;            // mean word confidence from Azure
  costCents: number;             // pages * 0.15
  tables?: unknown[];            // Azure layout table blocks, pass-through
}

export async function analyzeDocument(
  buffer: Buffer,
  mimeType: string,
): Promise<OcrResult>;
```

Throws `OcrError` with a descriptive message on Azure failure. Caller (attachment-analyzer) is responsible for fallback behavior.

### 3.4 `packages/agents/src/extraction-agent.ts` (AUGMENT — decision 4b)

Keep the existing `extractionAgent()` as-is (that becomes **Mode A**). Add a new exported function:

```ts
export async function extractionAgentTargetedCleanup(input: {
  highConfidenceContext: ExtractedBuildingGroup[];  // already parsed, passed for grounding
  lowConfidenceLines: Array<{
    buildingTag: string;
    originalText: string;
    partialParse: Partial<LumberLineItemDraft>;
    flags: string[];
  }>;
  companyId: string;
}): Promise<{
  fixedLines: Array<{
    buildingTag: string;
    lineItem: ExtractedLineItem;
  }>;
  costCents: number;
}>;
```

**Mode B** uses `max_tokens: 1024` and an abridged system prompt that tells the model it is only fixing flagged lines, not re-extracting the list. High-confidence groups are passed as grounding context so the model preserves tags and doesn't invent new buildings. Uses `claude-sonnet-4-6`. Cost is tracked on the returned `costCents`.

Both functions write `extraction_method: 'claude_extraction'` on lines they produce.

### 3.5 `packages/agents/src/qa-agent.ts` (AUGMENT)

Keep the existing deterministic rules engine. Add an optional Haiku pass:

```ts
export async function runQaAgent(
  extraction: ExtractionOutput,
  options?: { runLlmChecks?: boolean },   // default true
): Promise<QAReport>;
```

**New Haiku checks** (only fire for lines already marked suspicious by the deterministic pass OR whose confidence is in `[0.75, 0.92]`):
- Plausibility of species+grade combination
- Building header sanity given neighbors
- Unusual-spec detection (e.g., 2x10 stud-grade, which is rare)

Model: `claude-haiku-4-5-20251001`. Max tokens: 512 per batch. Lines are batched up to 30 per call. If `runLlmChecks === false` or `ANTHROPIC_API_KEY` missing, the LLM pass is skipped silently.

**QAReport additions:**
```ts
{
  deterministicChecksPassed: number;
  llmChecksRun: number;
  costCents: number;
}
```

### 3.6 `packages/lib/src/cost-tracker.ts` (NEW)

```ts
export type CostMethod =
  | ExtractionMethod            // the method set on line_items
  | 'claude_mode_a'             // Mode A full extraction (full-doc)
  | 'claude_mode_b'             // Mode B targeted cleanup
  | 'qa_llm';                   // Haiku QA pass

export async function recordExtraction(params: {
  bidId: string;
  companyId: string;
  method: CostMethod;
  costCents: number;
}): Promise<void>;
```

**Important distinction:** `line_items.extraction_method` records how a *single line* was produced (e.g. `excel_parse`, `claude_extraction`). The `extraction_costs` table uses the wider `CostMethod` enum so we can tell Mode A spend apart from Mode B spend apart from QA spend when analyzing per-bid cost. This granularity is what lets us tune the confidence threshold over time.

Writes to new `extraction_costs` table. Fire-and-forget from the orchestrator — a failure here logs but does not break the ingest.

### 3.7 `packages/lib/src/queue.ts` (NEW, Redis-optional)

```ts
export interface IngestJob {
  bidId: string;
  companyId: string;
  filePath: string;           // supabase storage path
  mimeType: string;
  filename: string;
}

export async function enqueueOrRun(
  job: IngestJob,
  processor: (job: IngestJob) => Promise<void>,
): Promise<{ mode: 'queued' | 'inline'; jobId?: string }>;
```

**Behavior:**
- If `REDIS_URL` is set → lazily instantiate a BullMQ queue `lmbr-extraction`, add the job, return `{ mode: 'queued', jobId }`.
- If `REDIS_URL` is unset → run `processor(job)` inline and return `{ mode: 'inline' }`.

**BullMQ settings** (when active):
- Concurrency: `Math.max(1, Math.floor(os.cpus().length / 2))`
- Retries: 3 with exponential backoff
- Dead letter: Supabase `bids.status = 'extraction_failed'` + error in `bids.notes`

The orchestrator never branches on `REDIS_URL` — it always calls `enqueueOrRun`.

### 3.8 `apps/web/src/app/api/ingest/route.ts` (REWRITE)

**Flow:**
1. Auth + multipart parse.
2. Upload raw file to `bids-raw` bucket. Insert bid row with `status: 'extracting'`.
3. Call `enqueueOrRun({ bidId, companyId, filePath, mimeType, filename }, processIngestJob)`.
4. If `mode: 'queued'` → return `202 Accepted` with `{ bid_id, status: 'extracting' }`. Client polls via Supabase Realtime on `bids` row.
5. If `mode: 'inline'` → the processor has already run; read back the bid + line items and return `200` with full extraction report.

**`processIngestJob(job)`** (the shared processor):
1. Download file from storage.
2. `analyzeAttachment(buffer, mimeType, filename)` → `AttachmentAnalysisResult`.
3. `parseLumberList(result)` → `ParseResult` with `overallConfidence`.
4. Decision gate:
   - `>= EXTRACTION_CONFIDENCE_THRESHOLD` (default 0.92) → skip Claude entirely. Lines keep the analyzer method (`excel_parse` / `pdf_direct` / etc).
   - `0.60 – 0.92` → Mode B cleanup on `lowConfidenceIndices` only. Merge fixes back into parse result. Fixed lines get `extraction_method: 'claude_extraction'`; untouched lines keep their parser-assigned method.
   - `< 0.60` → Mode A full extraction. Parser result is discarded; all emitted lines get `extraction_method: 'claude_extraction'`.
5. Build `ExtractionOutput` shape (matches existing schema in `packages/types`).
6. `runQaAgent(extraction, { runLlmChecks: true })`.
7. Insert `line_items` rows with per-line `extraction_method`, `extraction_confidence`, `cost_cents`. Continue to store `{confidence, flags, original_text}` in `notes` JSON for backward compatibility with the existing review UI.
8. `recordExtraction()` for each phase (analyzer, parser — $0, OCR, mode A, mode B, QA LLM).
9. Update bid `status: 'reviewing'`.

**Response shape:**
```ts
{
  bid_id: string;
  status: 'reviewing' | 'extracting';
  extraction_report?: {
    method_used: ExtractionMethod;
    total_cost_cents: number;
    lines_parsed_free: number;
    lines_parsed_ocr: number;
    lines_parsed_claude: number;
    overall_confidence: number;
    qa_passed: boolean;
  };
}
```

### 3.9 `apps/web/src/app/api/extract/route.ts` (NEW)

Vendor scan-back: vendor returns a priced copy of a fillable bid sheet. This route is **not** a full list extractor — it's a targeted price extractor.

**Flow:**
1. Accept `{ vendor_bid_id, file }` multipart.
2. OCR via `analyzeDocument`.
3. Pass OCR text plus the original line item list (looked up from `vendor_bid_line_items`) to a narrow Claude Haiku prompt: "Match each of these line items to a price in the OCR text. Return `null` for any line without a confident match."
4. Update `vendor_bid_line_items.price_cents` for matched lines.
5. Return per-line match report.

Much simpler than full extraction because the line item schema is already known. Haiku is sufficient.

### 3.10 `apps/web/src/components/bids/bid-uploader.tsx` (UPDATE)

- Drag/drop zone already exists. Add MIME type acceptance for `.docx` and `.msg`.
- Tiered progress messages driven by a local state machine:
  1. "Analyzing file format..."
  2. Method-specific message: "Parsing Excel columns..." / "Extracting text from PDF..." / "Running OCR scan..."
  3. Conditional: "Cleaning up with AI..." (only renders when Mode A or Mode B fires)
  4. "Running quality check..."
- Dev-only cost badge under the progress bar. Gated on `process.env.NEXT_PUBLIC_APP_ENV !== 'production'`.

### 3.11 `apps/web/src/components/bids/line-item-table.tsx` (UPDATE)

Add a subtle extraction-method badge per row. Uses lucide icons:
- `excel_parse` / `csv_parse` → `Sheet` icon
- `pdf_direct` → `FileText` icon
- `ocr` → `ScanLine` icon
- `claude_extraction` → `Sparkles` icon (signals "this needed AI — give it an extra look")

Tooltip on hover shows method name + confidence + cost in cents. Icons positioned left of species column, color `--color-text-tertiary`. No layout shift.

### 3.12 Mobile (Part 10) — DEFERRED

`apps/mobile` is scaffolded but not touched this session. Note added to `CLAUDE.md` build-status checklist to pick up in Prompt 12 polish. Rationale: tiered extraction logic must be proven on web before doubling surface area.

---

## 4. Database changes

### 4.1 `014_line_items_extraction_fields.sql` (NEW)

```sql
ALTER TABLE line_items
  ADD COLUMN extraction_method     TEXT,
  ADD COLUMN extraction_confidence NUMERIC(4,3),
  ADD COLUMN cost_cents            NUMERIC(8,4) DEFAULT 0;

CREATE INDEX line_items_extraction_method_idx
  ON line_items (extraction_method);
```

- `notes` column stays untouched. No data migration.
- `extraction_confidence` allows 0.000–1.000 with millisecond-grain confidence.
- `cost_cents` allows sub-cent precision (OCR per-page cost is 0.15¢).

### 4.2 `015_extraction_costs.sql` (NEW)

```sql
CREATE TABLE extraction_costs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bid_id      UUID NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  method      TEXT NOT NULL,
  cost_cents  NUMERIC(8,4) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX extraction_costs_company_created_idx
  ON extraction_costs (company_id, created_at DESC);

CREATE INDEX extraction_costs_bid_idx
  ON extraction_costs (bid_id);

ALTER TABLE extraction_costs ENABLE ROW LEVEL SECURITY;

CREATE POLICY extraction_costs_tenant_isolation ON extraction_costs
  FOR ALL USING (company_id = (SELECT company_id FROM users WHERE id = auth.uid()));
```

### 4.3 `packages/types/src/line-item.ts` (UPDATE)

Extend `LineItemSchema` (the persisted row shape) with:

```ts
extractionMethod:     z.string().nullable(),
extractionConfidence: z.number().min(0).max(1).nullable(),
costCents:            z.number().min(0).nullable(),
```

`ExtractedLineItemSchema` (pre-insert) gets the same fields as optional.

---

## 5. Environment variables

Add to `.env.example`:

```bash
# Azure Document Intelligence (OCR)
AZURE_DOC_INTELLIGENCE_ENDPOINT=
AZURE_DOC_INTELLIGENCE_KEY=

# Extraction tuning
EXTRACTION_CONFIDENCE_THRESHOLD=0.92

# Optional — enables async extraction queue
REDIS_URL=
```

The Redis URL is optional. If unset, the orchestrator processes inline.

---

## 6. Dependencies

Add to `packages/lib/package.json`:

```json
"exceljs":                    "^4.4.0",
"pdf-parse":                  "^1.1.1",
"mammoth":                    "^1.8.0",
"@azure/ai-form-recognizer":  "^5.0.0",
"csv-parse":                  "^5.5.0",
"bullmq":                     "^5.0.0",
"ioredis":                    "^5.0.0"
```

`xlsx` (SheetJS) is already present but is being replaced by `exceljs` for more reliable layout detection. SheetJS is kept for the `.msg` and legacy codepaths in `ingest-agent.ts` until that agent is fully retired.

---

## 7. Build order & commit points

Each phase lands as one commit. Phases 1–3 can theoretically run in parallel but I'll serialize them to keep the diffs reviewable.

1. **Schema + types** — migrations 014/015, `line-item.ts` update, dependency install. Commit.
2. **OCR + attachment-analyzer** — real Azure client, file router. Unit test each routing branch with a fixture. Commit.
3. **Lumber parser** — Excel/CSV/text sub-parsers, group detection, confidence scoring. Unit test against 3 real layouts. Commit.
4. **Extraction-agent Mode B** — new targeted cleanup function. Commit.
5. **QA-agent Haiku pass** — LLM checks added behind a flag, existing tests must still pass. Commit.
6. **Cost tracker + queue abstraction** — Redis-optional queue module. Commit.
7. **Orchestrator rewrite** — `/api/ingest` route + shared `processIngestJob`. End-to-end test with each method. Commit.
8. **Vendor extract route** — `/api/extract` for scan-back. Commit.
9. **UI updates** — bid-uploader tiered progress + line-item-table method badges. Commit.
10. **CLAUDE.md build-status update** — tick off Prompt 04, note mobile deferred to Prompt 12. Commit.

Between phases I will run `pnpm build` and `pnpm typecheck` at minimum. If full test suites exist, they run before each commit.

---

## 8. Verification plan

- **Unit tests** for `attachment-analyzer` (every routing branch) and `lumber-parser` (three layouts, group detection, confidence scoring, BF math).
- **Integration test** of `processIngestJob` with fixtures:
  - Excel list (should never touch Claude; `total_cost_cents === 0`)
  - Clean PDF (same)
  - Scanned PDF (should hit OCR; cost > 0, no Claude)
  - Handwritten/noisy list (should hit Mode A; `claude_extraction` badge on every line)
  - Mostly-clean list with 5 bad lines (should hit Mode B; badge on 5 lines only)
- **Manual smoke** through the web uploader with a real scanned PDF.
- **Cost assertion:** after the smoke run, `extraction_costs` aggregate matches `SUM(line_items.cost_cents)` within rounding tolerance.
- **RLS check:** create two test companies, confirm neither can read the other's `extraction_costs`.

---

## 9. Estimated cost impact

Assumptions: 70% Excel/CSV, 15% clean text PDF, 10% scanned/image, 5% truly ambiguous. Averages: 1 page OCR, 1 Claude Mode A call per ambiguous doc, Mode B triggers on ~10% of clean PDFs for 5 lines.

Per-bid blended average:
- Excel/CSV: 70% × $0.000 = $0.000
- Clean PDF (no Mode B): 13.5% × $0.000 = $0.000
- Clean PDF (Mode B): 1.5% × $0.0025 ≈ $0.00004
- Scanned: 10% × $0.0015 = $0.00015
- Ambiguous (Mode A): 5% × $0.14 = $0.007
- QA Haiku pass (all docs): 100% × ~$0.0005 = $0.0005
- **Total ≈ $0.0077 per bid**

Monthly cost estimates:

| Volume | Est. monthly cost |
|---|---|
| 1,000 bids | ~$7.70 |
| 5,000 bids | ~$38.50 |
| 10,000 bids | ~$77.00 |

At $10k/month ARPU per company, extraction cost is ~0.08% of revenue at 10k bids/month. This is the moat: the parser handles 85% of volume for free.

Compare to Claude-first (current): ~$0.14 × 10,000 = **$1,400/month** per company at 10k bids. The tiered engine saves roughly **18× cost** at full volume.

---

## 10. Non-goals

- Mobile file picker / camera capture (deferred to Prompt 12).
- Outlook webhook (`/api/webhook/outlook`) (Prompt 08).
- Consolidation mode application during extraction (structure is preserved; consolidation is a separate trader action — Prompt 05).
- Automatic re-extraction on failure — dead-letter surfaces to trader for manual re-upload.
- Historical cost backfill — `extraction_costs` starts empty on deploy.

---

## 11. Risk notes

- **pdf-parse** is unmaintained but still works on modern PDFs. If it fails for a given file we fall through to OCR, so the failure mode is "costs 0.15¢ instead of 0" — acceptable.
- **Azure Document Intelligence** pricing assumes the S0 tier and prebuilt-layout model. If the team switches to the free F0 tier for staging, OCR calls are rate-limited to 20/min — the queue abstraction handles retry.
- **BullMQ + serverless.** If the web app runs on Vercel serverless, long-running workers don't persist. The Redis-optional fallback sidesteps this: Vercel deployment uses inline mode, dedicated worker machines use queued mode. Worker process is a separate Node entry point, not a Next.js route.
- **Confidence threshold 0.92** is a first-guess. Cost tracker data will let us tune it over the first 1000 real bids. Env var `EXTRACTION_CONFIDENCE_THRESHOLD` makes this adjustable without a deploy.

---

*End of design.*
