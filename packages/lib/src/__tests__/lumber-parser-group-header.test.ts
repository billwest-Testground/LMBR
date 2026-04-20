/**
 * Group header regex — Prompt 12 abbreviated-form additions.
 *
 * Locks the "H1 / B2 / L3" trader shorthand as valid group headers
 * alongside the existing "House 1 / Building A / Phase 2" full-word
 * forms. Trader-typed takeoffs use the shorthand freely and without
 * this regression net a future simplification could drop it silently.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { describe, expect, it } from 'vitest';

import type { AttachmentAnalysisResult } from '../attachment-analyzer';
import { parseLumberList } from '../lumber-parser';

function textAnalysis(text: string): AttachmentAnalysisResult {
  return {
    method: 'direct_text',
    extractedText: text,
    confidence: 1.0,
    costCents: 0,
    metadata: {
      filename: 'takeoff.txt',
      mimeType: 'text/plain',
      sizeBytes: Buffer.byteLength(text, 'utf-8'),
    },
  };
}

function parse(lines: readonly string[]) {
  return parseLumberList(textAnalysis(lines.join('\n')));
}

describe('group header regex — abbreviated forms', () => {
  it('treats "H1" as a building header', () => {
    const result = parse([
      'H1',
      '2x4 SPF #2 8ft qty 100',
      'H2',
      '2x6 SPF #2 10ft qty 50',
    ]);
    const tags = result.buildingGroups.map((g) => g.buildingTag.toUpperCase());
    expect(tags).toContain('H1');
    expect(tags).toContain('H2');
  });

  it('treats "B3" and "L4" as building headers', () => {
    const result = parse([
      'B3',
      '2x4 SPF #2 8ft qty 10',
      'L4',
      '2x6 SPF #2 10ft qty 20',
    ]);
    const tags = result.buildingGroups.map((g) => g.buildingTag.toUpperCase());
    expect(tags).toContain('B3');
    expect(tags).toContain('L4');
  });

  it('still matches full-word forms', () => {
    const result = parse([
      'House 1',
      '2x4 SPF #2 8ft qty 10',
      'Building A',
      '2x6 SPF #2 10ft qty 20',
      'Phase 2',
      '2x8 SPF #2 12ft qty 5',
    ]);
    const tags = result.buildingGroups.map((g) => g.buildingTag.toLowerCase());
    expect(tags.some((t) => t.startsWith('house'))).toBe(true);
    expect(tags.some((t) => t.startsWith('building'))).toBe(true);
    expect(tags.some((t) => t.startsWith('phase'))).toBe(true);
  });

  it('does NOT accept "P1" as a phase shorthand (collides with pine-grade-1)', () => {
    const result = parse([
      'P1',
      '2x4 SPF #2 8ft qty 10',
    ]);
    const tags = result.buildingGroups.map((g) => g.buildingTag.toUpperCase());
    expect(tags).not.toContain('P1');
  });
});
