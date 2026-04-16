# Consolidation Controls — Design Spec

> Prompt 04. The most technically complex and commercially
> valuable feature in LMBR. HYBRID mode with source mapping
> is the competitive moat.

---

## 1. Problem

Large lumber jobs arrive as 20-page lists with 400+ line items
across multiple buildings/phases. Before sending to vendors,
the trader needs to control how the list is structured:

- **Vendors want aggregated totals** — a mill prices better on
  "525 pcs 2x4 #2 SPF 8'" than three separate building tallies.
- **Customers want their breakdown** — the quote must show
  pricing by building/phase so the GC can allocate costs.
- **LMBR holds the mapping** — the system tracks which
  consolidated row came from which source rows so the quote
  PDF can reconstruct the customer view from the vendor view.

No other lumber software does this. The source mapping is the moat.

---

## 2. Four Consolidation Modes

### STRUCTURED (default)

Keep the list exactly as extracted. All building/phase breaks
preserved. Vendor sees the same structure as the customer.
No transformation. No new rows.

### CONSOLIDATED

Aggregate all identical line items across the entire job into
single totals. Matching key: `species|dimension|grade|length|unit`.

Example:
- House 1: 200 pcs 2x4 #2 SPF 8'
- House 2: 150 pcs 2x4 #2 SPF 8'
- House 3: 175 pcs 2x4 #2 SPF 8'
- Consolidated: 525 pcs 2x4 #2 SPF 8' (source: H1, H2, H3)

Customer quote still shows by building. Vendor dispatch uses
the consolidated view.

### PHASED

Each phase is treated as an independent bid. The trader selects
which phases to quote now vs. defer to later.

- Active phases: consolidated or structured per trader choice.
- Deferred phases: line items stay as-is (structured, not
  consolidated). The bid can be re-submitted to `/api/consolidate`
  later with a different `activePhases` array to activate them.
- The bid does not advance past consolidation until at least
  one phase is active.

### HYBRID (most common for large jobs)

Vendor sees consolidated tally for best mill pricing. Customer
sees building/phase breakdown in quote. LMBR holds the internal
source mapping between the two.

This is LMBR's clearest competitive moat.

---

## 3. Data Layer

### 3.1 Migration 016: source_line_item_ids

```sql
-- Migration 016: consolidation source mapping
ALTER TABLE public.line_items
  ADD COLUMN IF NOT EXISTS source_line_item_ids uuid[] DEFAULT NULL;

-- GIN index for ANY() containment queries on source mapping
CREATE INDEX IF NOT EXISTS line_items_source_ids_gin
  ON public.line_items USING gin (source_line_item_ids)
  WHERE source_line_item_ids IS NOT NULL;

COMMENT ON COLUMN public.line_items.source_line_item_ids IS
  'Populated only on consolidated rows (is_consolidated = true). '
  'Array of UUIDs pointing to the original line_item rows that '
  'were aggregated into this consolidated row. Original rows '
  'leave this NULL. Follows the same UUID array pattern as '
  'bid_routings.line_item_ids.';
```

### 3.2 Column roles

| Column | Purpose |
|---|---|
| `is_consolidated` | `true` on aggregated rows, `false` on originals |
| `source_line_item_ids` | Full source map (all original row UUIDs) |
| `original_line_item_id` | Primary source pointer (highest-qty source) for single-row lookups |

### 3.3 Immutability rule

**Original rows (`is_consolidated = false`) are never modified or
deleted by consolidation.** Re-consolidation deletes only rows
where `bid_id = $1 AND is_consolidated = true`, then re-inserts.
This is the idempotency contract. A future developer must never
wipe source rows on a re-consolidation call.

### 3.4 Query patterns

```sql
-- Vendor dispatch: get consolidated view
SELECT * FROM line_items
WHERE bid_id = $1 AND is_consolidated = true
ORDER BY sort_order;

-- Quote PDF: reconstruct customer view for one consolidated row
SELECT * FROM line_items
WHERE id = ANY($1::uuid[]);  -- pass source_line_item_ids

-- Check if any consolidation exists for a bid
SELECT EXISTS(
  SELECT 1 FROM line_items
  WHERE bid_id = $1 AND is_consolidated = true
);

-- Active view (respects current mode):
-- STRUCTURED: WHERE bid_id = $1 AND is_consolidated = false
-- CONSOLIDATED/HYBRID: WHERE bid_id = $1 AND is_consolidated = true
-- PHASED: WHERE bid_id = $1 AND is_consolidated = false
--         AND phase_number = ANY($2::int[])
```

### 3.5 Types extension

Add to `@lmbr/types` line-item.ts:
```typescript
sourceLineItemIds: z.array(z.string().uuid()).nullable().optional(),
```

---

## 4. Consolidation Key

Implement the existing `consolidationKey()` stub in
`packages/lib/src/utils.ts`.

```
${species}|${dimension}|${grade}|${length}|${unit}
```

All fields normalized and lowercased. Null or empty fields
become the string `"unknown"` rather than an empty segment.
This prevents `SPF|2x4||8|PCS` and `SPF|2x4|unknown|8|PCS`
from being treated as different items when one just has a
missing grade.

Uses `normalizeSpecies`, `normalizeDimension`, `normalizeGrade`,
`normalizeLength`, `normalizeUnit` from `@lmbr/lib/lumber`.

---

## 5. Consolidation Agent

**File:** `packages/agents/src/consolidation-agent.ts`

Pure TypeScript. No LLM calls. Deterministic, testable, instant.

### 5.1 Input

```typescript
interface ConsolidationInput {
  lineItems: LineItemRow[];  // original rows from DB
  mode: ConsolidationMode;
  activePhases?: number[];   // PHASED mode only
}
```

### 5.2 Output

```typescript
interface ConsolidationResult {
  consolidatedItems: ConsolidatedLineItem[];
  sourceMap: Map<string, string[]>;  // consolidation_key → source UUIDs
  summary: {
    originalCount: number;
    consolidatedCount: number;
    reductionPercent: number;
    buildingCount: number;
    phaseCount: number;
    totalBoardFeet: number;
  };
  deferredPhases?: number[];  // PHASED: phases not in activePhases
}
```

### 5.3 Algorithm

1. Build consolidation key for each line item.
2. Group by key — items with identical keys across any
   building/phase are candidates for aggregation.
3. For each group:
   - Sum `quantity` and `board_feet`.
   - Collect all source UUIDs into `source_line_item_ids`.
   - Set `original_line_item_id` to the source with highest qty.
   - **Confidence: inherit the LOWEST confidence of all sources.**
     A consolidated row is only as trustworthy as its weakest
     source. This matters for QA display downstream.
   - Merge flags: union of all source flags, deduplicated.
   - `building_tag`: set to null (consolidated rows span buildings).
   - `is_consolidated`: true.
4. Return consolidated items + source map + summary stats.

### 5.4 Mode-specific behavior

**STRUCTURED:** Return originals unchanged. No consolidated rows.

**CONSOLIDATED:** Run full aggregation. All buildings merged.

**PHASED:**
- Only aggregate within active phases (per `activePhases` array).
- Deferred phase line items stay as-is (structured).
- If `activePhases` is empty or missing, reject with error
  "at least one phase must be active."

**HYBRID:** Run CONSOLIDATED aggregation for the vendor view.
Original rows preserved for the customer view. Both views
returned in the result.

---

## 6. API Route

**File:** `apps/web/src/app/api/consolidate/route.ts`

### 6.1 Request

```typescript
{
  bidId: string;
  mode: 'structured' | 'consolidated' | 'phased' | 'hybrid';
  activePhases?: number[];  // required for PHASED mode
}
```

### 6.2 Flow

1. Auth + RLS check. Verify bid exists and belongs to user's
   company.
2. Verify bid status is `reviewing` or `routing` — reject 409
   if already past consolidation stage.
3. Fetch original (non-consolidated) line items:
   `WHERE bid_id = $1 AND is_consolidated = false`
4. **Delete existing consolidated rows only:**
   `DELETE FROM line_items WHERE bid_id = $1 AND is_consolidated = true`
   **Never touch rows where `is_consolidated = false`.** Original
   rows are immutable.
5. If mode is STRUCTURED: skip to step 7 (no rows to insert).
6. Call `consolidationAgent()` with line items + mode.
   Insert new consolidated `line_items` rows with:
   - `is_consolidated = true`
   - `source_line_item_ids = [uuid1, uuid2, ...]`
   - `original_line_item_id = highest-qty source UUID`
   - Aggregated `quantity`, `board_feet`
   - Lowest `confidence` from sources (via extraction_confidence)
7. Update `bids.consolidation_mode = mode`.
8. Return response.

### 6.3 Response

```typescript
{
  success: true,
  mode: ConsolidationMode,
  consolidated_items: LineItem[],     // new consolidated rows (empty for STRUCTURED)
  original_count: number,
  consolidated_count: number,
  reduction_percent: number,
  deferred_phases?: number[],         // PHASED only
  summary: { ... }
}
```

### 6.4 Error codes

- 400: missing bidId, invalid mode, PHASED with no active phases
- 403: bid belongs to different company
- 404: bid not found
- 409: bid already past consolidation stage
- 500: unexpected errors

---

## 7. UI Component

**File:** `apps/web/src/components/bids/consolidation-controls.tsx`

### 7.1 Layout

Pre-send control panel between extraction review and routing.

- **Mode selector:** 4 cards in a horizontal row. Each card:
  - Icon (32px)
  - Title (Heading 4)
  - One-line description (Body SM)
  - Selected: teal border + accent background + checkmark
  - HYBRID: "Recommended" badge for bids with 3+ buildings

- **Preview panel** (below selector, varies by mode):
  - STRUCTURED: no preview — "List will be sent as-is"
  - CONSOLIDATED: side-by-side table — original vs. aggregated
  - PHASED: phase checklist with "Quote now" / "Quote later" toggles
  - HYBRID: split preview —
    LEFT: "What vendors see" (consolidated)
    RIGHT: "What customer sees" (structured)

### 7.2 HYBRID summary line (critical UX moment)

The preview panel for HYBRID and CONSOLIDATED modes must show:

```
847 line items -> 312 consolidated items (63% reduction)
Vendor sends: 312 lines   Customer sees: 847 lines
```

This is the moment the trader sees the value. Do not skip it.

### 7.3 Confirm button

"Apply & continue to routing" — calls `POST /api/consolidate`,
then navigates to the routing step.

---

## 8. Consolidation Page

**File:** `apps/web/src/app/bids/[bidId]/consolidate/page.tsx`

Full-page consolidation workspace.

- **Summary stats bar:** total buildings, total phases, total
  line items, total board feet (stat cards per design system)
- **Mode selector** (same as component, embedded)
- **Preview panel** (same as component, full-width)
- **Line item table** showing the active view:
  - STRUCTURED: original items with building group headers
  - CONSOLIDATED: aggregated items with source count badge
  - HYBRID: tabbed view — "Vendor view" / "Customer view"
- **For PHASED mode:** phase cards with status toggles
  (Quote now / Quote later / On hold) and notes field per phase
- **Save and continue button** — same as confirm, advances
  to routing

---

## 9. Scope Exclusions

- **Mobile bid detail** (`apps/mobile/src/app/bids/[bidId].tsx`):
  Deferred per design doc section 3.12. Prompt 12 scope.
- **Drag-and-drop phase reordering:** YAGNI. Phase status
  toggles are sufficient. If traders need reordering, add it
  in a future iteration.
- **LLM-assisted consolidation:** The agent is deterministic.
  No Claude calls. Future soft-matching (fuzzy species aliases)
  can layer on top but is not in scope.

---

## 10. Files to Create/Modify

| File | Action |
|---|---|
| `supabase/migrations/016_consolidation_source_map.sql` | Create |
| `packages/types/src/line-item.ts` | Add `sourceLineItemIds` field |
| `packages/lib/src/utils.ts` | Implement `consolidationKey()` |
| `packages/agents/src/consolidation-agent.ts` | Create |
| `packages/agents/src/index.ts` | Add consolidation-agent export |
| `apps/web/src/app/api/consolidate/route.ts` | Implement |
| `apps/web/src/components/bids/consolidation-controls.tsx` | Implement |
| `apps/web/src/app/bids/[bidId]/consolidate/page.tsx` | Implement |
| `CLAUDE.md` | Mark Prompt 04 complete |
