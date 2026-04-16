/**
 * Vendor-bid submission tokens — stateless HMAC-signed auth primitive.
 *
 * Purpose:  Each vendor_bid dispatched by the buyer gets a unique
 *           submission URL shared with the vendor by email / printed PDF /
 *           scan-back. Those URLs are public (no login), so the token is
 *           the only thing proving the caller is the intended vendor for
 *           the intended bid. Used in three places downstream:
 *             1. Fillable form page (Task 3) — decodes for layout + posts
 *                the token back on submit so the API can re-authenticate.
 *             2. Printable PDF tally (Task 4) — token is rendered as text
 *                + QR code so a vendor can scan-and-email the marked-up
 *                sheet back.
 *             3. Scan-back OCR attribution (Task 5) — the OCRed token on
 *                the returned sheet tells us which vendor_bid the prices
 *                belong to.
 *
 *           Design note — why stateless HMAC instead of an opaque DB
 *           lookup: the form page needs to render quickly for a vendor
 *           who's not logged in, so we want to decode without a DB round
 *           trip for layout data. But the submission API *must* re-fetch
 *           the vendor_bids row and call assertTokenMatchesVendorBid()
 *           to defeat the "token for Bid A used on Bid B" attack — the
 *           signature alone doesn't cover intent, only integrity.
 *
 *           Token format is `<b64url(payload)>.<b64url(sig)>` — small,
 *           URL-safe, and dependency-free (no JWT lib). Node's built-in
 *           crypto is all we need.
 *
 * Inputs:   process.env.VENDOR_TOKEN_SECRET — HMAC key; lazy-read at call
 *           time so importing this module without the env var set is fine.
 * Outputs:  createVendorBidToken, verifyVendorBidToken,
 *           assertTokenMatchesVendorBid, VendorTokenMismatchError,
 *           VendorBidTokenPayload.
 * Agent/API: used by the vendor dispatch route (Task 2), vendor submission
 *            route (Task 3), PDF tally generator (Task 4), and scan-back
 *            OCR attribution (Task 5).
 * Imports:  node:crypto (built-in, no new deps).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Decoded token payload. `expiresAt` is epoch milliseconds. */
export interface VendorBidTokenPayload {
  vendorBidId: string;
  bidId: string;
  vendorId: string;
  companyId: string;
  expiresAt: number;
}

/**
 * Thrown by `assertTokenMatchesVendorBid` when a cryptographically valid
 * token is presented for the wrong vendor_bid row (different id, bid_id,
 * vendor_id, or company_id). This is the "Bid A token used for Bid B"
 * case — the signature is fine, but the intent doesn't match the DB.
 */
export class VendorTokenMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VendorTokenMismatchError';
  }
}

/**
 * Minimal shape the submission API passes in after re-fetching the
 * vendor_bids row. Keeps this module free of DB/Supabase coupling.
 */
export interface VendorBidRowForAssertion {
  id: string;
  bid_id: string;
  vendor_id: string;
  company_id: string;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function getSecret(): string {
  const secret = process.env.VENDOR_TOKEN_SECRET;
  if (!secret || secret.length === 0) {
    throw new Error(
      'LMBR.ai: missing VENDOR_TOKEN_SECRET environment variable. ' +
        'Set it in apps/web/.env.local — required for vendor-bid token issuance.',
    );
  }
  return secret;
}

function b64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function signPayload(payloadB64: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payloadB64).digest();
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Create a signed token for a vendor_bid dispatch. `ttlMs` is the lifetime
 * relative to now; the expiry is embedded in the payload so verification
 * doesn't need a clock source outside the token itself.
 *
 * Callers that need the token's expiry to exactly match a value they
 * already wrote to the database (to avoid sub-millisecond drift between
 * `Date.now()` at this call site and `Date.now()` in the caller) may
 * pass `expiresAtMs` explicitly — when provided, it is used as-is and
 * `ttlMs` is still validated for consistency but not re-applied.
 *
 * Throws if `VENDOR_TOKEN_SECRET` is missing or if any identifier is empty
 * — those are programmer errors, not validation failures.
 */
export function createVendorBidToken(
  payload: Omit<VendorBidTokenPayload, 'expiresAt'>,
  ttlMs: number,
  expiresAtMs?: number,
): string {
  if (!payload.vendorBidId || !payload.bidId || !payload.vendorId || !payload.companyId) {
    throw new Error(
      'LMBR.ai: createVendorBidToken requires non-empty vendorBidId, bidId, vendorId, companyId.',
    );
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('LMBR.ai: createVendorBidToken requires a positive finite ttlMs.');
  }

  let expiresAt: number;
  if (expiresAtMs !== undefined) {
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error(
        'LMBR.ai: createVendorBidToken requires expiresAtMs to be a finite epoch-ms value in the future.',
      );
    }
    expiresAt = expiresAtMs;
  } else {
    expiresAt = Date.now() + ttlMs;
  }

  const secret = getSecret();
  const full: VendorBidTokenPayload = {
    vendorBidId: payload.vendorBidId,
    bidId: payload.bidId,
    vendorId: payload.vendorId,
    companyId: payload.companyId,
    expiresAt,
  };

  const payloadB64 = b64urlEncode(JSON.stringify(full));
  const sigB64 = b64urlEncode(signPayload(payloadB64, secret));
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a token's signature + expiry and return the decoded payload.
 * Returns null on any failure — bad format, bad signature, expired token,
 * missing secret, malformed JSON. Never throws for validation failures;
 * callers get a boolean outcome by checking the return value.
 *
 * Uses `timingSafeEqual` on the signature comparison.
 */
export function verifyVendorBidToken(token: string): VendorBidTokenPayload | null {
  if (typeof token !== 'string' || token.length === 0) return null;

  let secret: string;
  try {
    secret = getSecret();
  } catch {
    // Missing secret is a validation path here — surface as null, not throw.
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  let presented: Buffer;
  try {
    presented = b64urlDecode(sigB64);
  } catch {
    return null;
  }

  const expected = signPayload(payloadB64, secret);
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }

  if (!decoded || typeof decoded !== 'object') return null;
  const obj = decoded as Record<string, unknown>;
  const { vendorBidId, bidId, vendorId, companyId, expiresAt } = obj;

  if (
    typeof vendorBidId !== 'string' ||
    typeof bidId !== 'string' ||
    typeof vendorId !== 'string' ||
    typeof companyId !== 'string' ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt)
  ) {
    return null;
  }

  if (Date.now() >= expiresAt) return null;

  return { vendorBidId, bidId, vendorId, companyId, expiresAt };
}

/**
 * Cross-check a decoded payload against the re-fetched vendor_bids row.
 * Defeats token forgery (caught earlier by the signature) AND the
 * "valid token for Bid A presented against Bid B" case — the signature
 * would be fine, but the identifiers wouldn't line up with the row the
 * submission API actually loaded.
 *
 * Throws `VendorTokenMismatchError` on any disagreement.
 */
export function assertTokenMatchesVendorBid(
  payload: VendorBidTokenPayload,
  row: VendorBidRowForAssertion,
): void {
  if (payload.vendorBidId !== row.id) {
    throw new VendorTokenMismatchError(
      `vendor_bid id mismatch: token=${payload.vendorBidId} row=${row.id}`,
    );
  }
  if (payload.bidId !== row.bid_id) {
    throw new VendorTokenMismatchError(
      `bid_id mismatch: token=${payload.bidId} row=${row.bid_id}`,
    );
  }
  if (payload.vendorId !== row.vendor_id) {
    throw new VendorTokenMismatchError(
      `vendor_id mismatch: token=${payload.vendorId} row=${row.vendor_id}`,
    );
  }
  if (payload.companyId !== row.company_id) {
    throw new VendorTokenMismatchError(
      `company_id mismatch: token=${payload.companyId} row=${row.company_id}`,
    );
  }
}
