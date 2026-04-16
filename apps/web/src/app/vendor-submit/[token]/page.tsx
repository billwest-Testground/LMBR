/**
 * /vendor-submit/[token] — public server-rendered vendor submission page.
 *
 * Purpose:  The entry URL a vendor opens from the buyer's dispatch email.
 *           No login. No session cookie. The HMAC-signed token in the URL
 *           is the only thing proving the caller is the intended vendor.
 *
 *           Flow:
 *             1. Decode + verify the token (signature + expiry).
 *             2. Fetch vendor_bids row via service-role client (no session
 *                to run RLS against — token IS the auth).
 *             3. Assert the decoded payload matches the row's
 *                id/bid_id/vendor_id/company_id exactly; mismatch is
 *                collapsed to the same "link invalid" UI as signature fail
 *                so the page cannot be used to probe which tokens are
 *                issued for which bids (no info leak).
 *             4. Load the bid, vendor, and company so the form header can
 *                render trust cues (company name, vendor name, job,
 *                due date).
 *             5. Pick the line items the vendor should price — consolidated
 *                or originals, per `vendorVisibleIsConsolidatedFlag`.
 *             6. Pre-fill any existing vendor_bid_line_items so a vendor
 *                returning to their link after saving sees their prior
 *                entries, not a blank form.
 *             7. If the row is already finalized (`submitted` status),
 *                render a read-only thank-you summary.
 *           Everything else renders the interactive SubmitForm client
 *           component with the token carried as a prop so the POST back
 *           to /api/vendor-submit can re-authenticate server-side.
 *
 * Inputs:   params.token (URL segment, the HMAC-signed string).
 * Outputs:  JSX: form, thank-you, or "link invalid" view.
 * Agent/API: getSupabaseAdmin (service role), verifyVendorBidToken,
 *            assertTokenMatchesVendorBid, vendorVisibleIsConsolidatedFlag.
 * Imports:  @lmbr/lib, @lmbr/types, ./submit-form.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import {
  assertTokenMatchesVendorBid,
  getSupabaseAdmin,
  toNumber,
  vendorVisibleIsConsolidatedFlag,
  VendorTokenMismatchError,
  verifyVendorBidToken,
} from '@lmbr/lib';
import type { ConsolidationMode } from '@lmbr/types';

import { SubmitForm, type SubmitFormLineItem, type SubmitFormExistingPrice } from './submit-form';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface PageProps {
  params: { token: string };
}

interface BidRow {
  id: string;
  company_id: string;
  customer_name: string;
  job_name: string | null;
  job_address: string | null;
  due_date: string | null;
  consolidation_mode: ConsolidationMode;
}

interface VendorRow {
  id: string;
  name: string;
  min_order_mbf: number | string | null;
}

interface CompanyRow {
  id: string;
  name: string;
}

interface VendorBidRow {
  id: string;
  bid_id: string;
  vendor_id: string;
  company_id: string;
  status: 'pending' | 'submitted' | 'partial' | 'declined' | 'expired';
  due_by: string | null;
  token_expires_at: string | null;
  submitted_at: string | null;
  submission_method: 'form' | 'scan' | 'email';
}

interface LineItemRow {
  id: string;
  species: string;
  dimension: string;
  grade: string | null;
  length: string | null;
  quantity: number | string;
  unit: string;
  board_feet: number | string | null;
  notes: string | null;
  sort_order: number;
  building_tag: string | null;
  phase_number: number | null;
}

interface ExistingPriceRow {
  line_item_id: string;
  unit_price: number | string | null;
  notes: string | null;
}

export default async function VendorSubmitPage({ params }: PageProps) {
  const payload = verifyVendorBidToken(params.token);
  if (!payload) {
    console.warn('LMBR.ai vendor-submit: token failed signature/format/expiry check.');
    return <InvalidLinkView />;
  }

  const admin = getSupabaseAdmin();

  // ----- vendor_bids row ---------------------------------------------------
  const { data: vbData, error: vbError } = await admin
    .from('vendor_bids')
    .select(
      'id, bid_id, vendor_id, company_id, status, due_by, token_expires_at, submitted_at, submission_method',
    )
    .eq('id', payload.vendorBidId)
    .maybeSingle();
  if (vbError) {
    console.warn(`LMBR.ai vendor-submit: vendor_bids lookup failed: ${vbError.message}`);
    return <InvalidLinkView />;
  }
  const vendorBid = vbData as VendorBidRow | null;
  if (!vendorBid) {
    console.warn(`LMBR.ai vendor-submit: no vendor_bids row for id=${payload.vendorBidId}.`);
    return <InvalidLinkView />;
  }

  try {
    assertTokenMatchesVendorBid(payload, {
      id: vendorBid.id,
      bid_id: vendorBid.bid_id,
      vendor_id: vendorBid.vendor_id,
      company_id: vendorBid.company_id,
    });
  } catch (err) {
    if (err instanceof VendorTokenMismatchError) {
      console.warn(`LMBR.ai vendor-submit: ${err.message}`);
      return <InvalidLinkView />;
    }
    throw err;
  }

  if (vendorBid.status === 'expired') {
    return <InvalidLinkView reason="This submission link has expired. Contact the buyer to request a new one." />;
  }

  // ----- Bid + vendor + company in parallel --------------------------------
  const [{ data: bidRowRaw }, { data: vendorRowRaw }, { data: companyRowRaw }] = await Promise.all([
    admin
      .from('bids')
      .select('id, company_id, customer_name, job_name, job_address, due_date, consolidation_mode')
      .eq('id', vendorBid.bid_id)
      .maybeSingle(),
    admin
      .from('vendors')
      .select('id, name, min_order_mbf')
      .eq('id', vendorBid.vendor_id)
      .maybeSingle(),
    admin
      .from('companies')
      .select('id, name')
      .eq('id', vendorBid.company_id)
      .maybeSingle(),
  ]);

  const bid = bidRowRaw as BidRow | null;
  const vendor = vendorRowRaw as VendorRow | null;
  const company = companyRowRaw as CompanyRow | null;

  if (!bid || !vendor || !company) {
    console.warn(
      `LMBR.ai vendor-submit: missing related row (bid=${!!bid} vendor=${!!vendor} company=${!!company}).`,
    );
    return <InvalidLinkView />;
  }

  // ----- Vendor-visible line items ----------------------------------------
  const isConsolidated = vendorVisibleIsConsolidatedFlag(bid.consolidation_mode);
  const { data: linesRaw, error: linesError } = await admin
    .from('line_items')
    .select(
      'id, species, dimension, grade, length, quantity, unit, board_feet, notes, sort_order, building_tag, phase_number',
    )
    .eq('bid_id', bid.id)
    .eq('company_id', bid.company_id)
    .eq('is_consolidated', isConsolidated)
    .order('sort_order', { ascending: true });
  if (linesError) {
    console.warn(`LMBR.ai vendor-submit: line_items lookup failed: ${linesError.message}`);
    return <InvalidLinkView />;
  }
  const lineRows = (linesRaw ?? []) as LineItemRow[];

  // ----- Existing vendor_bid_line_items for pre-fill -----------------------
  const { data: existingRaw } = await admin
    .from('vendor_bid_line_items')
    .select('line_item_id, unit_price, notes')
    .eq('vendor_bid_id', vendorBid.id);
  const existingRows = (existingRaw ?? []) as ExistingPriceRow[];

  const existingPrices: Record<string, SubmitFormExistingPrice> = {};
  for (const r of existingRows) {
    existingPrices[r.line_item_id] = {
      unitPrice: r.unit_price == null ? null : toNumber(r.unit_price),
      notes: r.notes ?? '',
    };
  }

  const lineItems: SubmitFormLineItem[] = lineRows.map((r) => ({
    id: r.id,
    species: r.species,
    dimension: r.dimension,
    grade: r.grade,
    length: r.length,
    quantity: toNumber(r.quantity),
    unit: r.unit,
    boardFeet: r.board_feet == null ? null : toNumber(r.board_feet),
    buildingTag: r.building_tag,
    phaseNumber: r.phase_number,
  }));

  const bidSummary = {
    jobName: bid.job_name,
    customerName: bid.customer_name,
    jobAddress: bid.job_address,
    dueDate: bid.due_date,
    consolidationMode: bid.consolidation_mode,
    lineCount: lineItems.length,
  };

  // ----- Read-only view for already-submitted rows -------------------------
  if (vendorBid.status === 'submitted') {
    return (
      <SubmittedView
        companyName={company.name}
        vendorName={vendor.name}
        bidSummary={bidSummary}
        lineItems={lineItems}
        existingPrices={existingPrices}
        submittedAt={vendorBid.submitted_at}
      />
    );
  }

  if (vendorBid.status === 'declined') {
    return (
      <DeclinedView
        companyName={company.name}
        vendorName={vendor.name}
        bidSummary={bidSummary}
      />
    );
  }

  return (
    <SubmitForm
      token={params.token}
      companyName={company.name}
      vendorName={vendor.name}
      bidSummary={bidSummary}
      dueBy={vendorBid.due_by}
      lineItems={lineItems}
      existingPrices={existingPrices}
    />
  );
}

// ---------------------------------------------------------------------------
// Invalid / expired link view
// ---------------------------------------------------------------------------
function InvalidLinkView({
  reason = 'This submission link is invalid or has expired. Please contact the buyer for a new one.',
}: { reason?: string } = {}) {
  return (
    <div className="mx-auto mt-12 max-w-md rounded-lg border border-border-base bg-bg-surface p-8 text-center shadow-md">
      <h1 className="text-h2 text-text-primary">Link invalid or expired</h1>
      <p className="mt-3 text-body text-text-secondary">{reason}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Read-only submitted view
// ---------------------------------------------------------------------------
interface BidSummary {
  jobName: string | null;
  customerName: string;
  jobAddress: string | null;
  dueDate: string | null;
  consolidationMode: ConsolidationMode;
  lineCount: number;
}

function SubmittedView({
  companyName,
  vendorName,
  bidSummary,
  lineItems,
  existingPrices,
  submittedAt,
}: {
  companyName: string;
  vendorName: string;
  bidSummary: BidSummary;
  lineItems: SubmitFormLineItem[];
  existingPrices: Record<string, SubmitFormExistingPrice>;
  submittedAt: string | null;
}) {
  return (
    <div>
      <Header
        companyName={companyName}
        vendorName={vendorName}
        bidSummary={bidSummary}
        mode="submitted"
        submittedAt={submittedAt}
      />

      <div
        role="status"
        className="mb-6 rounded-md border border-[rgba(29,184,122,0.4)] bg-[rgba(29,184,122,0.08)] px-4 py-3 text-body-sm text-semantic-success"
      >
        Thank you — your pricing has been received. If you need to update a
        price, contact the buyer directly.
      </div>

      <div className="overflow-hidden rounded-lg border border-border-base bg-bg-surface shadow-sm">
        <table className="min-w-full divide-y divide-border-base">
          <thead className="bg-bg-subtle">
            <tr>
              <ColHeader>Line</ColHeader>
              <ColHeader>Species</ColHeader>
              <ColHeader>Dimension</ColHeader>
              <ColHeader>Grade</ColHeader>
              <ColHeader>Length</ColHeader>
              <ColHeader align="right">Qty</ColHeader>
              <ColHeader align="right">Unit Price</ColHeader>
              <ColHeader>Notes</ColHeader>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-base">
            {lineItems.map((li, idx) => {
              const existing = existingPrices[li.id];
              return (
                <tr key={li.id}>
                  <Cell>{idx + 1}</Cell>
                  <Cell>{li.species}</Cell>
                  <Cell>{li.dimension}</Cell>
                  <Cell>{li.grade ?? '—'}</Cell>
                  <Cell>{li.length ?? '—'}</Cell>
                  <Cell align="right">
                    {li.quantity.toLocaleString()} {li.unit}
                  </Cell>
                  <Cell align="right">
                    {existing && existing.unitPrice != null
                      ? `$${existing.unitPrice.toFixed(4)}`
                      : '—'}
                  </Cell>
                  <Cell>{existing?.notes ?? '—'}</Cell>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DeclinedView({
  companyName,
  vendorName,
  bidSummary,
}: {
  companyName: string;
  vendorName: string;
  bidSummary: BidSummary;
}) {
  return (
    <div>
      <Header
        companyName={companyName}
        vendorName={vendorName}
        bidSummary={bidSummary}
        mode="declined"
        submittedAt={null}
      />
      <div
        role="status"
        className="mb-6 rounded-md border border-border-base bg-bg-surface px-4 py-3 text-body-sm text-text-secondary"
      >
        You declined to bid on this job. If that was a mistake, contact the
        buyer directly.
      </div>
    </div>
  );
}

function Header({
  companyName,
  vendorName,
  bidSummary,
  mode,
  submittedAt,
}: {
  companyName: string;
  vendorName: string;
  bidSummary: BidSummary;
  mode: 'submitted' | 'declined';
  submittedAt: string | null;
}) {
  const title = bidSummary.jobName || bidSummary.customerName;
  return (
    <header className="mb-6">
      <div className="text-label uppercase text-text-tertiary">
        Pricing request from {companyName}
      </div>
      <h1 className="mt-1 text-h2 text-text-primary">{title}</h1>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm text-text-secondary">
        <span>Vendor: {vendorName}</span>
        <span>
          · Customer: <span className="text-text-primary">{bidSummary.customerName}</span>
        </span>
        {bidSummary.jobAddress && <span>· {bidSummary.jobAddress}</span>}
        {mode === 'submitted' && submittedAt && (
          <span>· Submitted {new Date(submittedAt).toLocaleString('en-US')}</span>
        )}
      </div>
    </header>
  );
}

function ColHeader({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 text-label uppercase text-text-tertiary ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

function Cell({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <td
      className={`px-3 py-2 text-body-sm text-text-secondary ${
        align === 'right' ? 'text-right font-mono tabular-nums' : ''
      }`}
    >
      {children}
    </td>
  );
}
