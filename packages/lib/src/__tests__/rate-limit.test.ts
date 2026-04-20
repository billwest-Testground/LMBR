/**
 * Rate limiter — Prompt 12 regression net.
 *
 * Locks the token-bucket behavior: fresh buckets start at capacity,
 * each allowed call decrements, refused calls return a retry-after,
 * and refill rate restores tokens over time. These properties are
 * load-bearing for /api/vendor-submit and /api/extract.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { allow, __resetRateLimiter } from '../rate-limit';

afterEach(() => {
  __resetRateLimiter();
  vi.useRealTimers();
});

describe('allow — token bucket', () => {
  it('permits up to `capacity` calls in quick succession', () => {
    const config = { capacity: 3, refillPerMs: 0.00001 };
    const key = 'test-key';
    expect(allow(key, config).ok).toBe(true);
    expect(allow(key, config).ok).toBe(true);
    expect(allow(key, config).ok).toBe(true);
    expect(allow(key, config).ok).toBe(false);
  });

  it('returns retryAfterMs when the bucket is empty', () => {
    const config = { capacity: 1, refillPerMs: 1 / 1000 }; // 1 per second
    const key = 'retry';
    expect(allow(key, config).ok).toBe(true);
    const refused = allow(key, config);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills tokens over time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00.000Z'));
    const config = { capacity: 2, refillPerMs: 2 / 1000 }; // 2 per second
    const key = 'refill';
    expect(allow(key, config).ok).toBe(true);
    expect(allow(key, config).ok).toBe(true);
    expect(allow(key, config).ok).toBe(false);
    vi.advanceTimersByTime(600); // 600ms * 0.002 = 1.2 tokens back
    expect(allow(key, config).ok).toBe(true);
  });

  it('isolates buckets by key', () => {
    const config = { capacity: 1, refillPerMs: 0.00001 };
    expect(allow('a', config).ok).toBe(true);
    expect(allow('b', config).ok).toBe(true);
    expect(allow('a', config).ok).toBe(false);
    expect(allow('b', config).ok).toBe(false);
  });

  it('caps refill at `capacity` — never grants more than the bucket size', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00.000Z'));
    const config = { capacity: 2, refillPerMs: 1 }; // very fast refill
    const key = 'cap';
    allow(key, config);
    vi.advanceTimersByTime(1_000_000); // millions of tokens worth of time
    expect(allow(key, config).ok).toBe(true);
    expect(allow(key, config).ok).toBe(true);
    // Third call within the same instant should fail — capacity is 2.
    expect(allow(key, config).ok).toBe(false);
  });
});
