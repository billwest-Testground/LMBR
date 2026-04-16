/**
 * Quote PDF — customer-facing quote renderer.
 *
 * Purpose:  Renders the final customer quote as a US Letter PDF. Consumes
 *           the vendor-structurally-free QuotePdfInput shape from
 *           @lmbr/lib so vendor names, cost prices, and margin
 *           percentages cannot appear on the document even by accident.
 *
 *           Layout goals:
 *             • Light theme with LMBR teal accent — this is the customer-
 *               facing artifact, not an internal tool.
 *             • Sections driven by consolidation mode:
 *                 - structured/hybrid → per building/phase heading
 *                 - phased → per phase heading (null = Unphased last)
 *                 - consolidated → single section, heading suppressed
 *             • Tabular numerics on every price / quantity column so
 *               totals align like a proper quote sheet.
 *             • Tax rows (CA lumber assessment + sales tax) only render
 *               when non-zero — avoids empty "$0.00 Sales Tax" clutter.
 *             • Grand Total prominent, followed by validity disclaimer
 *               and terms footer.
 *
 *           Server-only: @react-pdf/renderer runs under Node; do NOT
 *           mark this file 'use client'.
 *
 * Inputs:   QuotePdfInput.
 * Outputs:  QuotePdfDocument (React-PDF tree — exported for tests) and
 *           renderQuotePdfBuffer(input) → Promise<Buffer>.
 * Agent/API: no LLM. Deterministic render.
 * Imports:  @react-pdf/renderer, react, @lmbr/lib (types only).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from '@react-pdf/renderer';
import React from 'react';

import type { QuotePdfInput, QuotePdfLine, QuotePdfSection } from '@lmbr/lib';

// ---------------------------------------------------------------------------
// Styles (light theme, LMBR teal accent)
// ---------------------------------------------------------------------------

const COLORS = {
  text: '#0A0E0C',
  muted: '#6B7C75',
  line: '#D9E0DD',
  accent: '#1DB87A',
  surface: '#F4F6F5',
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 48,
    paddingHorizontal: 40,
    fontFamily: 'Helvetica',
    fontSize: 10,
    color: COLORS.text,
    backgroundColor: '#FFFFFF',
  },
  header: {
    borderBottomWidth: 2,
    borderBottomColor: COLORS.accent,
    paddingBottom: 10,
    marginBottom: 16,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  companyName: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.text,
  },
  companyDomain: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 2,
  },
  quoteMetaBlock: {
    alignItems: 'flex-end',
  },
  quoteLabel: {
    fontSize: 8,
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  quoteNumber: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.text,
    marginTop: 2,
  },
  quoteDateRow: {
    marginTop: 6,
    fontSize: 9,
    color: COLORS.muted,
  },
  // Customer block
  customerBlock: {
    marginBottom: 14,
  },
  customerName: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
  },
  customerLine: {
    fontSize: 9,
    color: COLORS.muted,
    marginTop: 1,
  },
  // Sections
  sectionHeading: {
    marginTop: 10,
    marginBottom: 4,
    paddingLeft: 6,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accent,
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
  },
  // Table
  tableHeaderRow: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: COLORS.line,
    backgroundColor: COLORS.surface,
    paddingVertical: 4,
  },
  tableHeaderCell: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    textTransform: 'uppercase',
    letterSpacing: 1,
    color: COLORS.muted,
    paddingHorizontal: 4,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderColor: COLORS.line,
    paddingVertical: 4,
  },
  tableCell: {
    fontSize: 10,
    paddingHorizontal: 4,
  },
  colDescription: { width: '42%' },
  colQty: { width: '12%', textAlign: 'right' },
  colUnit: { width: '10%', textAlign: 'center' },
  colUnitPrice: { width: '18%', textAlign: 'right' },
  colExtended: { width: '18%', textAlign: 'right' },
  // Subtotal line per section
  sectionSubtotalRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingVertical: 4,
  },
  sectionSubtotalLabel: {
    fontSize: 9,
    color: COLORS.muted,
    marginRight: 12,
  },
  sectionSubtotalValue: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
  },
  // Totals
  totalsBlock: {
    marginTop: 12,
    borderTopWidth: 1,
    borderColor: COLORS.line,
    paddingTop: 8,
    alignItems: 'flex-end',
  },
  totalsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingVertical: 2,
  },
  totalsLabel: {
    fontSize: 10,
    color: COLORS.muted,
    width: 140,
    textAlign: 'right',
    marginRight: 10,
  },
  totalsValue: {
    fontSize: 10,
    width: 100,
    textAlign: 'right',
  },
  grandTotalRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderColor: COLORS.accent,
  },
  grandTotalLabel: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.text,
    width: 140,
    textAlign: 'right',
    marginRight: 10,
  },
  grandTotalValue: {
    fontSize: 12,
    fontFamily: 'Helvetica-Bold',
    color: COLORS.accent,
    width: 100,
    textAlign: 'right',
  },
  // Footer
  footerBlock: {
    marginTop: 20,
  },
  disclaimer: {
    fontSize: 8,
    color: COLORS.muted,
    marginBottom: 6,
  },
  terms: {
    fontSize: 8,
    color: COLORS.muted,
  },
});

// ---------------------------------------------------------------------------
// Formatters (tabular-nums approximation — Helvetica is not strictly
// tabular but en-US fixed-width rendering via Intl is good enough here)
// ---------------------------------------------------------------------------

function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatQty(value: number): string {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDateISO(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  }).format(d);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Header({ input }: { input: QuotePdfInput }) {
  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.companyName}>{input.company.name}</Text>
          {input.company.emailDomain ? (
            <Text style={styles.companyDomain}>
              quotes@{input.company.emailDomain}
            </Text>
          ) : null}
        </View>
        <View style={styles.quoteMetaBlock}>
          <Text style={styles.quoteLabel}>Quote</Text>
          <Text style={styles.quoteNumber}>{input.quoteNumber}</Text>
          <Text style={styles.quoteDateRow}>
            Date: {formatDateISO(input.quoteDate)}
          </Text>
          <Text style={styles.quoteDateRow}>
            Valid: {formatDateISO(input.validUntil)}
          </Text>
        </View>
      </View>
    </View>
  );
}

function CustomerBlock({ input }: { input: QuotePdfInput }) {
  const customerLines: string[] = [];
  if (input.customer.jobName) customerLines.push(input.customer.jobName);
  if (input.customer.jobAddress) customerLines.push(input.customer.jobAddress);
  if (input.customer.jobState) customerLines.push(input.customer.jobState);

  return (
    <View style={styles.customerBlock}>
      <Text style={styles.customerName}>{input.customer.name}</Text>
      {customerLines.map((line, idx) => (
        <Text key={idx} style={styles.customerLine}>
          {line}
        </Text>
      ))}
    </View>
  );
}

function TableHeader() {
  return (
    <View style={styles.tableHeaderRow}>
      <Text style={[styles.tableHeaderCell, styles.colDescription]}>
        Description
      </Text>
      <Text style={[styles.tableHeaderCell, styles.colQty]}>Qty</Text>
      <Text style={[styles.tableHeaderCell, styles.colUnit]}>Unit</Text>
      <Text style={[styles.tableHeaderCell, styles.colUnitPrice]}>
        Unit Price
      </Text>
      <Text style={[styles.tableHeaderCell, styles.colExtended]}>Extended</Text>
    </View>
  );
}

function LineRow({ line }: { line: QuotePdfLine }) {
  return (
    <View style={styles.tableRow}>
      <Text style={[styles.tableCell, styles.colDescription]}>
        {line.description}
      </Text>
      <Text style={[styles.tableCell, styles.colQty]}>
        {formatQty(line.quantity)}
      </Text>
      <Text style={[styles.tableCell, styles.colUnit]}>{line.unit}</Text>
      <Text style={[styles.tableCell, styles.colUnitPrice]}>
        {formatMoney(line.unitPrice)}
      </Text>
      <Text style={[styles.tableCell, styles.colExtended]}>
        {formatMoney(line.extendedPrice)}
      </Text>
    </View>
  );
}

function Section({ section }: { section: QuotePdfSection }) {
  return (
    <View>
      {section.heading ? (
        <Text style={styles.sectionHeading}>{section.heading}</Text>
      ) : null}
      <TableHeader />
      {section.lines.map((line, idx) => (
        <LineRow key={idx} line={line} />
      ))}
      <View style={styles.sectionSubtotalRow}>
        <Text style={styles.sectionSubtotalLabel}>Subtotal</Text>
        <Text style={styles.sectionSubtotalValue}>
          {formatMoney(section.subtotal)}
        </Text>
      </View>
    </View>
  );
}

function TotalsBlock({ input }: { input: QuotePdfInput }) {
  return (
    <View style={styles.totalsBlock}>
      <View style={styles.totalsRow}>
        <Text style={styles.totalsLabel}>Subtotal</Text>
        <Text style={styles.totalsValue}>{formatMoney(input.subtotal)}</Text>
      </View>
      {input.lumberTax > 0 ? (
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>CA Lumber Assessment</Text>
          <Text style={styles.totalsValue}>{formatMoney(input.lumberTax)}</Text>
        </View>
      ) : null}
      {input.salesTax > 0 ? (
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>Sales Tax</Text>
          <Text style={styles.totalsValue}>{formatMoney(input.salesTax)}</Text>
        </View>
      ) : null}
      <View style={styles.grandTotalRow}>
        <Text style={styles.grandTotalLabel}>Grand Total</Text>
        <Text style={styles.grandTotalValue}>
          {formatMoney(input.grandTotal)}
        </Text>
      </View>
    </View>
  );
}

function Footer({ input }: { input: QuotePdfInput }) {
  return (
    <View style={styles.footerBlock}>
      <Text style={styles.disclaimer}>{input.validityDisclaimer}</Text>
      <Text style={styles.terms}>{input.termsAndConditionsFooter}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface QuotePdfDocumentProps {
  input: QuotePdfInput;
}

export function QuotePdfDocument({ input }: QuotePdfDocumentProps) {
  return (
    <Document title={`Quote ${input.quoteNumber}`}>
      <Page size="LETTER" style={styles.page}>
        <Header input={input} />
        <CustomerBlock input={input} />
        {input.sections.map((section, idx) => (
          <Section key={idx} section={section} />
        ))}
        <TotalsBlock input={input} />
        <Footer input={input} />
      </Page>
    </Document>
  );
}

/**
 * Render the quote PDF to a Node Buffer. Server-only — the caller is
 * expected to be an API route running under `export const runtime =
 * 'nodejs'`.
 */
export async function renderQuotePdfBuffer(
  input: QuotePdfInput,
): Promise<Buffer> {
  return renderToBuffer(<QuotePdfDocument input={input} />);
}
