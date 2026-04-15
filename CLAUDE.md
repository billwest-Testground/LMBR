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
| Component base | shadcn/ui | Web only |
| Icons | lucide-react | |
| Date handling | date-fns | |
EXTRACTION PIPELINE (tiered — cheapest method first):

Layer 0 — File type detection (free)
Layer 1A — exceljs direct parse (Excel/CSV — free)
Layer 1B — pdf-parse text extraction (text PDFs — free)
Layer 1C — mammoth (DOCX — free)
Layer 1D — Azure Document Intelligence OCR (scanned/image — $1.50/1k pages)
Layer 2 — Claude Sonnet extraction (fallback only — fires when confidence < 0.92)
Layer 3 — Claude Haiku QA agent (lightweight validation — 10x cheaper than Sonnet)

Target: fewer than 15% of documents should reach Layer 2 (Claude extraction).
Lumber lists in Excel or clean PDF format should never touch the LLM.

Confidence threshold: 0.92 (env: EXTRACTION_CONFIDENCE_THRESHOLD)
Extraction method is recorded on every line item (excel_parse / pdf_parse /
docx_parse / ocr / claude_extraction) for cost monitoring.

New packages required in packages/lib/:
  - exceljs ^4.4.0
  - pdf-parse ^1.1.1
  - mammoth ^1.8.0
  - @azure/ai-form-recognizer ^5.0.0

New files:
  packages/lib/src/lumber-parser.ts     — deterministic regex + structured parse
  packages/lib/src/attachment-analyzer.ts — file type router (method selector)

QA agent model: claude-haiku-4-5-20251001 (not sonnet)
Extraction agent model: claude-sonnet-4-6 (fallback only)

New env vars:
  AZURE_DOC_INTELLIGENCE_ENDPOINT=
  AZURE_DOC_INTELLIGENCE_KEY=
  EXTRACTION_CONFIDENCE_THRESHOLD=0.92
---

## Package Naming Convention

All internal packages use the `@lmbr/` prefix:

```
@lmbr/agents   — AI agents (ingest, QA, extraction, routing, pricing, comparison, market)
@lmbr/types    — TypeScript types (bid, user, role, vendor, line-item, quote, market)
@lmbr/lib      — Shared clients (anthropic.ts, supabase.ts, outlook.ts, ocr.ts, pdf.ts)
@lmbr/config   — Constants (commodities.ts, regions.ts, tax-rates.ts)
```

Web and mobile apps import from these packages. Business logic lives
in packages, never in apps.

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
- `vendor_bids` — dispatch records per vendor per bid
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
POST /api/ingest          ← file upload → extraction
POST /api/extract         ← scan-back OCR
POST /api/qa              ← QA agent review
POST /api/consolidate     ← apply consolidation mode
POST /api/route-bid       ← routing engine
POST /api/vendors         ← vendor dispatch
POST /api/compare         ← build comparison matrix
POST /api/margin          ← apply margin instructions
POST /api/quote           ← generate PDF quote
GET  /api/market          ← market price data
POST /api/market/budget-quote ← AI budget estimate
POST /api/webhook/outlook ← Graph API email webhook
```

---

## AI Agents (@lmbr/agents)

All agents use `claude-sonnet-4-6`. Each agent is a single file
with a clear input/output contract.

| Agent | Purpose |
|---|---|
| `ingest-agent.ts` | Orchestrates the full extraction pipeline |
| `extraction-agent.ts` | Parses lumber lists into structured JSON |
| `qa-agent.ts` | Reviews extraction, flags issues, scores confidence |
| `routing-agent.ts` | Assigns line items to correct buyers |
| `consolidation-agent.ts` | Aggregates items, maintains source mapping |
| `comparison-agent.ts` | Ranks vendor pricing, suggests selection |
| `pricing-agent.ts` | Aggregates market data, analyzes archive |
| `market-agent.ts` | Generates budget quotes from market data |

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
// - Uses claude-sonnet-4-6
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

- [ ] Scaffold + monorepo setup
- [ ] README.md — UI/UX design system loaded
- [ ] PROMPT 01 — Supabase schema + auth
- [ ] PROMPT 02 — Ingest engine
- [ ] PROMPT 03 — Routing engine
- [ ] PROMPT 04 — Consolidation controls
- [ ] PROMPT 05 — Vendor bid collection
- [ ] PROMPT 06 — Comparison matrix
- [ ] PROMPT 07 — Margin stacking + quote output
- [ ] PROMPT 08 — Outlook integration
- [ ] PROMPT 09 — Market intelligence layer
- [ ] PROMPT 10 — Archive + knowledge base
- [ ] PROMPT 11 — Settings + company config
- [ ] PROMPT 12 — Polish + QA pass
- [ ] Demo seed data
- [ ] EAS mobile build
- [ ] App Store submission

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
