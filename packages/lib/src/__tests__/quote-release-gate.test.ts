/**
 * Unit tests for canReleaseQuote (Prompt 07 Task 1).
 *
 * Purpose:  Prove that each persisted quote_status value maps to the
 *           correct release eligibility + HTTP-friendly error code.
 *           Locks the rejection contract consumed by /api/quote so a
 *           refactor of the route handler can't silently relax it.
 * Agent/API: none — pure TS.
 * Imports:  vitest, ../quote-release-gate.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { describe, expect, it } from 'vitest';

import { canReleaseQuote, type QuoteStatus } from '../quote-release-gate';

describe('canReleaseQuote — allowed statuses', () => {
  it('pending_approval is releasable', () => {
    const r = canReleaseQuote('pending_approval');
    expect(r.ok).toBe(true);
  });

  it('approved is releasable (idempotent re-render)', () => {
    const r = canReleaseQuote('approved');
    expect(r.ok).toBe(true);
  });
});

describe('canReleaseQuote — rejected statuses', () => {
  it('draft rejects with cannot_release_draft', () => {
    const r = canReleaseQuote('draft');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('cannot_release_draft');
    expect(r.message).toMatch(/draft/i);
  });

  it('sent rejects with already_sent', () => {
    const r = canReleaseQuote('sent');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('already_sent');
  });

  it('accepted rejects with quote_finalized', () => {
    const r = canReleaseQuote('accepted');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('quote_finalized');
    expect(r.message).toMatch(/accepted/);
  });

  it('declined rejects with quote_finalized', () => {
    const r = canReleaseQuote('declined');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toBe('quote_finalized');
    expect(r.message).toMatch(/declined/);
  });
});

describe('canReleaseQuote — exhaustive status coverage', () => {
  it('every enum value yields a defined result', () => {
    const statuses: QuoteStatus[] = [
      'draft',
      'pending_approval',
      'approved',
      'sent',
      'accepted',
      'declined',
    ];
    for (const s of statuses) {
      const r = canReleaseQuote(s);
      expect(r).toBeDefined();
      expect(typeof r.ok).toBe('boolean');
    }
  });
});
