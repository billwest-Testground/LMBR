/**
 * QuotePdfInput — customer-facing quote renderer input.
 * Vendor names, cost prices, and margin percentages are
 * structurally absent from this type by design.
 * Internal cost data lives in quote_line_items.cost_price
 * and never flows into this shape.
 * Do not add vendor or cost fields to this type.
 */

/**
 * Purpose:  Shared types + pure builder that convert the priced-line
 *           side of a PricingResult into the vendor-free shape consumed
 *           by the quote PDF renderer in
 *           apps/web/src/lib/pdf/quote-pdf.tsx. The builder switches on
 *           consolidation_mode to decide customer-facing section
 *           grouping:
 *             - structured: group by (buildingTag, phaseNumber)
 *             - consolidated: single section, like-items aggregated
 *             - phased: one section per phase (null = 'Unphased')
 *             - hybrid: CUSTOMER-FACING = structured (identical to
 *               STRUCTURED). Vendors see the consolidated tally; the
 *               customer-facing PDF never does.
 *
 *           Guardrail: QuotePdfInput deliberately omits vendor / cost /
 *           margin fields. The module avoids importing from
 *           @lmbr/agents (would introduce a circular dependency —
 *           @lmbr/agents already depends on @lmbr/lib) and instead
 *           accepts the minimal priced-line shape it actually needs.
 *
 * Inputs:   Priced line rows + bid/company metadata + totals/taxes.
 * Outputs:  QuotePdfInput (pure data — no side effects).
 * Agent/API: no LLM, no DB, no network.
 * Imports:  none at runtime.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

// -----------------------------------------------------------------------------
// Local structural types (avoid circular dep on @lmbr/agents)
// -----------------------------------------------------------------------------

export type PdfConsolidationMode =
  | 'structured'
  | 'consolidated'
  | 'phased'
  | 'hybrid';

export type PdfLineUnit = 'PCS' | 'MBF' | 'MSF';

/**
 * Minimal priced-line shape the PDF builder needs. The caller passes a
 * projection of `PricingResult.lines` with ONLY the fields below — in
 * particular, vendorId / costUnitPrice / costTotalPrice / marginPercent
 * are NOT on this type and cannot accidentally appear on the PDF.
 */
export interface PdfPricedLineInput {
  lineItemId: string;
  sortOrder: number;
  buildingTag: string | null;
  phaseNumber: number | null;
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number;
  unit: PdfLineUnit;
  sellUnitPrice: number;
  extendedSell: number;
}

// -----------------------------------------------------------------------------
// Public output types (customer-facing — NO vendor, NO cost, NO margin)
// -----------------------------------------------------------------------------

export interface QuotePdfLine {
  description: string;
  quantity: number;
  unit: PdfLineUnit;
  unitPrice: number;
  extendedPrice: number;
}

export interface QuotePdfSection {
  /** Null when consolidation is 'consolidated'. */
  heading: string | null;
  lines: QuotePdfLine[];
  subtotal: number;
}

export interface QuotePdfInput {
  consolidationMode: PdfConsolidationMode;
  quoteNumber: string;
  quoteDate: string;
  validUntil: string;
  customer: {
    name: string;
    jobName: string | null;
    jobAddress: string | null;
    jobState: string | null;
  };
  company: {
    name: string;
    slug: string;
    emailDomain: string | null;
  };
  sections: QuotePdfSection[];
  subtotal: number;
  lumberTax: number;
  salesTax: number;
  grandTotal: number;
  validityDisclaimer: string;
  termsAndConditionsFooter: string;
}

// -----------------------------------------------------------------------------
// Builder
// -----------------------------------------------------------------------------

export interface BuildQuotePdfInputArgs {
  /** Projection of PricingResult.lines (no vendor / cost / margin fields). */
  pricedLines: PdfPricedLineInput[];
  totals: {
    lumberTax: number;
    salesTax: number;
    grandTotal: number;
  };
  bid: {
    customerName: string;
    jobName: string | null;
    jobAddress: string | null;
    jobState: string | null;
    consolidationMode: PdfConsolidationMode;
  };
  company: { name: string; slug: string; emailDomain: string | null };
  quoteNumber: string;
  quoteDate: Date;
  validUntil: Date;
}

const DEFAULT_DISCLAIMER =
  'Prices subject to market conditions. Quote valid through the date listed above. ' +
  'Material availability confirmed at time of order.';

const DEFAULT_TERMS =
  'Terms: Net 30 on approved credit. FOB origin unless otherwise noted. ' +
  'All sales subject to our standard terms and conditions.';

/**
 * Build a QuotePdfInput from projected priced lines + totals. Vendor
 * identities are never passed in — the input shape itself enforces
 * this invariant. Pure, side-effect-free.
 *
 * Zero-priced rows (extendedSell <= 0) are dropped so unresolved lines
 * from /api/margin never render as $0 rows on the customer PDF.
 */
export function buildQuotePdfInput(args: BuildQuotePdfInputArgs): QuotePdfInput {
  const { pricedLines, totals, bid, company, quoteNumber, quoteDate, validUntil } =
    args;

  const priced = pricedLines.filter((l) => l.extendedSell > 0);

  const mode = bid.consolidationMode;
  const sections = buildSections(mode, priced);
  const subtotal = round2(sections.reduce((sum, s) => sum + s.subtotal, 0));

  return {
    consolidationMode: mode,
    quoteNumber,
    quoteDate: quoteDate.toISOString(),
    validUntil: validUntil.toISOString(),
    customer: {
      name: bid.customerName,
      jobName: bid.jobName,
      jobAddress: bid.jobAddress,
      jobState: bid.jobState,
    },
    company,
    sections,
    subtotal,
    lumberTax: totals.lumberTax,
    salesTax: totals.salesTax,
    grandTotal: totals.grandTotal,
    validityDisclaimer: DEFAULT_DISCLAIMER,
    termsAndConditionsFooter: DEFAULT_TERMS,
  };
}

// -----------------------------------------------------------------------------
// Section builders per consolidation mode
// -----------------------------------------------------------------------------

function buildSections(
  mode: PdfConsolidationMode,
  priced: PdfPricedLineInput[],
): QuotePdfSection[] {
  switch (mode) {
    case 'structured':
    case 'hybrid':
      // HYBRID is deliberately identical to STRUCTURED on the customer
      // side. Vendors see the aggregated tally; the customer PDF keeps
      // the building / phase breakdown. This is the spec's subtle point.
      return groupByBuildingPhase(priced);
    case 'consolidated':
      return [consolidatedSection(priced)];
    case 'phased':
      return groupByPhase(priced);
    default: {
      const _exhaustive: never = mode;
      void _exhaustive;
      return groupByBuildingPhase(priced);
    }
  }
}

function groupByBuildingPhase(priced: PdfPricedLineInput[]): QuotePdfSection[] {
  const bucket = new Map<
    string,
    { heading: string | null; lines: QuotePdfLine[] }
  >();

  for (const pl of sortedForDisplay(priced)) {
    const tag = pl.buildingTag;
    const phase = pl.phaseNumber;
    const key = `${tag ?? ''}|${phase ?? ''}`;
    const heading =
      tag === null && phase === null
        ? 'General'
        : tag === null
          ? `Phase ${phase}`
          : phase === null
            ? tag
            : `${tag} · Phase ${phase}`;

    let entry = bucket.get(key);
    if (!entry) {
      entry = { heading, lines: [] };
      bucket.set(key, entry);
    }
    entry.lines.push(toPdfLine(pl));
  }

  return [...bucket.values()].map((s) => ({
    heading: s.heading,
    lines: s.lines,
    subtotal: round2(s.lines.reduce((sum, l) => sum + l.extendedPrice, 0)),
  }));
}

function groupByPhase(priced: PdfPricedLineInput[]): QuotePdfSection[] {
  const bucket = new Map<
    string,
    { heading: string; lines: QuotePdfLine[]; phaseKey: number | null }
  >();

  for (const pl of sortedForDisplay(priced)) {
    const phase = pl.phaseNumber;
    const key = phase === null ? 'null' : String(phase);
    const heading = phase === null ? 'Unphased' : `Phase ${phase}`;
    let entry = bucket.get(key);
    if (!entry) {
      entry = { heading, lines: [], phaseKey: phase };
      bucket.set(key, entry);
    }
    entry.lines.push(toPdfLine(pl));
  }

  // Render phases in numeric order, with 'Unphased' (null) last.
  const entries = [...bucket.values()].sort((a, b) => {
    if (a.phaseKey === null && b.phaseKey === null) return 0;
    if (a.phaseKey === null) return 1;
    if (b.phaseKey === null) return -1;
    return a.phaseKey - b.phaseKey;
  });

  return entries.map((s) => ({
    heading: s.heading,
    lines: s.lines,
    subtotal: round2(s.lines.reduce((sum, l) => sum + l.extendedPrice, 0)),
  }));
}

function consolidatedSection(priced: PdfPricedLineInput[]): QuotePdfSection {
  // Aggregate like items by (species|dimension|grade|length|unit). Unit
  // price becomes a quantity-weighted average; variance has already been
  // absorbed by the margin stack by the time we reach this layer.
  const keyOf = (pl: PdfPricedLineInput) =>
    [
      pl.species,
      pl.dimension,
      pl.grade ?? '',
      pl.length ?? '',
      pl.unit,
    ].join('|');

  const bucket = new Map<
    string,
    {
      description: string;
      quantity: number;
      unit: PdfLineUnit;
      extendedPrice: number;
    }
  >();

  for (const pl of sortedForDisplay(priced)) {
    const key = keyOf(pl);
    let entry = bucket.get(key);
    if (!entry) {
      entry = {
        description: describe(pl),
        quantity: 0,
        unit: pl.unit,
        extendedPrice: 0,
      };
      bucket.set(key, entry);
    }
    entry.quantity += pl.quantity;
    entry.extendedPrice += pl.extendedSell;
  }

  const lines: QuotePdfLine[] = [...bucket.values()].map((b) => ({
    description: b.description,
    quantity: b.quantity,
    unit: b.unit,
    unitPrice: b.quantity > 0 ? round2(b.extendedPrice / b.quantity) : 0,
    extendedPrice: round2(b.extendedPrice),
  }));

  return {
    heading: null,
    lines,
    subtotal: round2(lines.reduce((sum, l) => sum + l.extendedPrice, 0)),
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sortedForDisplay(priced: PdfPricedLineInput[]): PdfPricedLineInput[] {
  return [...priced].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    const aTag = a.buildingTag ?? '';
    const bTag = b.buildingTag ?? '';
    if (aTag !== bTag) return aTag < bTag ? -1 : 1;
    if (a.lineItemId !== b.lineItemId) return a.lineItemId < b.lineItemId ? -1 : 1;
    return 0;
  });
}

function toPdfLine(pl: PdfPricedLineInput): QuotePdfLine {
  return {
    description: describe(pl),
    quantity: pl.quantity,
    unit: pl.unit,
    unitPrice: pl.sellUnitPrice,
    extendedPrice: pl.extendedSell,
  };
}

function describe(pl: PdfPricedLineInput): string {
  const parts = [
    pl.species,
    pl.dimension,
    pl.grade ?? '',
    pl.length ? `${pl.length}'` : '',
  ];
  return parts.filter((p) => p.trim() !== '').join(' ');
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}
