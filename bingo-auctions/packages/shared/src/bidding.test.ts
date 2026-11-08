// bidding.test.ts — SQL ↔ client parity for the bid-increment ladder + the
// configurable schedule added in mig 0194 (BID-3).
//
// THIS IS THE DANGER ZONE. minBidIncrementCents / nextMinimumBidCents in
// bidding.ts MUST return the exact same numbers as the SQL function
// public.min_bid_increment_cents(current_cents, schedule) in
// packages/db/migrations/0194_configurable_bid_increments.sql.
//
// The SQL counterpart of these cases lives in
//   packages/db/test/min_bid_increment_cents.sql
// and asserts the SAME expected numbers (LEGACY_CASES + SCHEDULE_CASES below),
// so the two can be cross-checked by eye and by CI.

import { describe, it, expect } from 'vitest';
import {
  minBidIncrementCents,
  nextMinimumBidCents,
  type BidIncrementTier,
} from './bidding';

// ── Shared expected-value tables (mirror packages/db/test/min_bid_increment_cents.sql) ──

// (a) NULL schedule → legacy ladder. [current_cents, expected_step]
//     null/<500→100, <2500→100, <10000→200, <25000→500, <100000→1000,
//     <500000→2500, else→5000.
const LEGACY_CASES: Array<[number | null, number]> = [
  [null, 100],
  [100, 100],
  [600, 100],
  [3000, 200],
  [12000, 500],
  [30000, 1000],
  [150000, 2500],
  [600000, 5000],
];

// (b) Sample tiered schedule. Ascending; first tier min_cents=0.
const SAMPLE_SCHEDULE: BidIncrementTier[] = [
  { min_cents: 0, step_cents: 50 },
  { min_cents: 1000, step_cents: 100 },
  { min_cents: 2000, step_cents: 500 },
  { min_cents: 10000, step_cents: 1000 },
];

// [current_cents, expected_step] under SAMPLE_SCHEDULE — greatest min_cents <= current wins.
const SCHEDULE_CASES: Array<[number, number]> = [
  [0, 50],
  [999, 50],
  [1000, 100],
  [1999, 100],
  [2000, 500],
  [9999, 500],
  [10000, 1000],
  [50000, 1000],
];

describe('minBidIncrementCents — (a) NULL/undefined schedule → legacy ladder', () => {
  for (const [current, expected] of LEGACY_CASES) {
    it(`current=${current} → ${expected} (no schedule arg)`, () => {
      expect(minBidIncrementCents(current)).toBe(expected);
    });
    it(`current=${current} → ${expected} (explicit null schedule)`, () => {
      expect(minBidIncrementCents(current, null)).toBe(expected);
    });
  }
});

describe('minBidIncrementCents — (b) sample tiered schedule', () => {
  for (const [current, expected] of SCHEDULE_CASES) {
    it(`current=${current} → ${expected}`, () => {
      expect(minBidIncrementCents(current, SAMPLE_SCHEDULE)).toBe(expected);
    });
  }
});

describe('minBidIncrementCents — (c) empty / malformed schedule → legacy ladder', () => {
  for (const [current, expected] of LEGACY_CASES) {
    it(`empty array, current=${current} → legacy ${expected}`, () => {
      expect(minBidIncrementCents(current, [])).toBe(expected);
    });
  }

  it('schedule whose lowest tier floor is above current → legacy ladder', () => {
    // current=600 is below the only tier's min_cents=1000 → no tier matches →
    // fall back to legacy ladder (600 < 2500 → 100).
    const aboveOnly: BidIncrementTier[] = [{ min_cents: 1000, step_cents: 999 }];
    expect(minBidIncrementCents(600, aboveOnly)).toBe(100);
  });
});

describe('nextMinimumBidCents — current + increment (with + without schedule)', () => {
  it('null current → starting bid (legacy)', () => {
    expect(nextMinimumBidCents(null, 250)).toBe(250);
  });

  it('null current → starting bid (schedule does not change the first-bid floor)', () => {
    expect(nextMinimumBidCents(null, 250, SAMPLE_SCHEDULE)).toBe(250);
  });

  it('legacy ladder: current=12000 → 12000 + 500 = 12500', () => {
    expect(nextMinimumBidCents(12000, 100)).toBe(12500);
  });

  it('sample schedule: current=2000 → 2000 + 500 = 2500', () => {
    expect(nextMinimumBidCents(2000, 100, SAMPLE_SCHEDULE)).toBe(2500);
  });

  it('sample schedule: current=10000 → 10000 + 1000 = 11000', () => {
    expect(nextMinimumBidCents(10000, 100, SAMPLE_SCHEDULE)).toBe(11000);
  });
});
