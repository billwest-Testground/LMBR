/**
 * Vendor tally PDF — printable pricing sheet for paper-workflow vendors.
 *
 * Purpose:  Renders the "Request for Pricing" tally as a US Letter PDF. A
 *           vendor prints the sheet, hand-writes unit prices (and optional
 *           notes) in the blank boxes on each row, then either faxes the
 *           sheet back or photographs it; the scan-back OCR path in Task 5
 *           will OCR the token printed at the page footer to re-attach the
 *           prices to the correct vendor_bids row.
 *
 *           Layout goals:
 *             • Printer-friendly (black on white, Helvetica, no logos).
 *             • Dense but readable at 10pt body / 8pt footer.
 *             • The same vendor-visible line-item set that the web form
 *               shows (so the digital and paper paths can never disagree).
 *             • Unit-Price and Notes columns rendered as boxed cells so
 *               the vendor knows exactly where to write.
 *             • Token + submit URL + "Page N of M" repeat on every page
 *               (fixed footer) so a scanned stack that gets separated can
 *               still be OCR'd back to the row.
 *
 *           Server-only module — imported by the GET
 *           /vendor-submit/[token]/print route handler. Must NOT be marked
 *           'use client'; @react-pdf/renderer's `renderToBuffer` is a
 *           Node-only API. Tailwind classes do not apply inside react-pdf;
 *           styling goes through StyleSheet.create below.
 *
 * Inputs:   VendorTallyPdfProps (see below).
 * Outputs:  renderVendorTallyPdf(props) → Promise<Buffer>
 *           vendorTallyFilenameSlug(vendorName) → string (filename helper)
 *           VendorTallyDocument (React-PDF Document — exported for tests).
 * Agent/API: No LLM. Deterministic render only.
 * Imports:  @react-pdf/renderer, react.
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

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface VendorTallyPdfLine {
  sortOrder: number;
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number;
  unit: string;
  boardFeet: number | null;
}

export interface VendorTallyPdfProps {
  companyName: string;
  vendorName: string;
  /** Full UUID — shown in the header for vendor reference and used by the
   *  filename helper to produce a short prefix. */
  bidId: string;
  customerName: string;
  jobName: string | null;
  jobAddress: string | null;
  /** ISO date. Rendered in en-US short form. */
  dueBy: string | null;
  lineItems: VendorTallyPdfLine[];
  /** HMAC-signed token. Printed on every page footer as plain text so the
   *  Task 5 scan-back OCR can key on it. Not encoded as a QR code on
   *  purpose — OCR-ing a 100-character base64url string is reliable; a QR
   *  adds a library dependency for no material gain on a printed sheet. */
  token: string;
  /** Full submit URL (https://app.lmbr.ai/vendor-submit/<token>). Printed
   *  at the footer so a vendor who started on paper can switch to the
   *  digital form mid-process by typing the URL. */
  submitUrl: string;
  /** ISO timestamp — when the PDF was generated. Shown in footer. */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Filename helper
// ---------------------------------------------------------------------------

/**
 * Slugify a vendor name for the Content-Disposition filename.
 *   "Weyerhaeuser NR Company." → "weyerhaeuser-nr-company"
 *   "A/B Lumber & Supply!"     → "a-b-lumber-supply"
 *
 * Rules: lowercase, non-alphanumerics → '-', collapse runs of '-',
 * trim leading/trailing '-', cap at 30 chars. Empty → "vendor".
 */
export function vendorTallyFilenameSlug(vendorName: string): string {
  const slug = vendorName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'vendor';
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
// Units are PDF points (1pt = 1/72 in). US Letter is 612 x 792pt.
// 0.5" margins → 36pt.
const styles = StyleSheet.create({
  page: {
    paddingTop: 36,
    paddingBottom: 56, // extra bottom padding leaves room for fixed footer
    paddingHorizontal: 36,
    fontFamily: 'Helvetica',
    fontSize: 10,
    color: '#000000',
    backgroundColor: '#FFFFFF',
  },
  // Header ------------------------------------------------------------------
  headerBlock: {
    borderBottomWidth: 1,
    borderBottomColor: '#000000',
    paddingBottom: 8,
    marginBottom: 10,
  },
  eyebrow: {
    fontSize: 8,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: '#444444',
  },
  title: {
    fontSize: 16,
    fontFamily: 'Helvetica-Bold',
    marginTop: 2,
  },
  headerMeta: {
    marginTop: 6,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  headerMetaCell: {
    width: '50%',
    marginTop: 2,
    fontSize: 9,
  },
  headerLabel: {
    fontFamily: 'Helvetica-Bold',
  },
  instructionsBox: {
    marginTop: 8,
    marginBottom: 10,
    padding: 6,
    borderWidth: 0.75,
    borderColor: '#000000',
    fontSize: 9,
  },
  // Table -------------------------------------------------------------------
  // Column widths sum to 100%. Wider space goes to Unit Price + Notes
  // because those are the only write-in cells.
  tableHeaderRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderTopWidth: 1,
    borderColor: '#000000',
    backgroundColor: '#EEEEEE',
    paddingVertical: 4,
  },
  tableHeaderCell: {
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
    textTransform: 'uppercase',
    paddingHorizontal: 3,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderColor: '#888888',
    minHeight: 22,
    alignItems: 'stretch',
  },
  tableCell: {
    fontSize: 10,
    paddingHorizontal: 3,
    paddingVertical: 4,
  },
  writeInCell: {
    // Box the write-in columns so the vendor sees the target area.
    borderLeftWidth: 0.5,
    borderColor: '#000000',
    paddingHorizontal: 3,
    paddingVertical: 4,
    minHeight: 22,
  },
  colItem: { width: '5%' },
  colSpecies: { width: '10%' },
  colDimension: { width: '9%' },
  colGrade: { width: '10%' },
  colLength: { width: '7%' },
  colQty: { width: '8%', textAlign: 'right' },
  colUnit: { width: '6%' },
  colBf: { width: '10%', textAlign: 'right' },
  colUnitPrice: { width: '15%' },
  colNotes: { width: '20%' },
  alignRight: { textAlign: 'right' },
  // Empty state -------------------------------------------------------------
  emptyState: {
    marginTop: 24,
    padding: 12,
    borderWidth: 0.75,
    borderColor: '#000000',
    textAlign: 'center',
    fontSize: 10,
  },
  // Footer ------------------------------------------------------------------
  // Fixed footer repeats on every page (@react-pdf "fixed" prop).
  footer: {
    position: 'absolute',
    left: 36,
    right: 36,
    bottom: 20,
    borderTopWidth: 0.5,
    borderTopColor: '#000000',
    paddingTop: 4,
    fontSize: 8,
    color: '#333333',
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerMono: {
    fontFamily: 'Courier',
    fontSize: 7,
  },
});

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDueBy(dueBy: string | null): string {
  if (!dueBy) return 'Not specified';
  const d = new Date(dueBy);
  if (Number.isNaN(d.getTime())) return 'Not specified';
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatGeneratedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatQty(qty: number): string {
  // Integer quantities are the common case; show up to 2 decimals only if
  // the vendor ever gets MBF-denominated rows with fractions.
  return Number.isInteger(qty)
    ? qty.toLocaleString('en-US')
    : qty.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatBf(bf: number | null): string {
  if (bf == null) return '—';
  return Number.isInteger(bf)
    ? bf.toLocaleString('en-US')
    : bf.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function bidIdShort(id: string): string {
  // UUID short — first group, 8 chars.
  return id.split('-')[0] ?? id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// React-PDF Document
// ---------------------------------------------------------------------------

export function VendorTallyDocument(props: VendorTallyPdfProps): React.ReactElement {
  const {
    companyName,
    vendorName,
    bidId,
    customerName,
    jobName,
    jobAddress,
    dueBy,
    lineItems,
    token,
    submitUrl,
    generatedAt,
  } = props;

  const title = jobName || customerName;

  return (
    <Document
      title={`LMBR.ai Request for Pricing — ${title}`}
      author={companyName}
      creator="LMBR.ai"
      producer="LMBR.ai"
      subject={`Pricing request for ${vendorName}`}
    >
      <Page size="LETTER" style={styles.page} wrap>
        {/* --- Header ------------------------------------------------------ */}
        <View style={styles.headerBlock}>
          <Text style={styles.eyebrow}>LMBR.ai — Request for Pricing</Text>
          <Text style={styles.title}>{title}</Text>

          <View style={styles.headerMeta}>
            <Text style={styles.headerMetaCell}>
              <Text style={styles.headerLabel}>From: </Text>
              {companyName}
            </Text>
            <Text style={styles.headerMetaCell}>
              <Text style={styles.headerLabel}>To (Vendor): </Text>
              {vendorName}
            </Text>
            <Text style={styles.headerMetaCell}>
              <Text style={styles.headerLabel}>Customer: </Text>
              {customerName}
            </Text>
            <Text style={styles.headerMetaCell}>
              <Text style={styles.headerLabel}>Job: </Text>
              {jobName ?? '—'}
            </Text>
            <Text style={styles.headerMetaCell}>
              <Text style={styles.headerLabel}>Job Address: </Text>
              {jobAddress ?? '—'}
            </Text>
            <Text style={styles.headerMetaCell}>
              <Text style={styles.headerLabel}>Due By: </Text>
              {formatDueBy(dueBy)}
            </Text>
            <Text style={styles.headerMetaCell}>
              <Text style={styles.headerLabel}>Bid ID: </Text>
              {bidIdShort(bidId)}
            </Text>
            <Text style={styles.headerMetaCell}>
              <Text style={styles.headerLabel}>Lines: </Text>
              {lineItems.length}
            </Text>
          </View>
        </View>

        {/* --- Instructions ---------------------------------------------- */}
        <View style={styles.instructionsBox}>
          <Text>
            Please write your unit price (in USD) and any notes next to each
            line item below, then return this sheet by scanning/faxing it
            back, or by entering prices online at the URL printed in the
            footer. Leave a line blank if you cannot quote it.
          </Text>
        </View>

        {/* --- Table ------------------------------------------------------ */}
        {lineItems.length === 0 ? (
          <View style={styles.emptyState}>
            <Text>
              No line items are visible to this vendor for this bid. Please
              contact the buyer.
            </Text>
          </View>
        ) : (
          <>
            {/* Header row — repeats on each page via fixed */}
            <View style={styles.tableHeaderRow} fixed>
              <Text style={[styles.tableHeaderCell, styles.colItem]}>#</Text>
              <Text style={[styles.tableHeaderCell, styles.colSpecies]}>Species</Text>
              <Text style={[styles.tableHeaderCell, styles.colDimension]}>Dim</Text>
              <Text style={[styles.tableHeaderCell, styles.colGrade]}>Grade</Text>
              <Text style={[styles.tableHeaderCell, styles.colLength]}>Len</Text>
              <Text style={[styles.tableHeaderCell, styles.colQty]}>Qty</Text>
              <Text style={[styles.tableHeaderCell, styles.colUnit]}>Unit</Text>
              <Text style={[styles.tableHeaderCell, styles.colBf]}>BF</Text>
              <Text style={[styles.tableHeaderCell, styles.colUnitPrice]}>Unit Price ($)</Text>
              <Text style={[styles.tableHeaderCell, styles.colNotes]}>Notes</Text>
            </View>

            {lineItems.map((li, idx) => (
              <View key={`${li.sortOrder}-${idx}`} style={styles.tableRow} wrap={false}>
                <Text style={[styles.tableCell, styles.colItem]}>{idx + 1}</Text>
                <Text style={[styles.tableCell, styles.colSpecies]}>{li.species}</Text>
                <Text style={[styles.tableCell, styles.colDimension]}>{li.dimension}</Text>
                <Text style={[styles.tableCell, styles.colGrade]}>{li.grade ?? '—'}</Text>
                <Text style={[styles.tableCell, styles.colLength]}>{li.length ?? '—'}</Text>
                <Text style={[styles.tableCell, styles.colQty]}>{formatQty(li.quantity)}</Text>
                <Text style={[styles.tableCell, styles.colUnit]}>{li.unit}</Text>
                <Text style={[styles.tableCell, styles.colBf]}>{formatBf(li.boardFeet)}</Text>
                <View style={[styles.writeInCell, styles.colUnitPrice]}>
                  <Text> </Text>
                </View>
                <View style={[styles.writeInCell, styles.colNotes]}>
                  <Text> </Text>
                </View>
              </View>
            ))}
          </>
        )}

        {/* --- Fixed footer (every page) --------------------------------- */}
        <View style={styles.footer} fixed>
          <View style={styles.footerRow}>
            <Text>LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.</Text>
            <Text
              render={({ pageNumber, totalPages }) =>
                `Page ${pageNumber} of ${totalPages}`
              }
            />
          </View>
          <View style={styles.footerRow}>
            <Text>Generated: {formatGeneratedAt(generatedAt)}</Text>
            <Text>Bid: {bidIdShort(bidId)}</Text>
          </View>
          <Text style={styles.footerMono}>Submit online: {submitUrl}</Text>
          <Text style={styles.footerMono}>Token: {token}</Text>
        </View>
      </Page>
    </Document>
  );
}

// ---------------------------------------------------------------------------
// renderToBuffer wrapper
// ---------------------------------------------------------------------------

/**
 * Render the tally to a Node Buffer. Chosen over `renderToStream` because
 * Next.js App Router route handlers return a NextResponse that accepts a
 * Buffer body directly — simpler than piping a Node stream to a Web stream
 * through Readable.toWeb. Buffer memory cost for a bid with a few hundred
 * line items is on the order of 50–200 KB, well within Node defaults.
 */
export default async function renderVendorTallyPdf(
  props: VendorTallyPdfProps,
): Promise<Buffer> {
  return renderToBuffer(<VendorTallyDocument {...props} />);
}
