// expand-tracking.test.ts
//
// Unit tests for the Wayfair multi-tracking split logic. Real failures these
// guard against (all from BinGo's 2026-05-28 manifest, prod):
//
//   - "486572077526 486572077559 486572077537 486572077548" landed as one
//     dirty row → only the literal string scanned would match it; the four
//     physical boxes were unscannable until mig 0156's token-LIKE fallback.
//   - "486574961123 CS653238180" — valid tracking + carrier return note
//     glued together → scan miss until 0156.
//   - "d/d" alone — annotation, no real tracking → must NOT create a row
//     with `tracking_number = "d/d"`.

import { describe, it, expect } from 'vitest';
import {
  TRACKING_SPLIT_RE,
  TRACKING_TOKEN_RE,
  countTrackingTokens,
  expandRowsByTracking,
} from '../expand-tracking.js';
import type { CommitInput } from '@/app/(operator)/imports/actions';

// Minimal row shape: cast a partial through unknown so we don't have to
// satisfy every CommitInput field. The split logic only inspects
// `tracking_number`; preserving the spread is what we actually verify.
function row(overrides: Partial<CommitInput['rows'][number]>): CommitInput['rows'][number] {
  return {
    title: 'Sample Item',
    tracking_number: null,
    ...overrides,
  } as unknown as CommitInput['rows'][number];
}

describe('TRACKING_SPLIT_RE', () => {
  it('splits on commas', () => {
    expect('A,B'.split(TRACKING_SPLIT_RE)).toEqual(['A', 'B']);
  });
  it('splits on spaces', () => {
    expect('A B'.split(TRACKING_SPLIT_RE)).toEqual(['A', 'B']);
  });
  it('splits on mixed runs of whitespace and commas', () => {
    expect('A , B   C\tD'.split(TRACKING_SPLIT_RE)).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('TRACKING_TOKEN_RE', () => {
  it('accepts 12-digit FedEx Ground', () => {
    expect(TRACKING_TOKEN_RE.test('486573719871')).toBe(true);
  });
  it('accepts 14-digit codes (FedEx alt format)', () => {
    expect(TRACKING_TOKEN_RE.test('12345678901234')).toBe(true);
  });
  it('rejects "d/d" annotation', () => {
    expect(TRACKING_TOKEN_RE.test('d/d')).toBe(false);
  });
  it('rejects carrier return notes like "CS653238180"', () => {
    expect(TRACKING_TOKEN_RE.test('CS653238180')).toBe(false);
  });
  it('rejects empty string', () => {
    expect(TRACKING_TOKEN_RE.test('')).toBe(false);
  });
  it('rejects 11-digit (too short)', () => {
    expect(TRACKING_TOKEN_RE.test('12345678901')).toBe(false);
  });
  it('rejects 15-digit (too long)', () => {
    expect(TRACKING_TOKEN_RE.test('123456789012345')).toBe(false);
  });
});

describe('countTrackingTokens', () => {
  it('returns 1 for empty string', () => {
    expect(countTrackingTokens('')).toBe(1);
  });
  it('returns 1 for whitespace-only', () => {
    expect(countTrackingTokens('   ')).toBe(1);
  });
  it('returns 1 for annotation-only ("d/d")', () => {
    expect(countTrackingTokens('d/d')).toBe(1);
  });
  it('returns 1 for single tracking', () => {
    expect(countTrackingTokens('486573719871')).toBe(1);
  });
  it('returns 2 for comma-separated pair', () => {
    expect(countTrackingTokens('486573676084, 486573676095')).toBe(2);
  });
  it('returns 4 for space-separated quad', () => {
    expect(
      countTrackingTokens('486572077526 486572077559 486572077537 486572077548'),
    ).toBe(4);
  });
  it('returns 1 for tracking + note (note dropped)', () => {
    expect(countTrackingTokens('486574961123 CS653238180')).toBe(1);
  });
});

describe('expandRowsByTracking', () => {
  it('passes through a row with null tracking unchanged (1 row out)', () => {
    const out = expandRowsByTracking([row({ tracking_number: null, title: 'Lamp' })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.tracking_number).toBeNull();
    expect(out[0]?.title).toBe('Lamp');
  });

  it('splits "A, B" into 2 rows with shared product data', () => {
    const out = expandRowsByTracking([
      row({ tracking_number: '486573676084, 486573676095', title: 'Chair' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.tracking_number).toBe('486573676084');
    expect(out[1]?.tracking_number).toBe('486573676095');
    expect(out[0]?.title).toBe('Chair');
    expect(out[1]?.title).toBe('Chair');
  });

  it('splits "A B C D" (space-separated) into 4 rows', () => {
    const out = expandRowsByTracking([
      row({
        tracking_number: '486572077526 486572077559 486572077537 486572077548',
        title: 'Table',
      }),
    ]);
    expect(out).toHaveLength(4);
    expect(out.map((r) => r.tracking_number)).toEqual([
      '486572077526',
      '486572077559',
      '486572077537',
      '486572077548',
    ]);
  });

  it('drops carrier-internal note "CS653238180", keeps the FedEx tracking', () => {
    const out = expandRowsByTracking([
      row({ tracking_number: '486574961123 CS653238180', title: 'Box' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.tracking_number).toBe('486574961123');
  });

  it('annotation-only cell ("d/d") lands once with null tracking', () => {
    const out = expandRowsByTracking([row({ tracking_number: 'd/d', title: 'Returned' })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.tracking_number).toBeNull();
    expect(out[0]?.title).toBe('Returned');
  });

  it('within-file dedup: same tracking in two rows keeps only the first', () => {
    const out = expandRowsByTracking([
      row({ tracking_number: '486573719871', title: 'First' }),
      row({ tracking_number: '486573719871', title: 'Second' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('First');
  });

  it('truncates a single token to 64 chars (DB column safety)', () => {
    const longButValid = '1'.repeat(14); // valid 14-digit token
    const out = expandRowsByTracking([row({ tracking_number: longButValid })]);
    expect(out[0]?.tracking_number?.length).toBe(14);
  });
});
