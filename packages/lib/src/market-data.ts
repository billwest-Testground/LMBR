/**
 * Market-data client — CME lumber futures via Twelve Data.
 *
 * Purpose:  Thin typed wrapper around Twelve Data's quote endpoint for
 *           CME lumber futures. Futures are a sentiment signal — the
 *           Cash Index (public.market_price_snapshots, written by the
 *           aggregation job) is the thing quotes actually price against.
 *           Two-call surface:
 *
 *             fetchLumberFutures()   — one HTTP round trip, returns the
 *                                      parsed quote shape or a structured
 *                                      error. No DB.
 *             refreshLumberFutures() — calls fetchLumberFutures and
 *                                      upserts into public.market_futures
 *                                      on (symbol, contract_month).
 *                                      Cron target at
 *                                      /api/market/futures/refresh calls
 *                                      this every ~15 minutes.
 *
 *           Provider choice: Barchart commercial starts at $500/month;
 *           Twelve Data's free tier (8 req/min, 800/day) comfortably
 *           covers a 15-min refresh (96 req/day). Upgrade path is a
 *           flat $29/month at 55 req/min if we later move to 1-min
 *           refreshes or add more commodities. The client library is
 *           generic enough to swap providers behind the same call
 *           signature if the math ever changes.
 *
 *           Symbol: `LBS1!` — the CME Random Length Lumber continuous
 *           front-month contract on Twelve Data. Continuous front-month
 *           means the underlying contract rolls as each expires, so we
 *           persist with a synthetic `contract_month = 'FRONT'` rather
 *           than a specific month. A future version can fetch specific
 *           expirations (LBSK26, LBSN26...) and write rows per-contract
 *           if the dashboard wants the full curve.
 *
 *           Error policy: the client NEVER throws on upstream failure.
 *           A provider down / rate-limited / key-invalid / symbol-
 *           misspelled case returns { ok: false, error } so the cron
 *           job can record the failure and carry on. Upstream outages
 *           on a sentiment signal must not cascade into operational
 *           alerts — the dashboard shows stale data with a timestamp
 *           until the next successful fetch.
 *
 * Inputs:   TWELVEDATA_API_KEY (env).
 * Outputs:  fetchLumberFutures, refreshLumberFutures,
 *           LUMBER_FUTURES_SYMBOL, LumberFuturesQuote.
 * Agent/API: Twelve Data GET /quote, Supabase service-role.
 * Imports:  ./supabase (getSupabaseAdmin).
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { getSupabaseAdmin } from './supabase';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CME random-length lumber continuous front-month contract symbol. */
export const LUMBER_FUTURES_SYMBOL = 'LBS1!';

/** Synthetic contract-month label for the continuous front-month row. */
export const LUMBER_FUTURES_CONTRACT_LABEL = 'FRONT';

const TWELVEDATA_BASE_URL = 'https://api.twelvedata.com';

/** Hard cap on the upstream fetch — Twelve Data should answer in 1-2s. */
const FETCH_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parsed + normalized front-month quote. Nullable fields mirror the
 * partial-row tolerance of public.market_futures — Twelve Data sometimes
 * omits volume or change_pct on thinly traded sessions.
 */
export interface LumberFuturesQuote {
  symbol: string;
  contractMonth: string;
  lastPrice: number;
  priceChange: number | null;
  priceChangePct: number | null;
  volume: number | null;
  openInterest: number | null;
  fetchedAt: string;
  /** Raw JSON body kept so the DB row has a debug breadcrumb. */
  raw: unknown;
}

export type FetchLumberFuturesResult =
  | { ok: true; quote: LumberFuturesQuote }
  | { ok: false; error: string; status?: number };

export type RefreshLumberFuturesResult =
  | { ok: true; upserted: true; quote: LumberFuturesQuote }
  | { ok: false; error: string; status?: number };

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

function getApiKey(): string | null {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key || key.length === 0) return null;
  return key;
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

/**
 * Twelve Data returns every numeric field as a string ("542.50"). Parse
 * tolerantly: empty / missing / non-finite values become null so we
 * don't land NaN into the DB.
 */
function parseNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseInteger(raw: unknown): number | null {
  const n = parseNumber(raw);
  if (n === null) return null;
  return Math.trunc(n);
}

// ---------------------------------------------------------------------------
// fetchLumberFutures
// ---------------------------------------------------------------------------

/**
 * Fetch the current front-month lumber futures quote from Twelve Data.
 * Returns a discriminated result — success carries the parsed quote,
 * failure carries a human-readable reason + optional HTTP status.
 * Never throws for upstream conditions (timeout, parse failure, rate
 * limit, bad key, unknown symbol).
 */
export async function fetchLumberFutures(): Promise<FetchLumberFuturesResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      error:
        'TWELVEDATA_API_KEY is not set — add it to apps/web/.env.local. Futures refresh is paused until the key is present.',
    };
  }

  const url = new URL(`${TWELVEDATA_BASE_URL}/quote`);
  url.searchParams.set('symbol', LUMBER_FUTURES_SYMBOL);
  url.searchParams.set('apikey', apiKey);

  // AbortController lets us bound the request regardless of the server's
  // socket timeout. Twelve Data's quote endpoint is usually <1s; 8s
  // is generous enough to cover DNS + TLS + transient latency spikes.
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? `Timed out after ${FETCH_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: `Twelve Data fetch failed: ${message}` };
  } finally {
    clearTimeout(timeoutHandle);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Twelve Data returned non-JSON body: ${message}`,
      status: response.status,
    };
  }

  // Twelve Data's error envelope is a flat object with status === 'error'.
  // The HTTP status itself can still be 200, so we inspect the body first
  // and fall back to the HTTP status only if the body looks OK.
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    if (obj.status === 'error') {
      const providerMessage =
        typeof obj.message === 'string' ? obj.message : 'Unknown provider error';
      const providerCode = typeof obj.code === 'number' ? obj.code : response.status;
      return {
        ok: false,
        error: `Twelve Data rejected the request: ${providerMessage}`,
        status: providerCode,
      };
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `Twelve Data returned HTTP ${response.status}`,
      status: response.status,
    };
  }

  // Happy path: map the quote JSON into our normalized shape.
  const obj = body as Record<string, unknown>;
  const close = parseNumber(obj.close);
  const lastPrice = close ?? parseNumber(obj.price);
  if (lastPrice === null) {
    return {
      ok: false,
      error: 'Twelve Data response missing a usable price field',
    };
  }

  const priceChange = parseNumber(obj.change);
  const priceChangePct = parseNumber(obj.percent_change);
  const volume = parseInteger(obj.volume);
  // Twelve Data's `/quote` does not expose open_interest for futures on
  // the current tier; the DB column stays null unless we upgrade to a
  // /time_series or /statistics call with OI. Not blocking for the
  // dashboard's sentiment use case.
  const openInterest: number | null = null;

  const quote: LumberFuturesQuote = {
    symbol: LUMBER_FUTURES_SYMBOL,
    contractMonth: LUMBER_FUTURES_CONTRACT_LABEL,
    lastPrice,
    priceChange,
    priceChangePct,
    volume,
    openInterest,
    fetchedAt: new Date().toISOString(),
    raw: body,
  };

  return { ok: true, quote };
}

// ---------------------------------------------------------------------------
// refreshLumberFutures
// ---------------------------------------------------------------------------

/**
 * Fetch + upsert on (symbol, contract_month). The cache model is
 * "latest snapshot only" — upgrading to historical futures means
 * dropping the unique index on (symbol, contract_month) and inserting
 * per-refresh instead.
 */
export async function refreshLumberFutures(): Promise<RefreshLumberFuturesResult> {
  const fetched = await fetchLumberFutures();
  if (!fetched.ok) {
    return fetched;
  }
  const quote = fetched.quote;

  const admin = getSupabaseAdmin();
  const { error } = await admin.from('market_futures').upsert(
    {
      symbol: quote.symbol,
      contract_month: quote.contractMonth,
      last_price: quote.lastPrice,
      price_change: quote.priceChange,
      price_change_pct: quote.priceChangePct,
      open_interest: quote.openInterest,
      volume: quote.volume,
      fetched_at: quote.fetchedAt,
      raw: quote.raw,
    },
    { onConflict: 'symbol,contract_month' },
  );

  if (error) {
    return {
      ok: false,
      error: `market_futures upsert failed: ${error.message}`,
    };
  }

  return { ok: true, upserted: true, quote };
}
