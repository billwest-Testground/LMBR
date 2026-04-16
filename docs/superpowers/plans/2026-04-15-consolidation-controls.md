# Consolidation Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the consolidation control system — 4 modes (STRUCTURED, CONSOLIDATED, PHASED, HYBRID) with source mapping, pure-TS agent, API route, and UI.

**Architecture:** Consolidation creates new `line_items` rows with `is_consolidated = true` alongside originals. A `source_line_item_ids uuid[]` column stores the full source map. The consolidation agent is deterministic pure TypeScript (no LLM). The API route is idempotent — re-consolidation deletes only consolidated rows, never originals.

**Tech Stack:** TypeScript, Supabase Postgres, Next.js 14 App Router, React, Tailwind CSS, Zod.

**Spec:** `docs/superpowers/specs/2026-04-15-consolidation-controls-design.md`

---

### Task 1: Migration 016 — source_line_item_ids column

**Files:**
- Create: `supabase/migrations/016_consolidation_source_map.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 016_consolidation_source_map.sql
-- Adds source_line_item_ids UUID array to line_items for consolidation
-- source mapping. Follows the same UUID array pattern as
-- bid_routings.line_item_ids.

ALTER TABLE public.line_items
  ADD COLUMN IF NOT EXISTS source_line_item_ids uuid[] DEFAULT NULL;

-- GIN index for ANY() containment queries on source mapping.
CREATE INDEX IF NOT EXISTS line_items_source_ids_gin
  ON public.line_items USING gin (source_line_item_ids)
  WHERE source_line_item_ids IS NOT NULL;

COMMENT ON COLUMN public.line_items.source_line_item_ids IS
  'Populated only on consolidated rows (is_consolidated = true). '
  'Array of UUIDs pointing to the original line_item rows that '
  'were aggregated into this consolidated row. Original rows '
  'leave this NULL.';
```

- [ ] **Step 2: Add sourceLineItemIds to LineItemSchema**

In `packages/types/src/line-item.ts`, add after `originalLineItemId` (line 71):

```typescript
sourceLineItemIds: z.array(z.string().uuid()).nullable().optional(),
```

- [ ] **Step 3: Run tsc --noEmit on @lmbr/types**

Run: `npx tsc --noEmit -p packages/types/tsconfig.json`
Expected: clean (0 errors)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/016_consolidation_source_map.sql packages/types/src/line-item.ts
git commit -m "feat(consolidation): migration 016 — source_line_item_ids uuid[]

Adds source_line_item_ids column to line_items for consolidation
source mapping. GIN index for ANY() queries. Follows the UUID
array pattern from bid_routings.line_item_ids.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: consolidationKey() in @lmbr/lib

**Files:**
- Modify: `packages/lib/src/utils.ts` (lines 33–41)

- [ ] **Step 1: Implement consolidationKey()**

Replace the stub in `packages/lib/src/utils.ts`:

```typescript
import {
  normalizeDimension,
  normalizeGrade,
  normalizeLength,
  normalizeSpecies,
  normalizeUnit,
} from './lumber';

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
```

Note: The function signature changes from the stub. The stub used `thickness`/`width`/`length` as numbers, but the actual data model uses `species`/`dimension`/`grade`/`length`/`unit` as strings. Update the signature to match the real schema.

Also implement the three utility stubs (`cn`, `formatCurrency`, `formatBoardFeet`) since the UI tasks will need them:

```typescript
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
```

- [ ] **Step 2: Run tsc --noEmit on @lmbr/lib**

Run: `npx tsc --noEmit -p packages/lib/tsconfig.json`
Expected: clean (0 errors)

- [ ] **Step 3: Write inline verification test**

Create `tmp-smoke-test/verify-consolidation-key.ts`:

```typescript
import { consolidationKey } from '@lmbr/lib';

const tests = [
  {
    input: { species: 'SPF', dimension: '2x4', grade: '#2', length: '8', unit: 'PCS' },
    expected: 'spf|2x4|#2|8|pcs',
  },
  {
    input: { species: 'DF', dimension: '4x4', grade: '', length: '12', unit: 'PCS' },
    expected: 'df|4x4|unknown|12|pcs',
  },
  {
    input: { species: 'OSB', dimension: '7/16', grade: null, length: null, unit: 'MSF' },
    expected: 'osb|unknown|unknown|unknown|msf',
  },
  {
    input: { species: 'spf', dimension: '2X4', grade: '#2', length: '8', unit: 'pcs' },
    expected: 'spf|2x4|#2|8|pcs',  // same as first — normalization
  },
];

let pass = 0;
for (const t of tests) {
  const result = consolidationKey(t.input);
  if (result === t.expected) {
    console.log(`PASS: ${result}`);
    pass++;
  } else {
    console.log(`FAIL: expected "${t.expected}", got "${result}"`);
  }
}
console.log(`\n${pass}/${tests.length} passed`);
if (pass !== tests.length) process.exit(1);
```

Run: `pnpm add -D tsx -w --silent && pnpm exec tsx tmp-smoke-test/verify-consolidation-key.ts`
Expected: 4/4 passed

- [ ] **Step 4: Clean up and commit**

```bash
rm -rf tmp-smoke-test
pnpm remove tsx -w --silent
git add packages/lib/src/utils.ts
git commit -m "feat(consolidation): implement consolidationKey() + utility stubs

Consolidation key: species|dimension|grade|length|unit, all
normalized and lowercased. Empty/null fields become 'unknown'.

Also implements cn(), formatCurrency(), formatBoardFeet() stubs
needed by downstream UI components.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Consolidation Agent

**Files:**
- Create: `packages/agents/src/consolidation-agent.ts`
- Modify: `packages/agents/src/index.ts` (add export)

- [ ] **Step 1: Create the consolidation agent**

Create `packages/agents/src/consolidation-agent.ts`:

```typescript
/**
 * Consolidation agent — aggregate line items for mill pricing.
 *
 * Purpose:  Pure TypeScript, no LLM. Takes a set of line items and a
 *           consolidation mode, returns aggregated items with source
 *           mapping. The source map is the core of HYBRID mode — vendors
 *           see consolidated totals, customers see building/phase breakdown,
 *           LMBR holds the link between the two.
 *
 * Inputs:   line items (from DB) + consolidation mode + optional active phases.
 * Outputs:  ConsolidationResult — consolidated items, source map, summary.
 * Agent/API: none — pure TypeScript.
 * Imports:  @lmbr/lib (consolidationKey, normalizeSpecies), @lmbr/types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { consolidationKey } from '@lmbr/lib';
import type { ConsolidationMode } from '@lmbr/types';

// -----------------------------------------------------------------------------
// Input / output types
// -----------------------------------------------------------------------------

export interface ConsolidationLineItem {
  id: string;
  bidId: string;
  companyId: string;
  buildingTag: string | null;
  phaseNumber: number | null;
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number;
  unit: string;
  boardFeet: number | null;
  confidence: number | null;
  flags: string[];
  sortOrder: number;
  extractionMethod: string | null;
  extractionConfidence: number | null;
  costCents: number | null;
}

export interface ConsolidatedItem {
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number;
  unit: string;
  boardFeet: number;
  confidence: number;
  flags: string[];
  sourceLineItemIds: string[];
  originalLineItemId: string;
  sortOrder: number;
  consolidationKey: string;
}

export interface ConsolidationResult {
  consolidatedItems: ConsolidatedItem[];
  summary: {
    originalCount: number;
    consolidatedCount: number;
    reductionPercent: number;
    buildingCount: number;
    phaseCount: number;
    totalBoardFeet: number;
  };
  deferredPhases: number[];
}

export interface ConsolidationInput {
  lineItems: ConsolidationLineItem[];
  mode: ConsolidationMode;
  activePhases?: number[];
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

export function consolidationAgent(input: ConsolidationInput): ConsolidationResult {
  const { lineItems, mode, activePhases } = input;

  const buildingTags = new Set(
    lineItems.map((li) => li.buildingTag).filter(Boolean),
  );
  const phaseNumbers = new Set(
    lineItems.map((li) => li.phaseNumber).filter((p): p is number => p != null),
  );
  const totalBoardFeet = lineItems.reduce(
    (sum, li) => sum + (li.boardFeet ?? 0),
    0,
  );

  const baseSummary = {
    originalCount: lineItems.length,
    buildingCount: buildingTags.size,
    phaseCount: phaseNumbers.size,
    totalBoardFeet: Math.round(totalBoardFeet * 100) / 100,
  };

  if (mode === 'structured') {
    return {
      consolidatedItems: [],
      summary: {
        ...baseSummary,
        consolidatedCount: lineItems.length,
        reductionPercent: 0,
      },
      deferredPhases: [],
    };
  }

  if (mode === 'phased') {
    return runPhasedConsolidation(lineItems, activePhases ?? [], baseSummary);
  }

  // CONSOLIDATED and HYBRID both run the same aggregation logic.
  // The difference is semantic — HYBRID preserves originals for the
  // customer view while CONSOLIDATED replaces them for dispatch.
  // Both produce the same consolidated rows.
  const consolidated = aggregateItems(lineItems);

  return {
    consolidatedItems: consolidated,
    summary: {
      ...baseSummary,
      consolidatedCount: consolidated.length,
      reductionPercent:
        lineItems.length === 0
          ? 0
          : Math.round(
              ((lineItems.length - consolidated.length) / lineItems.length) * 100,
            ),
    },
    deferredPhases: [],
  };
}

// -----------------------------------------------------------------------------
// Aggregation
// -----------------------------------------------------------------------------

function aggregateItems(lineItems: ConsolidationLineItem[]): ConsolidatedItem[] {
  const groups = new Map<
    string,
    {
      items: ConsolidationLineItem[];
      key: string;
    }
  >();

  for (const item of lineItems) {
    const key = consolidationKey({
      species: item.species,
      dimension: item.dimension,
      grade: item.grade,
      length: item.length,
      unit: item.unit,
    });

    const group = groups.get(key);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(key, { items: [item], key });
    }
  }

  const result: ConsolidatedItem[] = [];
  let sortOrder = 0;

  for (const [, group] of groups) {
    const items = group.items;
    const first = items[0];
    if (!first) continue;

    const totalQty = items.reduce((s, i) => s + i.quantity, 0);
    const totalBf = items.reduce((s, i) => s + (i.boardFeet ?? 0), 0);

    // Lowest confidence — a consolidated row is only as trustworthy
    // as its weakest source.
    const confidence = items.reduce(
      (min, i) => Math.min(min, i.confidence ?? i.extractionConfidence ?? 1),
      1,
    );

    // Union of all flags, deduplicated.
    const allFlags = new Set<string>();
    for (const item of items) {
      for (const flag of item.flags) allFlags.add(flag);
    }

    // Primary source pointer: highest quantity source.
    const primarySource = items.reduce((best, i) =>
      i.quantity > best.quantity ? i : best,
    );

    result.push({
      species: first.species,
      dimension: first.dimension,
      grade: first.grade,
      length: first.length,
      quantity: Math.round(totalQty * 10000) / 10000,
      unit: first.unit,
      boardFeet: Math.round(totalBf * 100) / 100,
      confidence: Math.round(confidence * 10000) / 10000,
      flags: [...allFlags],
      sourceLineItemIds: items.map((i) => i.id),
      originalLineItemId: primarySource.id,
      sortOrder: sortOrder++,
      consolidationKey: group.key,
    });
  }

  return result;
}

// -----------------------------------------------------------------------------
// Phased consolidation
// -----------------------------------------------------------------------------

function runPhasedConsolidation(
  lineItems: ConsolidationLineItem[],
  activePhases: number[],
  baseSummary: {
    originalCount: number;
    buildingCount: number;
    phaseCount: number;
    totalBoardFeet: number;
  },
): ConsolidationResult {
  if (activePhases.length === 0) {
    throw new Error('At least one phase must be active for PHASED mode.');
  }

  const activeSet = new Set(activePhases);
  const activeItems = lineItems.filter(
    (li) => li.phaseNumber != null && activeSet.has(li.phaseNumber),
  );

  const allPhases = new Set(
    lineItems.map((li) => li.phaseNumber).filter((p): p is number => p != null),
  );
  const deferredPhases = [...allPhases].filter((p) => !activeSet.has(p));

  const consolidated = aggregateItems(activeItems);

  return {
    consolidatedItems: consolidated,
    summary: {
      ...baseSummary,
      consolidatedCount: consolidated.length,
      reductionPercent:
        activeItems.length === 0
          ? 0
          : Math.round(
              ((activeItems.length - consolidated.length) / activeItems.length) *
                100,
            ),
    },
    deferredPhases,
  };
}
```

- [ ] **Step 2: Add export to agents index**

In `packages/agents/src/index.ts`, add:

```typescript
export * from './consolidation-agent';
```

- [ ] **Step 3: Run tsc --noEmit on @lmbr/agents**

Run: `npx tsc --noEmit -p packages/agents/tsconfig.json`
Expected: clean (0 errors)

- [ ] **Step 4: Write HYBRID mode verification test**

Create `tmp-smoke-test/verify-consolidation-agent.ts`:

```typescript
import { consolidationAgent, type ConsolidationLineItem } from '@lmbr/agents';

// Build test data: 3 buildings, overlapping species
const makeItem = (
  id: string,
  building: string,
  species: string,
  dim: string,
  grade: string,
  length: string,
  qty: number,
  bf: number,
  conf: number,
): ConsolidationLineItem => ({
  id, bidId: 'bid-1', companyId: 'co-1',
  buildingTag: building, phaseNumber: null,
  species, dimension: dim, grade, length,
  quantity: qty, unit: 'PCS', boardFeet: bf,
  confidence: conf, flags: [], sortOrder: 0,
  extractionMethod: 'excel_parse', extractionConfidence: conf, costCents: 0,
});

const items: ConsolidationLineItem[] = [
  makeItem('a1', 'House 1', 'SPF', '2x4', '#2', '8', 200, 1066.67, 0.97),
  makeItem('a2', 'House 1', 'SPF', '2x6', '#2', '10', 100, 1000, 0.95),
  makeItem('a3', 'House 1', 'DF', '4x4', '#1', '12', 50, 800, 0.90),
  makeItem('b1', 'House 2', 'SPF', '2x4', '#2', '8', 150, 800, 0.98),
  makeItem('b2', 'House 2', 'SPF', '2x6', '#2', '10', 75, 750, 0.92),
  makeItem('c1', 'House 3', 'SPF', '2x4', '#2', '8', 175, 933.33, 0.85),
];

console.log('=== HYBRID mode test ===');
const result = consolidationAgent({ lineItems: items, mode: 'hybrid' });

console.log(`Original: ${result.summary.originalCount} items`);
console.log(`Consolidated: ${result.summary.consolidatedCount} items`);
console.log(`Reduction: ${result.summary.reductionPercent}%`);
console.log();

let allPass = true;

// Check: 6 items should consolidate to 3 (SPF 2x4, SPF 2x6, DF 4x4)
if (result.summary.consolidatedCount !== 3) {
  console.log(`FAIL: expected 3 consolidated items, got ${result.summary.consolidatedCount}`);
  allPass = false;
} else {
  console.log('PASS: 3 consolidated items');
}

// Check SPF 2x4: should aggregate a1 + b1 + c1
const spf2x4 = result.consolidatedItems.find(
  (i) => i.species === 'SPF' && i.dimension === '2x4',
);
if (!spf2x4) {
  console.log('FAIL: SPF 2x4 not found');
  allPass = false;
} else {
  // qty: 200 + 150 + 175 = 525
  if (spf2x4.quantity !== 525) {
    console.log(`FAIL: SPF 2x4 qty expected 525, got ${spf2x4.quantity}`);
    allPass = false;
  } else {
    console.log('PASS: SPF 2x4 qty = 525');
  }

  // source_line_item_ids: [a1, b1, c1]
  if (spf2x4.sourceLineItemIds.length !== 3) {
    console.log(`FAIL: SPF 2x4 sources expected 3, got ${spf2x4.sourceLineItemIds.length}`);
    allPass = false;
  } else {
    console.log('PASS: SPF 2x4 sources = 3');
  }

  // Verify exact source IDs
  const expectedSources = new Set(['a1', 'b1', 'c1']);
  const actualSources = new Set(spf2x4.sourceLineItemIds);
  const sourcesMatch = [...expectedSources].every((s) => actualSources.has(s));
  if (!sourcesMatch) {
    console.log(`FAIL: SPF 2x4 source IDs don't match`);
    allPass = false;
  } else {
    console.log('PASS: SPF 2x4 source IDs match [a1, b1, c1]');
  }

  // Confidence: min(0.97, 0.98, 0.85) = 0.85
  if (spf2x4.confidence !== 0.85) {
    console.log(`FAIL: SPF 2x4 confidence expected 0.85, got ${spf2x4.confidence}`);
    allPass = false;
  } else {
    console.log('PASS: SPF 2x4 confidence = 0.85 (lowest source)');
  }

  // original_line_item_id: a1 (highest qty = 200)
  if (spf2x4.originalLineItemId !== 'a1') {
    console.log(`FAIL: SPF 2x4 primary source expected a1, got ${spf2x4.originalLineItemId}`);
    allPass = false;
  } else {
    console.log('PASS: SPF 2x4 primary source = a1 (highest qty)');
  }

  // Customer view reconstruction: query source IDs should return originals
  const customerViewIds = spf2x4.sourceLineItemIds;
  const customerViewItems = items.filter((i) => customerViewIds.includes(i.id));
  if (customerViewItems.length !== 3) {
    console.log(`FAIL: customer view reconstruction expected 3 items, got ${customerViewItems.length}`);
    allPass = false;
  } else {
    const customerQtySum = customerViewItems.reduce((s, i) => s + i.quantity, 0);
    if (customerQtySum !== 525) {
      console.log(`FAIL: customer view qty sum expected 525, got ${customerQtySum}`);
      allPass = false;
    } else {
      console.log('PASS: customer view reconstructs correctly from source IDs');
    }
  }
}

// Check STRUCTURED mode returns empty consolidated items
const structured = consolidationAgent({ lineItems: items, mode: 'structured' });
if (structured.consolidatedItems.length !== 0) {
  console.log(`FAIL: STRUCTURED should return 0 consolidated items, got ${structured.consolidatedItems.length}`);
  allPass = false;
} else {
  console.log('PASS: STRUCTURED returns 0 consolidated items');
}

console.log(`\n${allPass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
if (!allPass) process.exit(1);
```

Run: `pnpm add -D tsx -w --silent && pnpm exec tsx tmp-smoke-test/verify-consolidation-agent.ts`
Expected: ALL TESTS PASSED

- [ ] **Step 5: Clean up and commit**

```bash
rm -rf tmp-smoke-test
pnpm remove tsx -w --silent
git add packages/agents/src/consolidation-agent.ts packages/agents/src/index.ts
git commit -m "feat(consolidation): consolidation agent — pure TS, no LLM

4 modes: STRUCTURED (no-op), CONSOLIDATED (full aggregation),
PHASED (active phase selection), HYBRID (dual view).

Key rules:
- Consolidation key: species|dimension|grade|length|unit
- Confidence: inherits LOWEST of all sources
- Source mapping: source_line_item_ids UUID array
- Primary source: original_line_item_id = highest-qty source
- Flags: union of all source flags, deduplicated

HYBRID mode verified: 6 items → 3 consolidated, source IDs
correct, customer view reconstruction exact match.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: POST /api/consolidate route

**Files:**
- Modify: `apps/web/src/app/api/consolidate/route.ts`

- [ ] **Step 1: Implement the route**

Replace the stub in `apps/web/src/app/api/consolidate/route.ts`:

```typescript
/**
 * POST /api/consolidate — Apply consolidation mode to a bid.
 *
 * Purpose:  Pre-send control. After extraction review, the trader selects
 *           a consolidation mode. This route runs the consolidation agent,
 *           creates new aggregated line_items rows (is_consolidated = true),
 *           and updates the bid's consolidation_mode.
 *
 *           Idempotent: re-consolidation deletes only rows where
 *           is_consolidated = true, never originals.
 *
 * Inputs:   { bidId, mode, activePhases? }
 * Outputs:  { success, mode, consolidated_items, summary }
 * Agent/API: @lmbr/agents consolidationAgent (pure TS).
 * Imports:  @lmbr/agents, @lmbr/lib, @lmbr/types, zod, next/server.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  consolidationAgent,
  type ConsolidationLineItem,
} from '@lmbr/agents';
import { getSupabaseAdmin } from '@lmbr/lib';
import { ConsolidationModeSchema } from '@lmbr/types';

import { getSupabaseRouteHandlerClient } from '../../../lib/supabase/server';

export const runtime = 'nodejs';

const BodySchema = z.object({
  bidId: z.string().uuid(),
  mode: ConsolidationModeSchema,
  activePhases: z.array(z.number().int()).optional(),
});

const CONSOLIDATABLE_STATUSES = new Set(['reviewing', 'routing']);

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = BodySchema.safeParse(await req.json());
    if (!body.success) {
      return NextResponse.json(
        { error: body.error.errors[0]?.message ?? 'Invalid request body' },
        { status: 400 },
      );
    }
    const { bidId, mode, activePhases } = body.data;

    if (mode === 'phased' && (!activePhases || activePhases.length === 0)) {
      return NextResponse.json(
        { error: 'PHASED mode requires at least one active phase' },
        { status: 400 },
      );
    }

    // Auth + tenant gate
    const sessionClient = getSupabaseRouteHandlerClient();
    const {
      data: { session },
    } = await sessionClient.auth.getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: profile } = await sessionClient
      .from('users')
      .select('id, company_id')
      .eq('id', session.user.id)
      .maybeSingle();
    if (!profile?.company_id) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 403 });
    }

    // Fetch bid (RLS-scoped)
    const { data: bid, error: bidError } = await sessionClient
      .from('bids')
      .select('id, company_id, status')
      .eq('id', bidId)
      .maybeSingle();
    if (bidError) {
      return NextResponse.json({ error: bidError.message }, { status: 500 });
    }
    if (!bid) {
      return NextResponse.json({ error: 'Bid not found' }, { status: 404 });
    }
    if (bid.company_id !== profile.company_id) {
      return NextResponse.json(
        { error: 'Bid belongs to a different company' },
        { status: 403 },
      );
    }
    if (!CONSOLIDATABLE_STATUSES.has(bid.status)) {
      return NextResponse.json(
        {
          error: `Bid status is '${bid.status}' — consolidation requires 'reviewing' or 'routing'`,
        },
        { status: 409 },
      );
    }

    const admin = getSupabaseAdmin();

    // Fetch original (non-consolidated) line items
    const { data: originals, error: liError } = await admin
      .from('line_items')
      .select(
        'id, bid_id, company_id, building_tag, phase_number, species, dimension, ' +
        'grade, length, quantity, unit, board_feet, notes, sort_order, ' +
        'extraction_method, extraction_confidence, cost_cents',
      )
      .eq('bid_id', bidId)
      .eq('company_id', profile.company_id)
      .eq('is_consolidated', false)
      .order('sort_order', { ascending: true });
    if (liError) {
      return NextResponse.json({ error: liError.message }, { status: 500 });
    }
    if (!originals || originals.length === 0) {
      return NextResponse.json(
        { error: 'No line items found for this bid' },
        { status: 400 },
      );
    }

    // Delete existing consolidated rows ONLY. Never touch originals.
    await admin
      .from('line_items')
      .delete()
      .eq('bid_id', bidId)
      .eq('is_consolidated', true);

    // For STRUCTURED mode, just update the bid and return.
    if (mode === 'structured') {
      await admin
        .from('bids')
        .update({ consolidation_mode: mode })
        .eq('id', bidId);
      return NextResponse.json({
        success: true,
        mode,
        consolidated_items: [],
        original_count: originals.length,
        consolidated_count: originals.length,
        reduction_percent: 0,
        summary: {
          originalCount: originals.length,
          consolidatedCount: originals.length,
          reductionPercent: 0,
        },
      });
    }

    // Parse DB rows into agent input shape
    const agentItems: ConsolidationLineItem[] = originals.map((row) => {
      let flags: string[] = [];
      if (row.notes) {
        try {
          const parsed = JSON.parse(row.notes);
          if (Array.isArray(parsed.flags)) flags = parsed.flags;
        } catch { /* not JSON, ignore */ }
      }
      return {
        id: row.id,
        bidId: row.bid_id,
        companyId: row.company_id,
        buildingTag: row.building_tag,
        phaseNumber: row.phase_number,
        species: row.species,
        dimension: row.dimension,
        grade: row.grade,
        length: row.length,
        quantity: Number(row.quantity),
        unit: row.unit,
        boardFeet: row.board_feet != null ? Number(row.board_feet) : null,
        confidence: row.extraction_confidence,
        flags,
        sortOrder: row.sort_order,
        extractionMethod: row.extraction_method,
        extractionConfidence: row.extraction_confidence,
        costCents: row.cost_cents,
      };
    });

    // Run consolidation agent
    const result = consolidationAgent({
      lineItems: agentItems,
      mode,
      activePhases,
    });

    // Insert consolidated rows
    if (result.consolidatedItems.length > 0) {
      const insertRows = result.consolidatedItems.map((item) => ({
        bid_id: bidId,
        company_id: profile.company_id,
        building_tag: null,
        phase_number: null,
        species: item.species,
        dimension: item.dimension,
        grade: item.grade,
        length: item.length,
        quantity: item.quantity,
        unit: item.unit,
        board_feet: item.boardFeet,
        notes: JSON.stringify({
          confidence: item.confidence,
          flags: item.flags,
          consolidation_key: item.consolidationKey,
        }),
        is_consolidated: true,
        original_line_item_id: item.originalLineItemId,
        source_line_item_ids: item.sourceLineItemIds,
        sort_order: item.sortOrder,
        extraction_method: null,
        extraction_confidence: item.confidence,
        cost_cents: 0,
      }));

      const { error: insertError } = await admin
        .from('line_items')
        .insert(insertRows);
      if (insertError) {
        return NextResponse.json(
          { error: `Failed to insert consolidated rows: ${insertError.message}` },
          { status: 500 },
        );
      }
    }

    // Update bid consolidation mode
    await admin
      .from('bids')
      .update({ consolidation_mode: mode })
      .eq('id', bidId);

    return NextResponse.json({
      success: true,
      mode,
      consolidated_items: result.consolidatedItems,
      original_count: result.summary.originalCount,
      consolidated_count: result.summary.consolidatedCount,
      reduction_percent: result.summary.reductionPercent,
      deferred_phases: result.deferredPhases.length > 0
        ? result.deferredPhases
        : undefined,
      summary: result.summary,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Consolidation failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Run tsc --noEmit**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | grep "error TS" | grep -v "console-sidebar\|bid-card\|login/page"`
Expected: no new errors (only the 9 pre-existing)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/consolidate/route.ts
git commit -m "feat(consolidation): POST /api/consolidate route

Idempotent: deletes only is_consolidated=true rows, never
originals. Handles all 4 modes. PHASED requires activePhases.
Inserts consolidated line_items with source_line_item_ids and
original_line_item_id. Updates bids.consolidation_mode.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: ConsolidationControls UI component

**Files:**
- Modify: `apps/web/src/components/bids/consolidation-controls.tsx`

- [ ] **Step 1: Implement the component**

Replace the stub in `apps/web/src/components/bids/consolidation-controls.tsx`:

```typescript
/**
 * ConsolidationControls — pre-send mode selector + preview.
 *
 * Purpose:  After extraction review and before routing, the trader selects
 *           how the list should be structured for vendor dispatch. Four modes:
 *           STRUCTURED (default), CONSOLIDATED, PHASED, HYBRID (recommended
 *           for 3+ buildings).
 *
 * Inputs:   bidId, lineItems (original), buildingCount, onConfirm callback.
 * Outputs:  JSX — mode selector cards + preview panel + confirm button.
 * Agent/API: POST /api/consolidate on confirm.
 * Imports:  react, @lmbr/types.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
import type { ConsolidationMode } from '@lmbr/types';
import { consolidationAgent, type ConsolidationLineItem } from '@lmbr/agents';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface ConsolidationControlsProps {
  bidId: string;
  lineItems: ConsolidationLineItem[];
  buildingCount: number;
  phaseNumbers: number[];
  onConfirm: (mode: ConsolidationMode) => void;
}

interface ModeCard {
  mode: ConsolidationMode;
  title: string;
  description: string;
  icon: string;
}

const MODES: ModeCard[] = [
  {
    mode: 'structured',
    title: 'Structured',
    description: 'Keep list exactly as extracted. All building breaks preserved.',
    icon: 'Layers',
  },
  {
    mode: 'consolidated',
    title: 'Consolidated',
    description: 'Aggregate like items across all buildings for best mill pricing.',
    icon: 'Merge',
  },
  {
    mode: 'phased',
    title: 'Phased',
    description: 'Quote each phase independently. Select which phases to include.',
    icon: 'Calendar',
  },
  {
    mode: 'hybrid',
    title: 'Hybrid',
    description: 'Consolidated for vendors, structured for customer quote.',
    icon: 'Split',
  },
];

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function ConsolidationControls({
  bidId,
  lineItems,
  buildingCount,
  phaseNumbers,
  onConfirm,
}: ConsolidationControlsProps) {
  const [selectedMode, setSelectedMode] = useState<ConsolidationMode>(
    buildingCount >= 3 ? 'hybrid' : 'structured',
  );
  const [activePhases, setActivePhases] = useState<number[]>(phaseNumbers);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preview: run the agent locally for instant feedback
  const preview = useMemo(() => {
    if (selectedMode === 'structured') return null;
    try {
      return consolidationAgent({
        lineItems,
        mode: selectedMode === 'phased' ? 'phased' : selectedMode,
        activePhases: selectedMode === 'phased' ? activePhases : undefined,
      });
    } catch {
      return null;
    }
  }, [lineItems, selectedMode, activePhases]);

  const handleConfirm = useCallback(async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/consolidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bidId,
          mode: selectedMode,
          activePhases: selectedMode === 'phased' ? activePhases : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Consolidation failed');
      }
      onConfirm(selectedMode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Consolidation failed');
    } finally {
      setIsSubmitting(false);
    }
  }, [bidId, selectedMode, activePhases, onConfirm]);

  const togglePhase = useCallback((phase: number) => {
    setActivePhases((prev) =>
      prev.includes(phase)
        ? prev.filter((p) => p !== phase)
        : [...prev, phase],
    );
  }, []);

  return (
    <div className="space-y-6">
      {/* Mode selector */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {MODES.map((m) => (
          <button
            key={m.mode}
            onClick={() => setSelectedMode(m.mode)}
            className={`relative rounded border p-4 text-left transition-all duration-150 ${
              selectedMode === m.mode
                ? 'border-accent-primary bg-accent-primary/[0.08]'
                : 'border-border-base bg-bg-surface hover:border-border-strong'
            }`}
          >
            {selectedMode === m.mode && (
              <div className="absolute right-2 top-2 h-5 w-5 rounded-full bg-accent-primary flex items-center justify-center">
                <span className="text-xs text-text-inverse font-bold">
                  &#10003;
                </span>
              </div>
            )}
            {m.mode === 'hybrid' && buildingCount >= 3 && (
              <span className="absolute left-2 top-2 rounded-full bg-accent-warm px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-inverse">
                Recommended
              </span>
            )}
            <div className="mt-4">
              <h4 className="text-[15px] font-semibold text-text-primary">
                {m.title}
              </h4>
              <p className="mt-1 text-[13px] text-text-secondary">
                {m.description}
              </p>
            </div>
          </button>
        ))}
      </div>

      {/* Preview panel */}
      {selectedMode !== 'structured' && preview && (
        <div className="rounded border border-border-base bg-bg-subtle p-4">
          {/* Summary line — the key UX moment */}
          <div className="mb-4 text-center">
            <p className="text-lg font-semibold text-text-primary">
              {preview.summary.originalCount} line items{' '}
              <span className="text-accent-primary">&#8594;</span>{' '}
              {preview.summary.consolidatedCount} consolidated items{' '}
              <span className="text-accent-warm">
                ({preview.summary.reductionPercent}% reduction)
              </span>
            </p>
            {selectedMode === 'hybrid' && (
              <p className="mt-1 text-sm text-text-secondary">
                Vendor sends: {preview.summary.consolidatedCount} lines
                &nbsp;&nbsp;|&nbsp;&nbsp;
                Customer sees: {preview.summary.originalCount} lines
              </p>
            )}
          </div>

          {/* PHASED: phase toggles */}
          {selectedMode === 'phased' && phaseNumbers.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
                Select phases to quote now
              </p>
              {phaseNumbers.map((phase) => (
                <label
                  key={phase}
                  className="flex items-center gap-3 rounded border border-border-base bg-bg-surface p-3 cursor-pointer hover:border-border-strong"
                >
                  <input
                    type="checkbox"
                    checked={activePhases.includes(phase)}
                    onChange={() => togglePhase(phase)}
                    className="h-4 w-4 accent-accent-primary"
                  />
                  <span className="text-sm text-text-primary">
                    Phase {phase}
                  </span>
                  <span className="ml-auto text-xs text-text-tertiary">
                    {lineItems.filter((li) => li.phaseNumber === phase).length} items
                  </span>
                </label>
              ))}
              {preview.deferredPhases.length > 0 && (
                <p className="text-xs text-text-tertiary mt-2">
                  Deferred: Phase {preview.deferredPhases.join(', ')} (quote later)
                </p>
              )}
            </div>
          )}

          {/* CONSOLIDATED / HYBRID: consolidated items preview */}
          {(selectedMode === 'consolidated' || selectedMode === 'hybrid') &&
            preview.consolidatedItems.length > 0 && (
              <div className="mt-3 max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border-base text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                      <th className="py-2 text-left">Item</th>
                      <th className="py-2 text-right">Qty</th>
                      <th className="py-2 text-right">BF</th>
                      <th className="py-2 text-right">Sources</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.consolidatedItems.slice(0, 20).map((item, i) => (
                      <tr
                        key={i}
                        className="border-b border-border-subtle"
                      >
                        <td className="py-2 text-text-secondary">
                          {item.species} {item.dimension}{' '}
                          {item.grade || ''} {item.length || ''}
                        </td>
                        <td className="py-2 text-right font-mono text-text-primary">
                          {item.quantity.toLocaleString()} {item.unit}
                        </td>
                        <td className="py-2 text-right font-mono text-text-primary">
                          {item.boardFeet.toLocaleString()}
                        </td>
                        <td className="py-2 text-right text-text-tertiary">
                          {item.sourceLineItemIds.length}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.consolidatedItems.length > 20 && (
                  <p className="mt-2 text-xs text-text-tertiary text-center">
                    + {preview.consolidatedItems.length - 20} more items
                  </p>
                )}
              </div>
            )}
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="rounded border border-semantic-error/40 bg-semantic-error/10 p-3 text-sm text-semantic-error">
          {error}
        </div>
      )}

      {/* Confirm button */}
      <div className="flex justify-end">
        <button
          onClick={handleConfirm}
          disabled={
            isSubmitting ||
            (selectedMode === 'phased' && activePhases.length === 0)
          }
          className="rounded-sm bg-accent-primary px-4 py-2 text-sm font-medium text-text-inverse hover:bg-accent-secondary active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none transition-all duration-150"
        >
          {isSubmitting ? 'Applying...' : 'Apply & continue to routing'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run tsc --noEmit**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | grep "error TS" | grep -v "console-sidebar\|bid-card\|login/page"`
Expected: no new errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/bids/consolidation-controls.tsx
git commit -m "feat(consolidation): ConsolidationControls UI component

4 mode cards, HYBRID recommended for 3+ buildings. Preview panel
shows item count delta (847 → 312, 63% reduction). PHASED mode
shows phase toggles. Preview runs agent locally for instant
feedback. Confirm calls POST /api/consolidate.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Consolidation page

**Files:**
- Modify: `apps/web/src/app/bids/[bidId]/consolidate/page.tsx`

- [ ] **Step 1: Implement the page**

Replace the stub in `apps/web/src/app/bids/[bidId]/consolidate/page.tsx`:

```typescript
/**
 * Bid consolidation workspace.
 *
 * Purpose:  Full-page consolidation workspace. Fetches bid + line items,
 *           renders summary stats + ConsolidationControls, handles mode
 *           confirmation and navigation to routing.
 *
 * Inputs:   params.bidId.
 * Outputs:  Full page JSX.
 * Agent/API: Supabase (bid + line_items queries).
 * Imports:  react, @lmbr/types, ConsolidationControls component.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { ConsolidationMode } from '@lmbr/types';
import type { ConsolidationLineItem } from '@lmbr/agents';
import { ConsolidationControls } from '../../../../components/bids/consolidation-controls';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

export default function ConsolidatePage({
  params,
}: {
  params: { bidId: string };
}) {
  const router = useRouter();
  const supabase = createClientComponentClient();
  const [bid, setBid] = useState<{
    id: string;
    customerName: string;
    jobName: string | null;
    consolidationMode: ConsolidationMode;
  } | null>(null);
  const [lineItems, setLineItems] = useState<ConsolidationLineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      const { data: bidData, error: bidErr } = await supabase
        .from('bids')
        .select('id, customer_name, job_name, consolidation_mode')
        .eq('id', params.bidId)
        .maybeSingle();
      if (bidErr || !bidData) {
        setError(bidErr?.message ?? 'Bid not found');
        setLoading(false);
        return;
      }
      setBid({
        id: bidData.id,
        customerName: bidData.customer_name,
        jobName: bidData.job_name,
        consolidationMode: bidData.consolidation_mode,
      });

      const { data: items, error: liErr } = await supabase
        .from('line_items')
        .select(
          'id, bid_id, company_id, building_tag, phase_number, species, dimension, ' +
          'grade, length, quantity, unit, board_feet, notes, sort_order, ' +
          'extraction_method, extraction_confidence, cost_cents',
        )
        .eq('bid_id', params.bidId)
        .eq('is_consolidated', false)
        .order('sort_order', { ascending: true });
      if (liErr) {
        setError(liErr.message);
        setLoading(false);
        return;
      }

      const mapped: ConsolidationLineItem[] = (items ?? []).map((row) => {
        let flags: string[] = [];
        if (row.notes) {
          try {
            const parsed = JSON.parse(row.notes);
            if (Array.isArray(parsed.flags)) flags = parsed.flags;
          } catch { /* ignore */ }
        }
        return {
          id: row.id,
          bidId: row.bid_id,
          companyId: row.company_id,
          buildingTag: row.building_tag,
          phaseNumber: row.phase_number,
          species: row.species,
          dimension: row.dimension,
          grade: row.grade,
          length: row.length,
          quantity: Number(row.quantity),
          unit: row.unit,
          boardFeet: row.board_feet != null ? Number(row.board_feet) : null,
          confidence: row.extraction_confidence,
          flags,
          sortOrder: row.sort_order,
          extractionMethod: row.extraction_method,
          extractionConfidence: row.extraction_confidence,
          costCents: row.cost_cents,
        };
      });

      setLineItems(mapped);
      setLoading(false);
    }
    load();
  }, [params.bidId, supabase]);

  const buildingTags = new Set(
    lineItems.map((li) => li.buildingTag).filter(Boolean),
  );
  const phaseNumbers = [
    ...new Set(
      lineItems
        .map((li) => li.phaseNumber)
        .filter((p): p is number => p != null),
    ),
  ].sort((a, b) => a - b);
  const totalBoardFeet = lineItems.reduce(
    (s, li) => s + (li.boardFeet ?? 0),
    0,
  );

  const handleConfirm = useCallback(
    (_mode: ConsolidationMode) => {
      router.push(`/bids/${params.bidId}/route`);
    },
    [router, params.bidId],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <p className="text-sm text-text-tertiary">Loading bid data...</p>
      </div>
    );
  }

  if (error || !bid) {
    return (
      <div className="flex items-center justify-center p-16">
        <p className="text-sm text-semantic-error">
          {error ?? 'Bid not found'}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-8 p-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-text-primary">
          Consolidation
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          {bid.customerName}
          {bid.jobName ? ` — ${bid.jobName}` : ''}
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Buildings', value: buildingTags.size || '—' },
          { label: 'Phases', value: phaseNumbers.length || '—' },
          { label: 'Line Items', value: lineItems.length.toLocaleString() },
          {
            label: 'Board Feet',
            value:
              totalBoardFeet >= 1000
                ? `${(totalBoardFeet / 1000).toFixed(1)}M`
                : Math.round(totalBoardFeet).toLocaleString(),
          },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded border border-border-base bg-bg-surface p-4"
          >
            <p className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
              {stat.label}
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-text-primary">
              {stat.value}
            </p>
          </div>
        ))}
      </div>

      {/* Consolidation controls */}
      <ConsolidationControls
        bidId={bid.id}
        lineItems={lineItems}
        buildingCount={buildingTags.size}
        phaseNumbers={phaseNumbers}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
```

- [ ] **Step 2: Run tsc --noEmit**

Run: `npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | grep "error TS" | grep -v "console-sidebar\|bid-card\|login/page"`
Expected: no new errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/bids/[bidId]/consolidate/page.tsx
git commit -m "feat(consolidation): consolidation workspace page

Full-page workspace: summary stats (buildings, phases, items, BF),
mode selector with preview, confirm advances to routing.
Fetches original line items, maps to agent input shape.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Final verification + CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md` (mark Prompt 04 complete)

- [ ] **Step 1: Run tsc --noEmit across all packages**

```bash
npx tsc --noEmit -p packages/types/tsconfig.json && echo "types: CLEAN"
npx tsc --noEmit -p packages/config/tsconfig.json && echo "config: CLEAN"
npx tsc --noEmit -p packages/lib/tsconfig.json && echo "lib: CLEAN"
npx tsc --noEmit -p packages/agents/tsconfig.json && echo "agents: CLEAN"
npx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | grep "error TS" | wc -l
```

Expected: all packages clean, web = 9 pre-existing errors only

- [ ] **Step 2: Update CLAUDE.md build status**

Change `- [ ] PROMPT 04 — Consolidation controls` to `- [x] PROMPT 04 — Consolidation controls`

- [ ] **Step 3: Final commit**

```bash
git add CLAUDE.md
git commit -m "feat(consolidation): Prompt 04 complete — consolidation controls

- Migration 016: source_line_item_ids uuid[] on line_items
- consolidationKey(): species|dimension|grade|length|unit,
  null fields become 'unknown'
- consolidation-agent.ts: pure TS, 4 modes, lowest confidence
  on aggregated rows, UUID array source mapping
- POST /api/consolidate: idempotent, never touches originals,
  inserts consolidated rows with source mapping
- ConsolidationControls: 4 mode cards, HYBRID recommended for
  3+ buildings, preview with item count delta
- Consolidation workspace page: stats + controls + confirm

Prompts complete: 01 02 03 04
Next: Prompt 05 — Vendor bid collection

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
