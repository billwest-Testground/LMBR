/**
 * Timezone catalog tests — tight regression net around the picker list.
 *
 * The companies.timezone column (migration 022) accepts any string, but
 * the /settings/company picker constrains to COMPANY_TIMEZONES. These
 * tests lock that catalog and the isKnownTimezone predicate: a silent
 * removal of 'America/Los_Angeles' would break every freshly-provisioned
 * tenant's default (migration 022 sets it as the default) — the test
 * makes that regression impossible to miss.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { describe, expect, it } from 'vitest';

import { COMPANY_TIMEZONES, isKnownTimezone } from '../timezones';

describe('COMPANY_TIMEZONES catalog', () => {
  it('is non-empty and contains the migration-022 default', () => {
    expect(COMPANY_TIMEZONES.length).toBeGreaterThan(0);
    expect(
      COMPANY_TIMEZONES.some((t) => t.id === 'America/Los_Angeles'),
    ).toBe(true);
  });

  it('covers every US timezone a wholesale lumber distributor is likely to operate in', () => {
    const ids = new Set(COMPANY_TIMEZONES.map((t) => t.id));
    for (const required of [
      'America/Los_Angeles',
      'America/Denver',
      'America/Phoenix',
      'America/Chicago',
      'America/New_York',
      'America/Anchorage',
      'Pacific/Honolulu',
    ]) {
      expect(ids.has(required), `missing timezone ${required}`).toBe(true);
    }
  });

  it('has no duplicate ids — picker UI assumes stable keys', () => {
    const ids = COMPANY_TIMEZONES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('validates every id as a real IANA zone that Intl.DateTimeFormat accepts', () => {
    for (const tz of COMPANY_TIMEZONES) {
      expect(() =>
        new Intl.DateTimeFormat('en-US', { timeZone: tz.id }).format(new Date()),
      ).not.toThrow();
    }
  });
});

describe('isKnownTimezone predicate', () => {
  it('accepts every catalog id', () => {
    for (const tz of COMPANY_TIMEZONES) {
      expect(isKnownTimezone(tz.id)).toBe(true);
    }
  });

  it('rejects non-catalog zones even when IANA-valid', () => {
    // Europe/London is a real IANA zone but intentionally outside the
    // curated list. The API route's zod refiner leans on this check to
    // hold the picker's boundary.
    expect(isKnownTimezone('Europe/London')).toBe(false);
  });

  it('rejects garbage input', () => {
    expect(isKnownTimezone('')).toBe(false);
    expect(isKnownTimezone('Not/A/Zone')).toBe(false);
    expect(isKnownTimezone('america/los_angeles')).toBe(false); // case-sensitive
  });
});
