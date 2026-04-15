# LMBR.ai — Powered by Worklighter

# LMBR.ai — UI/UX Design System

> This file is read by Claude Code before building any component,
> screen, or layout. Every visual decision must follow this system.
> Do not deviate without a documented reason.

---

## Design Philosophy

LMBR.ai is enterprise software sold at $10,000+/month to wholesale
lumber distributors. The UI must feel like a professional trading
tool — not a startup's side project. The aesthetic is:

- Dark-first. The primary experience is on a near-black surface.
  Light mode is available but dark is the default and primary.
- Calm precision. High information density without visual noise.
  Every element earns its place. Nothing decorative for its own sake.
- Fast and confident. Transitions are subtle and quick. No
  animations that slow the user down. Interactions feel immediate.
- Industry credible. A lumber trader who has used Bloomberg
  terminals, ERP systems, and commodity trading dashboards should
  feel at home. Not intimidated by a consumer app.

---

## 1 — Brand Color Palette

Derived from the Worklighter feather mark — yellow-green tip bleeding
into rich teal, on near-black. This is the DNA of every screen.

### Background Surfaces

--color-bg-base:        #0A0E0C   /* near-black with green undertone — page background */
--color-bg-surface:     #111714   /* cards, panels, sidebar */
--color-bg-elevated:    #1A2120   /* modals, dropdowns, hover states */
--color-bg-subtle:      #1F2A27   /* table rows, input backgrounds */

### Borders

--color-border-base:    #1E2E29   /* default borders */
--color-border-subtle:  #162420   /* dividers, separators */
--color-border-strong:  #2A4038   /* focused elements, active states */

### Accent — Teal (Primary Actions)

--color-accent-primary:   #1DB87A   /* primary actions, links, active states, success */
--color-accent-secondary: #15926A   /* hover on primary */
--color-accent-tertiary:  #0F6B4E   /* pressed states */
--color-accent-glow:      #4AE89A   /* notifications, new items, live indicators */

### Accent — Warm Green (Highlights, Attention)

--color-accent-warm:    #8FD44A   /* highlights, badges, recommended states */
--color-accent-warm-2:  #C8E86A   /* success states, positive trends */

### Text

--color-text-primary:   #F0EBE0   /* warm off-white — primary text, headings */
--color-text-secondary: #A8B5AF   /* muted — labels, body text, metadata */
--color-text-tertiary:  #6B7C75   /* very muted — placeholders, disabled */
--color-text-inverse:   #0A0E0C   /* text on light/accent backgrounds */

### Semantic

--color-semantic-success: #1DB87A
--color-semantic-warning: #E8A832
--color-semantic-error:   #E85448
--color-semantic-info:    #4A9EE8

### Gradients

/* Worklighter brand — use for marks and key highlights only */
--gradient-brand: linear-gradient(160deg, #C8E86A 0%, #1DB87A 45%, #0B7A5A 100%);

/* Surface depth — sidebar, panels */
--gradient-surface: linear-gradient(180deg, #111714 0%, #0D1210 100%);

/* Accent glow — active states, feature callouts */
--gradient-accent: linear-gradient(135deg, #1DB87A20 0%, #1DB87A08 100%);

/* Warm — warnings, pricing states */
--gradient-warm: linear-gradient(135deg, #8FD44A 0%, #E8A832 100%);

---

## 2 — Typography

### Font Stack

--font-sans: 'Inter', 'SF Pro Display', -apple-system, BlinkMacSystemFont,
             'Segoe UI', sans-serif;

--font-mono: 'JetBrains Mono', 'SF Mono', 'Fira Code', 'Cascadia Code',
             'Consolas', monospace;

Install: npm install @fontsource/inter @fontsource/jetbrains-mono
All prices and quantities: font-variant-numeric: tabular-nums

### Type Scale

Display:    48px / 52px  / weight 700 / tracking -0.02em
Heading 1:  32px / 38px  / weight 600 / tracking -0.01em
Heading 2:  24px / 30px  / weight 600 / tracking -0.01em
Heading 3:  18px / 24px  / weight 600 / tracking 0
Heading 4:  15px / 21px  / weight 600 / tracking 0
Body LG:    16px / 24px  / weight 400 / tracking 0
Body:       14px / 21px  / weight 400 / tracking 0
Body SM:    13px / 19px  / weight 400 / tracking 0
Caption:    12px / 16px  / weight 400 / tracking 0.01em
Label:      11px / 14px  / weight 500 / tracking 0.04em / UPPERCASE
Mono:       13px / 19px  / weight 400 / tracking 0  (prices, quantities, BF)

### Typography Rules

- All prices and board footage: font-variant-numeric: tabular-nums
- ALL CAPS labels only for status badges and section category labels
- Never use font-weight below 400
- Heading color: always --color-text-primary (#F0EBE0)
- Body color: always --color-text-secondary (#A8B5AF)
- Never use pure white (#FFFFFF) — always use --color-text-primary

---

## 3 — Spacing + Border Radius

Base unit: 4px. All spacing is a multiple of 4.

2px   — micro gaps, icon padding
4px   — xs — tight list spacing
8px   — sm — component internal padding
12px  — md — standard gaps
16px  — lg — section padding, card padding
20px  — xl — panel padding
24px  — 2xl — large component spacing
32px  — 3xl — section spacing
40px  — 4xl — page section gaps
48px  — 5xl — large page sections
64px  — 6xl — hero spacing

### Border Radius

2px   — micro (table cells, small tags)
4px   — xs (inline badges, chips)
6px   — sm (buttons, inputs, small cards)
8px   — md (standard cards, panels)
12px  — lg (modal containers, feature cards)
16px  — xl (large panels)
999px — pill (status badges, toggles)

---

## 4 — Elevation + Shadows

Dark backgrounds use inner glow and border contrast rather than drop shadows.

/* Subtle surface lift */
--shadow-sm: 0 1px 3px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04);

/* Card elevation */
--shadow-md: 0 4px 16px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);

/* Modal / dropdown */
--shadow-lg: 0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06);

/* Accent glow — active, focused */
--shadow-accent: 0 0 0 2px rgba(29, 184, 122, 0.35);

/* Warm glow — warnings, pricing highlights */
--shadow-warm: 0 0 0 2px rgba(143, 212, 74, 0.30);

---

## 5 — Component Specifications

### Buttons

Primary Button
  Background:   --color-accent-primary (#1DB87A)
  Text:         --color-text-inverse (#0A0E0C)
  Font:         14px / weight 500
  Height:       36px
  Padding:      0 16px
  Radius:       6px
  Hover:        --color-accent-secondary (#15926A)
  Active:       scale(0.98) + --color-accent-tertiary
  Focus:        --shadow-accent outline
  Disabled:     opacity 0.4, no pointer events

Secondary Button
  Background:   transparent
  Border:       1px solid --color-border-strong
  Text:         --color-text-primary
  Hover:        background --color-bg-elevated
  Active:       scale(0.98)

Ghost Button
  Background:   transparent
  Border:       none
  Text:         --color-text-secondary
  Hover:        text --color-text-primary + bg --color-bg-subtle

Destructive Button
  Background:   transparent
  Border:       1px solid rgba(232, 84, 72, 0.4)
  Text:         --color-semantic-error
  Hover:        background rgba(232, 84, 72, 0.12)

Icon Button
  Size:         32px x 32px
  Radius:       6px
  Background:   transparent
  Hover:        --color-bg-elevated

### Inputs

Text Input
  Background:   --color-bg-subtle
  Border:       1px solid --color-border-base
  Text:         --color-text-primary
  Placeholder:  --color-text-tertiary
  Height:       36px
  Padding:      0 12px
  Radius:       6px
  Font:         14px / weight 400

  Focus:
    Border:     1px solid --color-accent-primary
    Shadow:     --shadow-accent
    Background: --color-bg-elevated

  Error:
    Border:     1px solid --color-semantic-error
    Shadow:     0 0 0 2px rgba(232, 84, 72, 0.25)

Price Input (used throughout comparison matrix and margin stack)
  Same as text input PLUS:
  font-family:              --font-mono
  font-variant-numeric:     tabular-nums
  text-align:               right
  Color when empty:         --color-text-tertiary
  Color when populated:     --color-text-primary
  Color when best price:    --color-accent-primary
  Color when above average: --color-semantic-warning

Select / Dropdown
  Same as text input
  Right icon: chevron-down in --color-text-tertiary
  Dropdown panel:
    Background:  --color-bg-elevated
    Border:      1px solid --color-border-strong
    Shadow:      --shadow-lg
    Radius:      8px
    Item height: 36px
    Item hover:  --color-bg-subtle
    Item selected: rgba(29,184,122,0.12) + text --color-accent-primary

Label
  Font:          11px / weight 500 / UPPERCASE / tracking 0.04em
  Color:         --color-text-tertiary
  Margin-bottom: 6px

### Cards and Panels

Standard Card
  Background: --color-bg-surface
  Border:     1px solid --color-border-base
  Radius:     8px
  Padding:    20px
  Shadow:     --shadow-sm

  Hover (interactive cards):
    Border:     1px solid --color-border-strong
    Shadow:     --shadow-md
    Transition: 150ms ease

Feature Card (highlighted — active bid, best price)
  Background: linear-gradient(135deg, rgba(29,184,122,0.08) 0%, rgba(29,184,122,0.03) 100%)
  Border:     1px solid rgba(29, 184, 122, 0.25)
  Radius:     8px
  Padding:    20px

Stat Card (metric display — dashboard, summary panels)
  Background: --color-bg-surface
  Border:     1px solid --color-border-base
  Radius:     8px
  Padding:    16px 20px
  Label:      12px / UPPERCASE / tracking 0.04em / --color-text-tertiary
  Value:      28px / weight 600 / --color-text-primary / tabular-nums
  Trend up:   --color-accent-warm + up arrow icon
  Trend down: --color-semantic-error + down arrow icon

### Sidebar Navigation

Width:         240px expanded / 60px collapsed
Background:    --color-bg-surface
Border-right:  1px solid --color-border-subtle
Padding:       16px 12px

Nav Item:
  Height:      36px
  Padding:     0 12px
  Radius:      6px
  Font:        14px / weight 400 / --color-text-secondary
  Icon:        16px / --color-text-tertiary
  Gap:         10px between icon and label

  Hover:       background --color-bg-elevated + text --color-text-primary
  Active:      background rgba(29,184,122,0.12) + text --color-accent-primary
               icon --color-accent-primary
               border-left: 2px solid --color-accent-primary

Badge on nav item (pending count):
  Background:  --color-accent-primary
  Text:        --color-text-inverse
  Height:      18px
  Min-width:   18px
  Radius:      999px
  Font:        11px / weight 600

### Header / Top Bar

Height:        56px
Background:    --color-bg-base
Border-bottom: 1px solid --color-border-subtle
Padding:       0 24px
Contains:      breadcrumb (left) / actions (right)
Breadcrumb:    14px / --color-text-tertiary / separator "/"
               Current page: --color-text-primary

### Page Layout

Sidebar:           fixed left
Content:           fills remaining width
Max content width: 1400px
Page padding:      32px
Section gap:       32px

---

## 6 — Tables

The comparison matrix and line item table are the most important
tables in the product. They must be fast, dense, and scannable.

### Standard Data Table

Background:       --color-bg-base

Header row:
  Background:     --color-bg-surface
  Text:           11px / weight 500 / UPPERCASE / tracking 0.04em / --color-text-tertiary
  Height:         36px
  Border-bottom:  1px solid --color-border-base
  Padding:        0 12px
  Position:       sticky top-0

Body row:
  Height:         44px standard / 36px compact
  Padding:        0 12px
  Border-bottom:  1px solid --color-border-subtle
  Hover:          background --color-bg-subtle
  Selected:       background rgba(29,184,122,0.06)

Numeric cells (price, BF, qty):
  font-family:    --font-mono
  font-variant-numeric: tabular-nums
  text-align:     right
  color:          --color-text-primary

Text cells (species, grade, building):
  text-align:     left
  color:          --color-text-secondary

### Comparison Matrix (Most Important Screen)

REQUIRED: Must be virtualized using react-window or TanStack Virtual.
Must handle 400 rows x 10 vendor columns without any lag.

Vendor columns:
  Min-width:      110px
  Header:         vendor name, truncated, centered
  All cells:      price input, right-aligned, monospace

Best price cell:
  Background:     rgba(29, 184, 122, 0.15)
  Text:           --color-accent-primary
  Font-weight:    600
  Border:         1px solid rgba(29, 184, 122, 0.3)
  Radius:         4px

No-bid cell:
  Text:           "--"
  Color:          --color-text-tertiary

Declined cell:
  Text:           "declined"
  Color:          --color-text-tertiary
  Font-style:     italic

Selected cell (trader has chosen this vendor for this line):
  Background:     rgba(143, 212, 74, 0.12)
  Border:         1px solid rgba(143, 212, 74, 0.4)
  Text:           --color-accent-warm

Row summary column (rightmost, sticky):
  Background:     --color-bg-surface
  Border-left:    1px solid --color-border-base
  Shows:          best price / spread amount / bid count

Running total bar (bottom, sticky):
  Background:     --color-bg-elevated
  Border-top:     1px solid --color-border-strong
  Height:         56px
  Padding:        0 16px
  Shows:          selection total cost / savings vs worst / vendor count

Vendor names:
  Watermark on all vendor name cells: "Internal only — never shown to customer"

Controls:
  "Select all cheapest" — best price per line, one click
  "Minimize vendors"    — optimize for fewest purchase orders
  Manual cell selection — click to assign vendor per line item

### Line Item Table (Post-Extraction)

Building group header row:
  Background:   --color-bg-surface
  Border-left:  3px solid --color-accent-primary
  Padding-left: 16px
  Font:         14px / weight 600 / --color-text-primary
  Shows:        building name / line count / total BF

Confidence column:
  Colored dot before species name (no separate column)
  green  > 0.90
  orange 0.75 - 0.90
  red    < 0.75

Flag indicator:
  Orange dot with tooltip on hover listing all flags
  Click opens inline correction mode for that row

Inline edit mode:
  Row expands slightly
  All cells become inputs
  Save / Cancel appear inline at row end

---

## 7 — Status Badges

All badges: pill shape (radius 999px)
Font: 11px / weight 500 / UPPERCASE / tracking 0.04em
Padding: 3px 8px

Bid Status:
  received:         bg rgba(74,158,232,0.15)   text #4A9EE8
  extracting:       bg rgba(29,184,122,0.15)   text #1DB87A  + pulse dot
  reviewing:        bg rgba(232,168,50,0.15)   text #E8A832
  routing:          bg rgba(143,212,74,0.15)   text #8FD44A
  quoting:          bg rgba(29,184,122,0.15)   text #1DB87A
  comparing:        bg rgba(143,212,74,0.15)   text #8FD44A
  pricing:          bg rgba(232,168,50,0.15)   text #E8A832
  pending_approval: bg rgba(232,168,50,0.15)   text #E8A832
  approved:         bg rgba(29,184,122,0.15)   text #1DB87A
  sent:             bg rgba(74,158,232,0.15)   text #4A9EE8
  archived:         bg rgba(107,124,117,0.15)  text #6B7C75

Confidence Scores:
  high   (> 0.90):      dot + text --color-accent-primary
  medium (0.75 - 0.90): dot + text --color-semantic-warning
  low    (< 0.75):      dot + text --color-semantic-error

---

## 8 — Modals, Toasts + Overlays

### Modals

Overlay:    rgba(0, 0, 0, 0.70) / backdrop-filter: blur(4px)

Container:
  Background: --color-bg-surface
  Border:     1px solid --color-border-strong
  Shadow:     --shadow-lg
  Radius:     12px

Header:
  Padding:       20px 24px 16px
  Border-bottom: 1px solid --color-border-subtle
  Title:         Heading 3 / --color-text-primary
  Close button:  top-right ghost icon button

Body:
  Padding: 24px

Footer:
  Padding:    16px 24px
  Border-top: 1px solid --color-border-subtle
  Actions:    right-aligned, gap 8px

Sizes:
  sm:   400px wide
  md:   560px wide (default)
  lg:   720px wide
  xl:   900px wide
  full: fullscreen with inset padding

### Toast Notifications

Position:    bottom-right / 16px from edges
Width:       360px max
Radius:      8px
Shadow:      --shadow-lg
Padding:     14px 16px
Gap:         8px between stacked toasts

Success:
  Background:  rgba(29, 184, 122, 0.12)
  Border-left: 3px solid --color-accent-primary
  Icon:        check-circle in --color-accent-primary

Warning:
  Background:  rgba(232, 168, 50, 0.12)
  Border-left: 3px solid --color-semantic-warning

Error:
  Background:  rgba(232, 84, 72, 0.12)
  Border-left: 3px solid --color-semantic-error

Info:
  Background:  rgba(74, 158, 232, 0.12)
  Border-left: 3px solid --color-semantic-info

Duration:    4000ms default / no auto-dismiss on error
Exit:        slide out right + fade / 200ms

---

## 9 — Loading States + Empty States

No raw spinners. Every loading state communicates what is happening.

### Loading Patterns

Skeleton:
  Background: --color-bg-elevated
  Shimmer:    gradient animation left-to-right
              from --color-bg-elevated to --color-bg-subtle
  Duration:   1.5s linear infinite
  Radius:     matches the element being loaded

Progress bar (file upload, extraction):
  Track:   --color-bg-subtle / height 4px / radius 2px
  Fill:    --color-accent-primary
  Label:   14px status message above with ellipsis animation

Processing indicator (AI extraction):
  Animated dot trio: . . .
  Each dot pulses opacity 0.2 to 1.0 with 200ms stagger
  Color: --color-accent-primary
  Accompanies text label

Inline spinner (button loading state):
  16px x 16px SVG circle
  Stroke: --color-text-inverse (on primary button)
          --color-accent-primary (on ghost/secondary)
  Animation: rotate 700ms linear infinite
  Replaces button label while loading

Status messages to use:
  Extraction:  "Reading your list..."
               "Identifying species and grades..."
               "Running quality check..."
  Dispatch:    "Sending to 7 vendors..."
  Comparison:  "Comparing prices across X vendors..."
  PDF:         "Generating your quote..."
  Budget:      "Calculating from current market data..."

### Empty States

Container:  centered / max-width 360px / padding 48px 24px
Icon:       48px x 48px / --color-text-tertiary / outlined style
Title:      Heading 3 / --color-text-secondary / margin-top 16px
Body:       Body / --color-text-tertiary / margin-top 8px / text-align center
CTA:        Primary or secondary button / margin-top 24px

LMBR-specific:
  No bids:
    icon:  inbox
    title: "No bids yet"
    body:  "Forward your first lumber list to bids@[company].com to get started"

  No vendors:
    icon:  building
    title: "No vendors added"
    body:  "Add your vendor list to start dispatching bids"

  No market data:
    icon:  chart
    title: "Market data is building"
    body:  "Pricing intelligence grows as you process bids"

  Awaiting vendor responses:
    icon:  clock
    title: "Waiting on [X] vendors"
    body:  "Due [date]"

---

## 10 — Screen-Specific Patterns

### Trader Dashboard

Layout:     3-column responsive grid (stat cards) + full-width table below

Stat cards (row of 4):
  Active bids / Bids due today / Avg turnaround / Quotes sent MTD

Pipeline table:
  Columns:  Job / Customer / BF / Status / Due Date / Action
  Sortable columns
  Status:   badge component
  Action:   context menu (...) with quick actions
  New bid:  primary button top-right of table header

### Unified Trader-Buyer Dashboard (Flagship Screen)

This is the most important screen. Must feel like a trading terminal.

Layout:      True split panel — 50/50 or 60/40 with draggable divider

Left panel (Trader):
  Header:    "Incoming Bids" + count badge
  Content:   bid queue

Right panel (Buyer):
  Header:    "Vendor Queue" + count badge
  Content:   vendor bid request queue

Divider:
  Width:     1px / --color-border-base
  Handle:    4px wide centered / --color-border-strong on hover

Role badge (in header):
  Background: rgba(143,212,74,0.12)
  Border:     1px solid rgba(143,212,74,0.3)
  Text:       --color-accent-warm
  Label:      "Trader + Buyer"

Mobile: tabs between trader and buyer views
Real-time: both panels update live — no manual refresh

### Consolidation Controls

Mode selector: 4 cards in 2x2 grid or horizontal row

Each card:
  Icon:        32px
  Title:       Heading 4 / --color-text-primary
  Description: Body SM / --color-text-secondary
  Border:      1px solid --color-border-base
  Radius:      8px
  Padding:     16px

Selected card:
  Border:      1px solid --color-accent-primary
  Background:  rgba(29,184,122,0.08)
  Checkmark:   top-right corner / --color-accent-primary

Recommended badge (on Hybrid):
  Background:  --color-accent-warm
  Text:        "Recommended for large jobs"

Preview panel (below selector):
  Background:  --color-bg-subtle
  Border:      1px solid --color-border-base
  Radius:      8px
  Padding:     16px

HYBRID preview: split view
  Left:  "What vendors see" (consolidated)
  Right: "What customer sees" (building/phase breakdown)

### Market Dashboard

Futures ticker bar (top, full-width):
  Background:    --color-bg-surface
  Height:        48px
  Padding:       0 24px
  Border-bottom: 1px solid --color-border-base

  Ticker item:
    Label:       11px / UPPERCASE / --color-text-tertiary
    Price:       16px / weight 600 / tabular-nums / --color-text-primary
    Change up:   --color-accent-warm + up arrow
    Change down: --color-semantic-error + down arrow
    Separator:   1px vertical / --color-border-subtle

Price cards (grid, 3-4 per row):
  Height:         100px
  Species label:  11px / UPPERCASE / --color-text-tertiary
  Dimension:      13px / --color-text-secondary
  Price:          24px / weight 600 / tabular-nums / --color-text-primary
  $/MBF label:    11px / --color-text-tertiary
  Sparkline:      48px wide / 24px tall / --color-accent-primary stroke
  Trend:          colored arrow + % change

Recharts config:
  Background:     transparent
  Grid lines:     1px / --color-border-subtle / horizontal only
  Axis text:      11px / --color-text-tertiary
  Tooltip:
    Background:   --color-bg-elevated
    Border:       1px solid --color-border-strong
    Radius:       6px
    Shadow:       --shadow-md
  LMBR line:      --color-accent-primary / 2px stroke
  CME line:       --color-text-tertiary / 1px stroke / dashed

---

## 11 — Motion + Transitions

Micro (hover, focus):      100ms ease
Standard (state change):   150ms ease
Entrance (modal, panel):   200ms ease-out
Exit (dismiss, close):     150ms ease-in
Page transition:           200ms ease
Draggable elements:        spring() animation

Rules:
- No animations that block interaction
- Respect prefers-reduced-motion — show instant states

---

## 12 — Mobile Patterns (Expo / NativeWind)

Bottom tab bar:
  Background:    --color-bg-surface
  Border-top:    1px solid --color-border-subtle
  Height:        80px (includes safe area)
  Tab icon:      24px / --color-text-tertiary inactive
                 24px / --color-accent-primary active
  Tab label:     10px / weight 500

Touch targets:   minimum 44x44px for ALL interactive elements
List items:      minimum 56px height
Safe areas:      always respected with SafeAreaView

Haptics:
  Medium impact: send, approve, submit
  Light impact:  select, toggle
  Notification:  success events

Pull to refresh: tint --color-accent-primary / standard RefreshControl

Lists 50+ items: FlashList — never ScrollView with map()

Camera scan:
  Full-screen capture
  Crop before upload
  Preview before submit

---

## 13 — Tailwind Configuration

Copy into tailwind.config.ts in apps/web/ and apps/mobile/.

import type { Config } from 'tailwindcss'

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          base:     '#0A0E0C',
          surface:  '#111714',
          elevated: '#1A2120',
          subtle:   '#1F2A27',
        },
        border: {
          base:   '#1E2E29',
          subtle: '#162420',
          strong: '#2A4038',
        },
        accent: {
          primary:   '#1DB87A',
          secondary: '#15926A',
          tertiary:  '#0F6B4E',
          warm:      '#8FD44A',
          warm2:     '#C8E86A',
          glow:      '#4AE89A',
        },
        text: {
          primary:   '#F0EBE0',
          secondary: '#A8B5AF',
          tertiary:  '#6B7C75',
          inverse:   '#0A0E0C',
        },
        semantic: {
          success: '#1DB87A',
          warning: '#E8A832',
          error:   '#E85448',
          info:    '#4A9EE8',
        },
      },
      fontFamily: {
        sans: ['Inter', 'SF Pro Display', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Fira Code', 'monospace'],
      },
      borderRadius: {
        xs:      '4px',
        sm:      '6px',
        DEFAULT: '8px',
        lg:      '12px',
        xl:      '16px',
      },
      boxShadow: {
        sm:     '0 1px 3px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04)',
        md:     '0 4px 16px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)',
        lg:     '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)',
        accent: '0 0 0 2px rgba(29,184,122,0.35)',
        warm:   '0 0 0 2px rgba(143,212,74,0.30)',
      },
    },
  },
  plugins: [],
} satisfies Config

---

## 14 — Component Library Rules

These 8 rules are non-negotiable. They prevent visual drift across
12 build sessions.

1. DARK BACKGROUND FIRST
   All components are built for dark backgrounds. Light mode is an
   inversion layer applied at the root. Individual components should
   never hard-code light colors.

2. NO PURE WHITE
   Use --color-text-primary (#F0EBE0) for text and --color-bg-elevated
   (#1A2120) for light surfaces. Never use #FFFFFF.

3. BORDERS ARE STRUCTURAL NOT DECORATIVE
   Every border has a reason. Decorative frames around content add
   visual noise. If you can remove a border without losing clarity,
   remove it.

4. ACCENT COLORS HAVE HIERARCHY
   Teal (#1DB87A) = primary actions and success states.
   Warm green (#8FD44A) = highlights, attention, recommended states.
   Never use both colors for the same semantic meaning.

5. DATA IS READABLE FIRST
   Prices, board footage, and quantities must use monospace tabular
   numerals and right-align in columns. This is non-negotiable.
   Misaligned numbers destroy trust in a trading tool.

6. VIRTUALIZE LARGE LISTS
   Any list or table over 50 rows must use react-window or TanStack
   Virtual. The comparison matrix (400 rows x 10 vendor columns) must
   be virtualized without exception. No ScrollView with map().

7. EVERY INTERACTIVE ELEMENT HAS THREE STATES
   Default, hover, and active/pressed. Plus focus state for keyboard
   navigation. No state transition takes longer than 200ms.

8. LOADING STATES TELL A STORY
   Never show a raw spinner. Always show a descriptive message about
   what the AI is doing at that moment. This builds trust and makes
   the product feel intelligent rather than slow.

---

## 15 — Accessibility

- Minimum contrast ratio: 4.5:1 for body text / 3:1 for large text
- All interactive elements focusable via keyboard
- Focus rings: --shadow-accent on teal elements
- ARIA labels on all icon-only buttons
- Screen reader labels on all status badges
- Reduced motion: respect prefers-reduced-motion on all animations

---

LMBR.ai Design System — Powered by Worklighter
lmbr.ai | worklighter.ai | verilane.ai
Last updated: April 2026

Copy this entire file into README.md in your project root.
Claude Code reads README.md before every build session.
