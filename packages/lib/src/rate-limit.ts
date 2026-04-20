/**
 * In-memory token-bucket rate limiter.
 *
 * Purpose:  Light, dependency-free rate limiter for the two public-facing
 *           endpoints — /api/vendor-submit and /api/extract. In-memory
 *           state is per-process; a multi-instance deployment (Vercel,
 *           horizontal replicas) gets independent limits per instance,
 *           so the effective rate is N × limit with N instances. That's
 *           acceptable for V1: the public endpoints are used by a small
 *           number of known vendors hitting them a handful of times per
 *           bid, not by the open internet. The limit is a coarse
 *           guardrail against accidental retry loops, not a DDoS defense.
 *
 *           Move to Redis + @upstash/ratelimit or a Cloudflare WAF rule
 *           if per-instance isolation becomes a real concern.
 *
 * Algorithm: standard token bucket. Each key holds `capacity` tokens and
 *           refills at `refillPerMs` tokens per millisecond. Each
 *           successful check subtracts 1. When tokens < 1, reject.
 *
 * Inputs:   key (per-IP or per-token), capacity, refillPerMs.
 * Outputs:  { ok: true } or { ok: false, retryAfterMs }.
 * Imports:  none.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const BUCKETS = new Map<string, Bucket>();

// Housekeeping — drop idle buckets so the Map doesn't grow without bound
// for a long-running process. Runs opportunistically on every check.
const IDLE_CUTOFF_MS = 10 * 60 * 1000; // 10 minutes

export interface RateLimitConfig {
  /** Bucket size — max tokens available after a cold start. */
  capacity: number;
  /** Refill rate — tokens replenished per millisecond. */
  refillPerMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** When ok=false, how long (ms) until the next token is available. */
  retryAfterMs: number;
  /** Tokens remaining after this check. Useful for response headers. */
  remaining: number;
}

/**
 * Check and consume a token from the bucket keyed by `key`. Allocates
 * a fresh full bucket on first sight of a key. Returns `{ ok: true }`
 * with remaining count when allowed, `{ ok: false, retryAfterMs }`
 * otherwise.
 */
export function allow(
  key: string,
  config: RateLimitConfig,
): RateLimitResult {
  const now = Date.now();

  // Opportunistic cleanup — on every ~16th call after the map has
  // grown beyond a small threshold, scan a handful of buckets and
  // drop those idle past the cutoff. Keeps the Map from growing
  // unbounded in a long-running process.
  if (BUCKETS.size > 64 && (now & 15) === 0) {
    let scanned = 0;
    for (const [k, b] of BUCKETS) {
      if (scanned > 32) break;
      scanned += 1;
      if (now - b.lastRefillMs > IDLE_CUTOFF_MS) BUCKETS.delete(k);
    }
  }

  const existing = BUCKETS.get(key);
  if (!existing) {
    BUCKETS.set(key, { tokens: config.capacity - 1, lastRefillMs: now });
    return { ok: true, retryAfterMs: 0, remaining: config.capacity - 1 };
  }

  const elapsed = Math.max(0, now - existing.lastRefillMs);
  const tokens = Math.min(
    config.capacity,
    existing.tokens + elapsed * config.refillPerMs,
  );

  if (tokens < 1) {
    const retryAfterMs = Math.ceil((1 - tokens) / config.refillPerMs);
    existing.tokens = tokens;
    existing.lastRefillMs = now;
    return { ok: false, retryAfterMs, remaining: 0 };
  }

  existing.tokens = tokens - 1;
  existing.lastRefillMs = now;
  return { ok: true, retryAfterMs: 0, remaining: Math.floor(existing.tokens) };
}

/**
 * Extract the best-effort client IP from a Next request for use as the
 * rate-limit bucket key. Prefers the first entry in X-Forwarded-For
 * (set by Vercel / Cloudflare / most proxies), falling back to
 * X-Real-IP, then to a string of 'unknown' so traffic with no forward
 * header still shares a single limited bucket (a safe default —
 * denying all anon traffic is stricter than letting it through).
 */
export function clientIpFromHeaders(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

// Test hook — reset the shared state between tests.
export function __resetRateLimiter(): void {
  BUCKETS.clear();
}
