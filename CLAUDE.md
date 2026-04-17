# CLAUDE.md — LMBR.ai Project Context

> This file is read by Claude Code at the start of every session.
> It is the single source of truth for project context, architecture,
> conventions, and build rules. Do not proceed with any task without
> reading this file first.

---

## What We Are Building

**LMBR.ai** is an enterprise AI bid automation platform for wholesale
lumber distributors. It is built by **Worklighter** — a vertical AI
automation company that builds purpose-built platforms for industries
where speed of quote equals speed of revenue.

**Tagline:** AI bid automation for wholesale lumber distributors.
**Price point:** $10,000+/month per company. Every decision should
reflect enterprise-grade quality.

**Sister product:** Verilane.ai — same Worklighter platform architecture,
built for the freight brokerage vertical.

**Design docs** live in `docs/superpowers/specs/`.
**Current active spec:** `2026-04-15-tiered-ingest-engine-design.md`

---

## The Problem We Solve

Wholesale lumber distributors receive RFQs (requests for quote) via
email, fax, phone, and PDF. A trader manually reads the list, forwards
it to commodity buyers, buyers email vendors/mills, vendors reply with
pricing, buyer re-enters pricing into a spreadsheet, trader adds margin,
generates a PDF quote, and emails it back. This process takes 24–48 hours
and involves constant manual data entry.

**LMBR automates 90%+ of this workflow** — from raw lumber list ingestion
to formatted customer quote out the door.

---

## Core Workflow (Know This Cold)

```
Customer sends RFQ (PDF / Excel / email / scan / handwritten)
        ↓
bids@company.com receives it (Outlook API webhook)
        ↓
LMBR AI ingests + extracts line items (species, dimension, grade, length, qty)
        ↓
QA Agent reviews extraction, flags ambiguous items back to trader
        ↓
Trader reviews clean list, confirms, sets due date
        ↓
PRE-SEND CONSOLIDATION CONTROLS (trader chooses mode):
  - Structured: keep all building/phase breaks as-is
  - Consolidated: aggregate like items for mill pricing
  - Phased: quote phases independently
  - Hybrid: vendor sees consolidated, customer sees breakdown
        ↓
Smart routing engine assigns line items to correct commodity buyer
(by commodity type + job geography)
        ↓
Buyer dashboard: selects vendors, dispatches fillable bid forms
(digital form OR printable PDF with scan-back OCR)
        ↓
Vendors submit pricing (form submit or scanned sheet → Claude Vision OCR)
        ↓
AI extracts all vendor pricing automatically
        ↓
Comparison matrix: every vendor × every line item, best price highlighted
        ↓
Trader selects vendor pricing, applies margin (by line / commodity / bulk)
        ↓
Manager approval gate (configurable threshold per company)
        ↓
Quote PDF generated (sell price only — no vendor names, no costs, no margins)
        ↓
Sent to customer via trader's own Outlook account
```

---

## Role System

| Role | What They Do |
|---|---|
| **Trader** | Receives inbound RFQs, submits for quoting, applies margin, sends output |
| **Buyer** | Manages vendor relationships, dispatches bids, collects pricing |
| **Trader-Buyer** | Unified view — both workflows, self-routing, solo operator mode |
| **Manager / Owner** | Approval gates, margin visibility, full reporting, all job history |

**Critical:** The Trader-Buyer unified role is a first-class feature.
When a user has this role, they see a split-panel dashboard with both
the trader and buyer workflow simultaneously. They self-route bids
directly to their own buyer queue with no forwarding step.

Companies configure their role structure at onboarding. Three common
configurations:
- Large distributor: separate traders and buyers
- Mid-size: some trader-buyers, some dedicated roles
- Solo operator: one person with trader-buyer on everything

---

## Consolidation System (Understand This Deeply)

This is the most technically complex and commercially valuable feature.

When a large job comes in (20 pages, 400 line items, 10 buildings), the
trader needs to decide how to handle it before sending to vendors:

**STRUCTURED** — Keep the list exactly as received. Building breaks
preserved. Vendor sees individual building tallies.

**CONSOLIDATED** — Aggregate all identical species/dimension/grade/length
across the entire job into single line totals. This gets the trader
better mill pricing on volume. The customer quote still shows by building.

**PHASED** — The job is being built in phases. Each phase is quoted
independently. Trader selects which phases to quote now vs. later.

**HYBRID** — The most common mode for large jobs. The mill/vendor
receives a consolidated tally (gets best pricing). The customer
receives a quote broken out by building/phase. LMBR holds the
internal source mapping between the two.

**The source mapping is the moat.** No other tool in this space
understands the lumber workflow deeply enough to build hybrid mode.

---

## Market Intelligence

LMBR does NOT use the Random Lengths API. Here is why and what we use instead:

- Random Lengths is a sentiment indicator, not a pricing tool. Traders
  use it for trend direction only, never for actual quote pricing.
- Real pricing comes from what vendors actually quoted this morning.
- LMBR's **Cash Market Index** is built from aggregated, anonymized
  vendor bid data across all jobs processed through the platform.
  This is more accurate than Random Lengths because it reflects
  actual transactions.

**Data sources:**
1. LMBR Cash Market Index — aggregated vendor bids (our proprietary data)
2. CME lumber futures via Barchart API — trend direction and sentiment
3. USDA / NRC public data — free supplemental data

**Budget Quote Mode** — AI generates budget estimates from market data
in seconds, without going through the full vendor bid cycle. High-value
for quick customer calls.

---

## Monorepo Structure

```
lmbr-ai/                          ← root
├── turbo.json                    ← Turborepo pipeline config
├── package.json                  ← pnpm workspace root
├── CLAUDE.md                     ← this file
├── README.md                     ← UI/UX design system (loaded before building)
│
├── apps/
│   ├── web/                      ← Next.js 14 (App Router)
│   │   └── src/
│   │       ├── app/              ← pages and API routes
│   │       ├── components/       ← web-specific components
│   │       └── hooks/            ← web-specific hooks
│   │
│   └── mobile/                   ← Expo SDK 51 (iOS + Android)
│       └── src/
│           ├── app/              ← Expo Router (file-based)
│           ├── components/       ← native components
│           └── hooks/            ← mobile-specific hooks
│
├── packages/
│   ├── agents/     @lmbr/agents  ← ALL Anthropic AI agent logic
│   ├── types/      @lmbr/types   ← shared TypeScript types
│   ├── lib/        @lmbr/lib     ← shared API clients + utilities
│   └── config/     @lmbr/config  ← constants (species, grades, regions, tax)
│
└── supabase/
    ├── schema.sql
    └── migrations/               ← 11 migration files, numbered
```

---

Available skills:
  /office-hours     — problem definition before building
  /autoplan         — plan before executing
  /plan-eng-review  — engineering review gate
  /review           — code review
  /ship             — sync, test, push, open PR
  /land-and-deploy  — merge, wait for CI, verify production
  /qa               — post-deploy monitoring
  /qa-only          — bug report without code changes
  /cso              — security audit (OWASP + STRIDE)
  /benchmark        — performance baseline
  /learn            — surface codebase patterns
  /retro            — weekly shipping retro
  /investigate      — root cause analysis
  /document-release — update docs after shipping
  /careful          — high-risk change mode
  /freeze           — lock the codebase
  /guard            — protect critical paths
  /canary           — staged rollout monitoring

Run /cso before every major release.
Run pnpm audit --prod before every deploy.
Last /cso run: 2026-04-17 — one MEDIUM finding fixed
(15e4ca2), no open findings.

Commit as:
  docs(claude): add gstack skills section + last cso date

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Web framework | Next.js 14 (App Router) | TypeScript throughout |
| Mobile | Expo SDK 51 + Expo Router | React Native |
| Monorepo | Turborepo + pnpm workspaces | Internal packages use @lmbr/ prefix |
| Styling (web) | Tailwind CSS | Follow README design system |
| Styling (mobile) | NativeWind | Tailwind syntax for React Native |
| Auth + Database | Supabase | Postgres + Row Level Security |
| AI agents | Anthropic SDK | Model: claude-sonnet-4-6 |
| Email | Microsoft Graph API | Outlook integration |
| OCR / Vision | Claude Vision API | Scan-back vendor sheets |
| PDF output (web) | @react-pdf/renderer | Quote generation |
| PDF output (mobile) | Expo Print | |
| Push notifications | Expo Notifications | |
| Market data | Barchart API | CME lumber futures |
| App Store builds | Expo EAS | |
| State management | TanStack Query | Server state |
| Forms | React Hook Form + Zod | Validation |
| Charts | Recharts | Market intelligence dashboard |
| Virtualization (web) | @tanstack/react-virtual | Comparison matrix; any list ≥ 50 rows |
| Component base | shadcn/ui | Web only |
| Icons | lucide-react | |
| Date handling | date-fns | |
| Unit tests (agents) | vitest | `pnpm --filter @lmbr/agents test` |

### Extraction Pipeline (Tiered — Cheapest Method First)

```
Layer 0:  File type detection (free)
Layer 1A: exceljs — Excel/CSV direct parse (free)
Layer 1B: pdf-parse — text PDF extraction (free)
Layer 1C: mammoth — DOCX extraction (free)
Layer 1D: Azure Document Intelligence — scanned/image OCR
          ($1.50 per 1,000 pages)
Layer 2:  claude-sonnet-4-6 — fallback extraction only,
          fires when confidence < 0.92
          Mode A: full extraction (confidence < 0.60)
          Mode B: targeted line cleanup (0.60 to 0.92)
Layer 3:  claude-haiku-4-5-20251001 — QA borderline pass
          and scan-back price matching only
```

**Confidence threshold:** `0.92`
**Env var:** `EXTRACTION_CONFIDENCE_THRESHOLD` (default `0.92`)
**Target:** fewer than 15% of documents reach Layer 2

**Cost estimates:**

| Monthly bid volume | Est. extraction cost |
|---|---|
| 1,000 bids | ~$7.70 |
| 5,000 bids | ~$38.50 |
| 10,000 bids | ~$77.00 |

vs. Claude-first baseline at 10k bids/month: ~$1,400 (**18x savings**).

### Model Split (do not change without updating this section)

```
Mode A extraction (full doc):    claude-sonnet-4-6
Mode B extraction (targeted):    claude-sonnet-4-6
QA agent Haiku pass:             claude-haiku-4-5-20251001
Scan-back price matcher:         claude-haiku-4-5-20251001
LMBR_DEFAULT_MODEL:              claude-sonnet-4-6
LMBR_FALLBACK_MODEL:             claude-opus-4-6
```

---

## Package Naming Convention

All internal packages use the `@lmbr/` prefix:

```
@lmbr/agents   — AI agents (ingest, QA, extraction, routing, pricing, comparison, market)
@lmbr/types    — TypeScript types (bid, user, role, vendor, line-item, quote, market)
@lmbr/lib      — Shared clients + tiered ingest primitives (see below)
@lmbr/config   — Constants (commodities.ts, regions.ts, tax-rates.ts)
```

Web and mobile apps import from these packages. Business logic lives
in packages, never in apps.

### `@lmbr/lib` — Shared Utilities

Existing clients:
- `anthropic.ts` — Anthropic SDK singleton + `LMBR_DEFAULT_MODEL` / `LMBR_FALLBACK_MODEL`
- `supabase.ts` — anon + service-role client factories
- `outlook.ts` — Microsoft Graph client
- `pdf.ts` — PDF helpers
- `lumber.ts` — species / dimension / grade / length / unit normalizers + board-foot math

Tiered ingest primitives (Session Prompt 04):
- `lumber-parser.ts`
  - deterministic Excel / CSV / text lumber list parser
  - reuses normalizers from `lumber.ts`, zero duplication
  - returns `ParseResult` with per-line confidence scores
  - `lowConfidenceLines[]` flat depth-first indices for Mode B targeting
- `attachment-analyzer.ts`
  - file type router; picks the cheapest extraction method per file
  - returns `AttachmentAnalysisResult` with method + cost
- `cost-tracker.ts`
  - fire-and-forget extraction cost ledger
  - writes to `extraction_costs` table (migration 015)
  - tracks per bid: method, cost_cents, company_id
- `queue.ts`
  - Redis-optional BullMQ wrapper
  - if `REDIS_URL` unset → falls back to sync in-request processing
  - `enqueueOrRun()` / `createIngestWorker()`
- `ocr.ts`
  - Azure Document Intelligence client (real, not stub)
  - prebuilt-layout model
  - returns text + page count + confidence + cost_cents

Vendor submission helpers (Session Prompt 05):
- `vendor-token.ts`
  - HMAC-SHA256 signed stateless tokens for `/vendor-submit/[token]`
  - payload includes `expiresAt` — verifier rejects expired tokens
  - `createVendorBidToken()` throws if `VENDOR_TOKEN_SECRET` is unset
- `vendor-visibility.ts`
  - `vendorVisibleIsConsolidatedFlag(mode)` — single source of truth
    for whether a consolidation mode shows vendors a consolidated
    tally vs. the structured building breakdown
  - used by dispatch, PDF render, and public submit page

---

## Database Schema (Supabase)

**Multi-tenant:** Every table has `company_id`. RLS enforces isolation.

**Core tables:**
- `companies` — tenant config, Outlook credentials, plan
- `users` — per-company users
- `roles` — trader / buyer / trader_buyer / manager / owner per user
- `commodity_assignments` — which buyer handles what + where
- `bids` — full bid lifecycle with status enum
- `line_items` — extracted lumber items with building/phase grouping
- `vendors` — company vendor list with commodity + region assignments
- `vendor_bids` — dispatch records per vendor per bid; includes
  `token text` + `token_expires_at timestamptz` columns added in
  migration `017_vendor_bid_tokens.sql` to support the stateless
  public `/vendor-submit/[token]` flow
- `vendor_bid_line_items` — individual vendor prices per line
- `quotes` — approved output with margin + tax calculations
- `quote_line_items` — sell-price view of selected vendor pricing
- `market_prices` — aggregated cash market data
- `archive` — historical bid data for knowledge base

**RLS rules:**
- Users only see rows where `company_id` matches their own
- Managers see all rows in their company
- Traders only see their own bids (unless trader_buyer role)
- Vendor prices visible to buyers and trader_buyers only

---

## API Routes (Web)

```
POST /api/ingest           — tiered extraction orchestrator
                              returns 202 (queued) or 200 (inline)
                              body: { extraction, qa_report,
                                      extraction_report }
POST /api/extract          — vendor scan-back price extraction
                              multipart upload → Azure OCR + Haiku
                              matcher → writes vendor_bid_line_items
POST /api/qa               ← QA agent review
POST /api/consolidate      ← apply consolidation mode
POST /api/route-bid        ← routing engine
GET  /api/vendors          ← list company vendors
POST /api/vendors          ← create vendor (CRUD — real, not stub)
POST /api/vendors/dispatch ← mint signed tokens + create vendor_bids
                              for each selected vendor on a bid
POST /api/vendors/nudge    ← STUB today; returns { ok, stubbed: true }
                              Graph API sendmail lands in Prompt 08
POST /api/vendor-submit    ← public submission endpoint (token-auth)
                              accepts digital-form line prices
GET  /vendor-submit/[token]       ← public vendor web form (no auth)
GET  /vendor-submit/[token]/print ← React-PDF printable tally
GET  /api/compare/[bidId]  ← build comparison matrix for a single bid.
                              Session-auth + role gate (buyer,
                              trader_buyer, manager, owner only —
                              pure traders get 403). RLS-scoped reads
                              only; service role is never used here.
                              Data-loading helper lives at
                              apps/web/src/lib/compare/load-comparison.ts
                              and is shared with the RSC page.
POST /api/margin           ← apply MarginInstruction[] to the selected
                              vendor prices, run pricing-agent, upsert
                              quotes + quote_line_items. Role gate =
                              buyer/trader_buyer/manager/owner. Action
                              is 'draft' or 'submit_for_approval'.
                              Orchestration in
                              apps/web/src/lib/margin/apply-margin.ts.
POST /api/quote            ← render the customer quote PDF. Body:
                              { bidId, action: 'preview' | 'release' }.
                              Preview allowed for trader+; release is
                              manager/owner only and gated by
                              canReleaseQuote() on quote.status.
                              Release renders first, then allocates
                              next_quote_number, then re-renders — so
                              a render failure never burns a number.
POST /api/manager/approvals← GET lists pending_approval quotes for
                              the manager's company. POST body
                              { quoteId, action: 'approve' |
                              'request_changes' | 'reject' }.
                              Manager/Owner only. Uses service-role
                              admin client to bypass RLS for the
                              approval-column writes — the manual
                              role + tenant check is the only gate
                              there (see the SECURITY comment in
                              apps/web/src/app/api/manager/approvals/route.ts).
GET  /api/market           ← market price data
POST /api/market/budget-quote ← AI budget estimate
POST /api/webhook/outlook  ← Graph API email webhook
```

---

## AI Agents (@lmbr/agents)

All agents default to `claude-sonnet-4-6` unless otherwise
specified. See Model Split section for exceptions —
`qa-agent.ts` and scan-back price matching use
`claude-haiku-4-5-20251001`. Each agent is a single file
with a clear input/output contract.

| Agent | Purpose |
|---|---|
| `ingest-agent.ts` | Orchestrates the full extraction pipeline |
| `extraction-agent.ts` | Parses lumber lists into structured JSON |
| `qa-agent.ts` | Reviews extraction, flags issues, scores confidence |
| `routing-agent.ts` | Assigns line items to correct buyers |
| `consolidation-agent.ts` | Aggregates items, maintains source mapping |
| `comparison-agent.ts` | **Pure TypeScript** (no LLM). Ranks vendors per line with deterministic tiebreak (coverage → alphabetical); flags best/worst; computes spread; suggests `cheapest` + `fewestVendors` set-cover selections. Excludes `declined`/`expired`/`pending` vendors from ranking. Zod-validated input. |
| `pricing-agent.ts` | **Pure TypeScript** (no LLM). Applies `MarginInstruction[]` (scope: all/commodity/line; mode: percent/dollar) with last-write-wins semantics. Computes sell prices, blended margin %, CA lumber assessment + state sales tax, and flags `needsApproval` / `belowMinimumMargin` / `unresolvedLineItemIds`. Deterministic. Zod-validated input. |
| `market-agent.ts` | Generates budget quotes from market data |
| `scanback-agent.ts` | Matches handwritten OCR prices back to expected line_items (Haiku). |

**Extraction output format** (know this — it flows through the entire system):

```typescript
{
  extraction_confidence: number,        // 0.0 - 1.0
  building_groups: [{
    building_tag: string,               // "House 1", "Building A", "Phase 2"
    phase_number: number | null,
    line_items: [{
      species: string,                  // Normalized: SPF, DF, HF, SYP, Cedar, LVL, OSB, Plywood, Treated
      dimension: string,                // Normalized: 2x4, 2x6, 2x8, 2x10, 2x12, 4x4, etc.
      grade: string,                    // #1, #2, #3, Stud, Select Structural, MSR
      length: string,                   // "8", "10", "16", "Random Length"
      quantity: number,
      unit: "PCS" | "MBF" | "MSF",
      board_feet: number,
      confidence: number,               // 0.0 - 1.0
      flags: string[],                  // ambiguous_species, missing_grade, etc.
      original_text: string             // raw text from source document
    }]
  }],
  total_line_items: number,
  total_board_feet: number,
  flags_requiring_review: string[]
}
```

---

## Lumber Domain Knowledge

This is industry-specific context that must inform all AI prompts
and business logic.

**Species (normalize to these):**
- SPF — Spruce-Pine-Fir (most common framing lumber)
- DF — Douglas Fir
- HF — Hem-Fir
- SYP — Southern Yellow Pine
- Cedar — Western Red Cedar
- LVL — Laminated Veneer Lumber (engineered)
- OSB — Oriented Strand Board (panels)
- Plywood — structural plywood (panels)
- Treated — pressure treated lumber

**Common dimensions:** 2x4, 2x6, 2x8, 2x10, 2x12, 4x4, 4x6, 6x6,
1x4, 1x6, 1x8 (width x depth in inches)

**Common grades:** #1, #2, #3, Stud, Select Structural, MSR
(Machine Stress Rated)

**Units:**
- PCS — pieces (count)
- MBF — thousand board feet (volume)
- MSF — thousand square feet (panels)
- Board foot formula: (thickness × width × length) / 12

**Random Lengths** — industry pricing publication owned by Fastmarkets.
Used by traders for market trend direction only. Not used for actual
quote pricing. LMBR's own aggregated vendor data supersedes it.

**Quote validity windows vary widely** — same day to 30 days depending
on market volatility. This is why repricing automation matters.

**Vendor hierarchy:**
- Mills: sawmills, primary producers (largest orders, best pricing)
- Wholesalers: national distributors (medium volume)
- Distributors: regional (smaller volume, faster delivery)
- Min order thresholds are real — don't send Weyerhaeuser a 2-unit
  change order. The vendor selector UI enforces this.

---

## Environment Variables

```bash
# Required — do not build without these
ANTHROPIC_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Microsoft Graph (Outlook integration)
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=
MICROSOFT_REDIRECT_URI=

# Market data
BARCHART_API_KEY=
TWELVEDATA_API_KEY=

# Tiered ingest — Azure Document Intelligence (OCR layer 1D)
AZURE_DOC_INTELLIGENCE_ENDPOINT=
AZURE_DOC_INTELLIGENCE_KEY=

# Tiered ingest — confidence cutoff for Claude fallback (default 0.92)
EXTRACTION_CONFIDENCE_THRESHOLD=0.92

# Tiered ingest — optional; omit for sync in-request fallback mode
REDIS_URL=

# Vendor submission tokens — HMAC secret for the public /vendor-submit/[token] flow
# MUST be set in production. Without it, createVendorBidToken throws at dispatch time,
# which means POST /api/vendors/dispatch will fail before any vendor bid is created.
VENDOR_TOKEN_SECRET=

# App config
NEXT_PUBLIC_APP_URL=
NEXT_PUBLIC_APP_ENV=development
```

---

## Coding Conventions

**TypeScript:** Strict mode. No `any`. All agent inputs/outputs
are Zod-validated schemas.

**File naming:**
- Components: `kebab-case.tsx`
- Hooks: `use-kebab-case.ts`
- Agents: `kebab-case-agent.ts`
- Types: `kebab-case.ts`

**Component structure:**
```typescript
// 1. Imports (external → internal → types → styles)
// 2. Types/interfaces for this component
// 3. Component function
// 4. Sub-components (if small enough to co-locate)
// 5. Export
```

**API routes:**
```typescript
// Every route:
// - Validates request body with Zod
// - Extracts company_id from session (never trust client)
// - Returns typed response or typed error
// - Handles errors explicitly, no silent failures
```

**Agent calls:**
```typescript
// Every Anthropic call:
// - Uses claude-sonnet-4-6 by default (LMBR_DEFAULT_MODEL).
//   Exception: qa-agent Haiku pass and scan-back price matcher
//   use claude-haiku-4-5-20251001 explicitly.
//   See Model Split in Tech Stack for the full mapping.
// - max_tokens: 4096 minimum, higher for large extractions
// - System prompt defines persona + output format
// - User prompt contains the actual data
// - Output is parsed and validated before returning
```

**Database queries:**
```typescript
// Always include company_id filter — RLS is a backup, not primary defense
// Always select specific columns — no select('*') in production
// Always handle null/undefined from Supabase responses
```

**No placeholder returns:** Every function either works or throws a
descriptive error. No `return null` for error cases. No silent failures.

---

## Key Product Rules (Non-Negotiable)

1. **Vendor names NEVER appear on any customer-facing output.**
   The quote PDF shows sell price only. No cost prices. No margins.
   No vendor names. Internal views show vendors clearly.

2. **Building/phase structure is NEVER automatically destroyed.**
   The consolidation step is always an explicit trader action.
   Default behavior preserves all structure from the source document.

3. **The Trader-Buyer unified dashboard must feel like a trading terminal.**
   It is the flagship screen. Split panel. Real-time. Fast.
   Not a form. Not a wizard. A tool a trader actually wants to use.

4. **The comparison matrix must be virtualized.**
   400 line items × 10 vendors cannot lag. If it lags, it fails.
   Use react-window or TanStack Virtual. No exceptions.

5. **All emails come from the company's own Outlook account.**
   Never from a generic LMBR address. This is a trust requirement.
   Vendors and customers must see emails from the people they know.

6. **Company data is never shared across tenants.**
   The archive knowledge base, market price aggregations, and
   historical pricing are per-company private assets. RLS enforces
   this at the database level. Agents must also enforce this in logic.

7. **Mobile is not an afterthought.**
   Traders forward bids from their phone. Buyers approve from the road.
   Vendors photograph their price sheets with the camera.
   Every core workflow must be fully functional on mobile.

---

## Current Build Status

Track progress here as modules are completed:

- [x] Scaffold + monorepo setup
- [x] README.md — UI/UX design system loaded
- [x] PROMPT 01 — Supabase schema + auth
- [x] PROMPT 02 — Ingest engine (tiered — rebuilt)
- [x] PROMPT 03 — Routing engine
- [x] PROMPT 04 — Consolidation controls
- [x] PROMPT 05 — Vendor bid collection
- [x] PROMPT 06 — Comparison matrix
- [x] PROMPT 07 — Margin stacking + quote output
    - **Invariant — vendor-free PDF by construction:** the
      `QuotePdfInput` type in `packages/lib/src/pdf-quote.ts` does not
      declare any vendor / cost / margin fields. The React-PDF renderer
      in `apps/web/src/lib/pdf/quote-pdf.tsx` reads ONLY from
      `QuotePdfInput`. `PdfPricedLineInput` has a type-level test
      locking it to omit `vendorId` / `costUnitPrice` / `costTotalPrice`
      / `marginPercent`. Do not weaken this — a future engineer adding
      a vendor field to the PDF input type will fail both the runtime
      fixture test and the `expectTypeOf` assertion.
    - **Invariant — release gating:** `packages/lib/src/quote-release-gate.ts`
      is the single source of truth for which `quote.status` values can
      be released. `POST /api/quote { action: 'release' }` must call
      `canReleaseQuote(status)` before any render or upload. Do not
      inline a status check elsewhere.
    - **Invariant — render-then-allocate:** the release path renders
      first, then calls `next_quote_number` RPC, then re-renders with
      the real number. This is the reason traders never see gaps in
      their customer-facing quote sequence. Do not move allocation
      ahead of render.
    - **Client preview drift guard:** `margin-stack.tsx` imports
      `STATE_SALES_TAX` and `CA_LUMBER_ASSESSMENT` directly from
      `@lmbr/config`. Do not re-inline trimmed tax tables. Client
      preview totals are clearly labeled ("Estimated" vs "Saved") and
      swap to server-authoritative numbers on save.
    - **Prompt 08 hand-off notes (Prompt 07 adds):** `POST /api/quote`
      release flips `quotes.status` to `'approved'` and leaves the
      `'sent'` transition + Outlook send to Prompt 08. The Manager
      approval queue's `request_changes` action does not persist the
      note today — add `quotes.approval_notes` (migration 019) if
      Prompt 08 needs to surface the note in the Outlook email body.
      Mobile push-notification registration for new approvals is
      stubbed with a code comment pointing here.
- [x] PROMPT 08 — Outlook integration
    - Outlook integration complete. OAuth flow + encrypted token
      storage + webhook handler + dispatch/nudge/quote email sends
      + integrations settings UI + subscription renewal cron target
      + raw_response_url + timezone threading + cost method enum.
    - Webhook validation handshake: confirmed working.
      Subscription creation: requires M365 work/school account.
      Personal accounts (hotmail/outlook.com) not supported by
      Graph change notifications. Test with M365 dev account
      before production.
      Sign up: https://developer.microsoft.com/microsoft-365/dev-program
    - `MICROSOFT_REDIRECT_URI` must match exactly in both
      `.env.local` and Azure AD app registration. Currently set
      to ngrok URL for dev — update to production URL before deploy.
    - Missing env vars that caused issues during setup:
      `OUTLOOK_TOKEN_ENCRYPTION_KEY` (32 bytes hex),
      `OUTLOOK_CLIENT_STATE_SECRET` (32 bytes hex),
      `NEXT_PUBLIC_APP_URL` (must be HTTPS — ngrok URL for dev).
      Generate with:
      `node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'`
- [x] PROMPT 09 — Market intelligence layer
    - LMBR Cash Market Index built from aggregated vendor bids.
      `public.market_price_snapshots` (migration 024) is append-only;
      the daily aggregation job reads `vendor_bid_line_items` joined
      through `vendor_bids` (status='submitted') to `bids`
      (status != 'archived'), groups by slice, enforces the 3-buyer
      anonymization floor, and upserts via `ON CONFLICT DO NOTHING`
      so re-runs are no-ops.
    - Anonymization floor is enforced at TWO layers:
      (1) `CHECK (company_count >= 3)` on the DB column (migration 024),
      (2) `ANONYMIZATION_FLOOR = 3` in `@lmbr/agents/market-agent`
          (suppresses slices below the threshold before insert).
      Defense-in-depth; a buggy writer cannot breach the floor.
    - `companyCount` NEVER reaches a client. `GET /api/market`
      strips it via `toPublic()` and derives a bucketed
      `contributorNote` from `MIN(companyCount)` across results
      (weakest-link rule): "10+ distributors" / "5+ distributors" /
      "multiple distributors".
    - Fallback cascade on `lookupMarketPrice`: exact →
      region_any → grade_any → none. 30-day staleness cutoff
      (`MAX_SNAPSHOT_AGE_DAYS`) — older snapshots return `none`,
      not a stale price.
    - No futures ticker in V1 — product scope cut (commit `04a9fe1`).
      The Twelve Data integration and `market_futures` table were
      removed. `TWELVEDATA_API_KEY` placeholder retained in
      `.env.example` as "future premium feature — add when customers
      request it."
    - Cron targets (Prompt 11 wires the schedule):
      - `POST /api/market/aggregate` (daily) — bearer-auth'd via
        `MARKET_AGGREGATE_SECRET`. Never returns non-2xx except the
        auth gate. Logs `slicesBelowFloor` at info level as the
        Cash Index readiness signal.
    - Budget estimate contract: `POST /api/market/budget-quote` is
      **ephemeral** — never persisted. Role-gated to
      trader / trader_buyer / manager / owner. The `warning` field
      is **always** present in successful responses. Calling it a
      "quote" in any user-facing string is a product violation —
      see `packages/agents/src/market-agent.ts` file header.
    - Tests: 19 vitest cases in `packages/agents/src/__tests__/market-agent.test.ts`
      — floor, math, cascade, composition, idempotency. Plus
      smoke-e2e Step 10 verifies the anonymization floor fires end-
      to-end through the DB (1-company seed → 0 slices written).
- [ ] PROMPT 10 — Archive + knowledge base
- [ ] PROMPT 11 — Settings + company config
- [ ] PROMPT 12 — Polish + QA pass
- [ ] Demo seed data
- [ ] EAS mobile build
- [ ] App Store submission

---

## Known Pre-existing Errors (deferred to Prompt 12)

`apps/web` — 9 errors in 3 untouched files:

- **`console-sidebar.tsx`** (lines 40-45, 75):
  lucide-react `ForwardRefExoticComponent` vs `ComponentType`.
  Root cause: `@types/react` version mismatch with lucide-react.
  Fix: align `@types/react` or narrow local Icon component type.

- **`bid-card.tsx:41`** + **`login/page.tsx:111`**:
  Next.js `typedRoutes` `href` string vs `RouteImpl<string>`.
  Fix: switch to `Route<>` typed hrefs or disable `typedRoutes`.

`apps/mobile` — deferred per design doc §3.12:

- NativeWind `className` errors in `scan.tsx`
- `tailwind.config.ts` types missing
- Fix: alongside Prompt 12 mobile polish pass

None of these are in the ingest code path.
**Do not fix during active feature prompts — address in Prompt 12.**

---

## Before Every Claude Code Session

1. Read this file (CLAUDE.md) — you are doing that now
2. Read README.md — contains the UI/UX design system
3. Check the build status checklist above
4. Understand which module you are building
5. Reference the relevant prompt from the prompt library PDF
6. Do not deviate from the tech stack without a documented reason

---

*LMBR.ai — Powered by Worklighter*
*lmbr.ai | worklighter.ai*

[Prompt 13 — Contractor Platform (Planned, Not Built Yet)
Do not build any of this during Prompts 08–12.
This section exists so the decisions made on April 16, 2026
are not lost. When Prompt 12 polish is complete, Prompt 13
is the next build target.
What It Is
A contractor-facing version of LMBR for framing contractors.
Same look, same UX, inverted workflow. Contractors upload
lists and receive quotes from brokers. Brokers upload lists
and receive quotes from mills. The comparison matrix is
identical — just comparing broker quotes instead of mill quotes.
Why It Exists

Contractors are already sending Excel files to multiple
brokers manually. LMBR gives them one upload point.
Locked list integrity — once a contractor uploads a list,
it is immutable. Every broker receives the identical list.
Prevents list manipulation (short-listing, item substitution)
which is a documented industry problem.
Single extraction for multiple vendors. If 5 brokers bid
the same job, LMBR extracts the list once. Cost is shared,
not multiplied per broker.
Feeds the broker sales motion. When a broker's customer
is already on LMBR, onboarding starts from "your customers
are already there" not "let me explain what this does."

Data Model Decision
Extend the bids table — do not create a separate table.
Add: source enum ('broker' | 'contractor')
Add: locked_at timestamptz (immutable after this point)
The entire extraction pipeline, routing, and comparison
matrix work without modification. Contractor workflow is
a different entry and exit point to the same core data.
Three Workflow Documents to Write Before Building

Contractor bid flow (upload → lock → broker receives → quote back)
Order change flow (text / photo / PDF / voice → send → audit)
Broker receiving contractor list (confirm no new UX needed)


Freemium Model — Contractor Pricing (Decided April 16)
Pricing Decision
First 500 contractors: free forever (founding cohort)
Everyone after: $149/month
Not $99 — $149. Still cheap for a contractor doing $5M+/year.
At 1,500 paying contractors: $2.7M ARR from a non-focus tier.
Acquisition Sequence

Source top 2,000 framing contractors from Procore's
network page (self-selected, digitally engaged, more
likely to adopt new tools)
Scrape and verify: active company, right volume,
decision maker email reachable
Email campaign — first 500 to sign up get free forever
Social proof target: 500 users before pushing hard on
broker sales. "500 framing contractors already use LMBR
to send bid requests" changes the Matheus conversation.

Pricing Objection Pre-Answer
When a broker asks why contractors pay $149 and they pay
$10,000+, the answer:
"Different products, different value, different volume.
Contractors use a convenience tool — one upload, quotes
back, comparison view. You're running a trading platform.
Your traders use this all day across hundreds of bids.
The market intelligence layer alone — the cash market
index built from your transaction data — is something
Random Lengths charges more than we do for a fraction
of the accuracy. The contractor tool is a feeder system
that brings more bids to your desk. You're not paying
for their access. You're paying for yours."

Quality of Life Features (Decided April 16, Build in Prompt 12 or 13)
Extraction Verification Panel
Contractors will be skeptical at first that AI captured
everything correctly. Add a collapsible verification bar
at the top of the extracted list view:
Source file: bid-framing-lot-23.xlsx    ↓ View original
Lines in source:     247
Lines extracted:     247    ✓ 100% captured
Total board feet:    84,320 BF
Total sheet goods:   1,240 MSF
Buildings detected:  4
⚠ 3 items flagged for review
✓ Board foot math verified on all 244 clean lines
Rules:

Excel: always show line count match (row count minus headers)
PDF text: show lines with lumber-like patterns matched
Scanned: don't over-promise — show only what can be proven
Original file always downloadable (already stored in Supabase)

Global Vendor Directory
A curated LMBR directory of every known mill, wholesale
lumber yard, retail yard, and broker. Logos as visual
identifiers. "No affiliation" badge on every entry.
At onboarding:
"Do you have a vendor list to import?"
YES → upload CSV/Excel → extract and match against directory
NO → browse directory, check vendors, add contact info
Source from Procore network for the contractor-side directory
(lumber brokers who contractors buy through).
Legal note: "No affiliation" disclaimer in UI and terms.
Not endorsing vendors. Not receiving referral fees.
Directory is a utility, not a marketplace.
Archive Feature — Add in Prompt 12
Bid states:
active   — live, in progress, or completed
archived — removed from main view, all data preserved
deleted  — soft delete only, retained for audit
Archive behavior:
bids.archived_at + bids.archived_by set
All data preserved: line items, vendor bids, quotes,
costs, audit logs, source file
Searchable in "Archived" tab
"Bid multiple times" filter for delayed jobs
Reactivation:
Clears archived_at
All history intact
Prompt: "Continue where you left off or start fresh?"
Migration to add in Prompt 12:
ALTER TABLE bids
ADD COLUMN archived_at timestamptz DEFAULT NULL,
ADD COLUMN archived_by uuid REFERENCES users(id);
CREATE INDEX idx_bids_archived ON bids(company_id, archived_at)
WHERE archived_at IS NOT NULL;

Voice-to-Order-Change + Audit Trail (Prompt 13)
Feature Description
PM on jobsite opens app → Order Change → Voice
→ Records → Transcribes → PM reviews → Selects vendors → Send
Audit Log Entry (immutable, permanent)
Every order change request writes an immutable log entry:
Submitted by: Jose Martinez
Role: Project Manager
Date/Time: April 16, 2026 at 3:02 PM PST
Method: Voice recording (transcribed)
Job: Lot 23
Sent to: Pacific Coast Lumber, Idaho Pacific
Voice transcript: [full text]
Extracted line items: [structured]
Audio recording: retained 90 days
Email delivery: confirmed timestamp
Read receipt: vendor + timestamp (via Outlook Graph API)
Read receipts: wire up when Prompt 08 Outlook integration ships.
Material OC Approval (Design Now, Activate with ERP)
Approval flow exists in V1. ERP link deferred.
Design the data model now so historical records exist
when ERP integration ships.
Approval record (immutable):
OC Request: voice, 3:02 PM
Quote received: 3:45 PM
Approved: 4:15 PM by Jose Martinez
Delta from contract: +$3,840
Cumulative OC spend on job: $47,220
Cumulative OC spend view: one tap answer to
"how much have we gone over on lumber for this job?"

"7% Light" Predictive Recommendation (Post-Prompt 13)
After enough contractor historical data exists:
"On your last 5 multifamily jobs you ran 7.2% over on
dimensional framing lumber on average. On this bid of
84,320 BF — consider adding 6,070 BF buffer if budget
allows. That's approximately $2,540 at current market rates."
"At current market rates" is powered by the LMBR Cash Market
Index from the broker side. Broker transaction data makes
the contractor recommendation smarter. Contractor overage
data makes the broker market picture richer. They compound.
Data required per job:
Original bid quantities
Order change quantities accumulated
Final order quantity
Variance: (final - bid) / bid = overage %
Ship when enough historical data exists to make it meaningful.

SLM / AI Independence Strategy (Decided April 16)
Four Modes — All Already In Motion
Mode 1 — Don't rely solely on AI (already done)
Tiered extraction: 85%+ of documents never touch LLM.
Deterministic parser is reliable, free, and immune to
model pricing changes. Built this way deliberately.
Mode 2 — New models make product better and cheaper
Historical trajectory favors us. Haiku today is better
than GPT-4 two years ago at a fraction of the cost.
Volume growth + price decline = improving economics.
Mode 3 — Fine-tuned SLM on our own data (6-12 months out)
Open source candidates: Llama 3.1 8B, Mistral 7B, Phi-3
Fine-tune cost: ~$50-200 on Lambda Labs or RunPod
Inference cost at 10k bids/month: under $20
Timeline: need ~50,000 labeled extraction examples
Source: audit logs + correction_logs table (see below)
Mode 4 — Open source RAG path available today
Mistral 7B + Ollama + RAG pointing at audit logs
No fine-tuning needed. Essentially free.
Deployable as fallback if model pricing becomes a problem.
correction_logs Table — Add in Prompt 12
Every time a trader edits an AI-extracted line item,
that correction is a labeled training example.
This table is the future fine-tuning dataset.
Build it from day one so data accumulates automatically.
correction_logs:
id uuid pk
extraction_id uuid fk
bid_id uuid fk
company_id uuid fk
original_extraction jsonb
corrected_extraction jsonb
correction_delta jsonb
corrected_by uuid fk → users
corrected_at timestamptz
Wire into the line item edit flow in Prompt 12:
whenever a trader saves an edit to an extracted line item,
write a correction_log row automatically.

The Four-Layer Data Vision (Long Game)
Every product decision should make the data richer,
not just the feature more complete.
Layer 1 — Cash market intelligence (building now)
Real vendor transaction prices from broker bids
More accurate than Random Lengths for cash market
Compounds with every broker customer added
Layer 2 — Contractor bid intelligence (Prompt 13)
Contracted material costs per job
Order change accumulation per job
Overage patterns per contractor
Layer 3 — GC project intelligence (future)
Budget vs. actual across material categories
Subcontractor performance
Pay app flow: sub → GC → owner
Layer 4 — Multifamily market picture (endgame)
How money flows on jobsites across the country
Budget formation → procurement → OCs → pay apps → closeout
Nobody has this picture. LMBR will.
Procore Integration Target
Developer portal → Marketplace → 1M+ user distribution
Read-only first (pull project data in, don't write back yet)
"Procore integration available" changes enterprise sales
conversations before the technical integration is deep.
Source contractor and GC acquisition lists from their
network page before formal integration exists.

Vertical Expansion Model (Long Game)
Playbook per vertical:

Find the domain expert
Expert maps key players, workflows, pain points
Expert designs extraction logic + normalization rules
LMBR platform handles everything else
Launch with expert's network as first customers

Lumber → current build (founder is the expert)
Concrete → find the concrete distribution expert
Steel → find the steel distribution expert
Drywall / MEP → same pattern
Platform infrastructure is vertical-agnostic.
Domain knowledge is what each expert brings.
Each vertical gets its own Worklighter-stamp brand mark,
its own domain (.ai), its own product name.

Product Philosophy — Automation Suggests, Humans Decide
Every automated action in LMBR has a manual override path.
The system is opinionated about what it thinks is correct
but never removes the human's ability to change it.
This is non-negotiable in construction where relationships,
local knowledge, and experience often override pure
optimization. Build every feature with this in mind:
AI extracts list → human can edit any line item
System routes to buyer → human can reassign manually
Mode recommended → human chooses consolidation mode
Select all cheapest → human can override per line
Margin presets applied → human can edit per line
Approval gate fires → manager can override threshold
Voice transcribes → PM reviews and edits before sending
7% light flagged → contractor decides whether to buffer
The goal is to eliminate tedious work, not judgment.
Joe Miller typing out his change orders by email is fine.
His broker does not have to use LMBR. But if the broker
is on LMBR, the broker benefits regardless of whether
their customer changes behavior. That is the right
adoption model — the tool pays for itself at the broker
level without requiring the contractor to change anything.

Prompt 12 Additions Checklist (Before Starting Prompt 12)
Add these items to the Prompt 12 build in addition to
the original polish spec:
[ ] Archive migration (bids.archived_at + archived_by)
[ ] Archive UI (archived tab, reactivation flow)
[ ] correction_logs table + write on every line item edit
[ ] Extraction verification bar (bid review screen)
[ ] BidLinesView extraction method badge column
(currently reads from legacy notes blob — use new columns)
[ ] Issue #6 — abbreviated group headers (H1 etc.)
[ ] Pre-existing apps/web errors (lucide/typedRoutes)
[ ] Mobile: NativeWind className errors, tailwind types
[ ] Mobile: bid detail consolidation mode badge + selector
[ ] Mobile: full comparison view (if not deferred further)

What Is NOT Being Built in Prompts 08–12
Logged here so it doesn't accidentally creep into scope:
Contractor platform → Prompt 13
Voice-to-text order change → Prompt 13
Global vendor directory → Prompt 13
Order change approval flow → Prompt 13
Procore integration → after contractor platform exists
GC intelligence layer → after contractor platform proven
"7% light" recommendation → after Prompt 13 + data exists
SLM fine-tuning pipeline → when 50k corrections logged
Pay app flow → future, after GC layer exists
ERP integration → future, after OC approval proven]

Add this section to CLAUDE.md near the bottom, before
the "Before Every Claude Code Session" section:

## gstack Skills (globally installed)

gstack is installed globally at ~/.claude/skills/gstack.
Use /browse for all web browsing — never use
mcp__claude-in-chrome__* tools directly.

