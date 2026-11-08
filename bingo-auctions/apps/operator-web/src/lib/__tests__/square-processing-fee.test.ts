// extractProcessingFeeCents (mig 0287 / square.ts) — Square reports
// processing_fee as an ARRAY that is absent until the payment settles. The
// null-vs-zero distinction is load-bearing: the square-sync backfill retries on
// null and stops retrying once a number is stored, so a wrong 0 would freeze the
// fee at zero forever and overstate the reconciled deposit.

import { describe, it, expect } from 'vitest';
import { extractProcessingFeeCents } from '@/lib/square';

describe('extractProcessingFeeCents', () => {
  it('returns null when Square has not settled the payment yet', () => {
    // Unsettled payments come back with no processing_fee key at all.
    expect(extractProcessingFeeCents({})).toBeNull();
    expect(extractProcessingFeeCents({ processing_fee: null })).toBeNull();
    expect(extractProcessingFeeCents({ processing_fee: [] })).toBeNull();
  });

  it('returns null for null/undefined payments', () => {
    expect(extractProcessingFeeCents(null)).toBeNull();
    expect(extractProcessingFeeCents(undefined)).toBeNull();
  });

  it('sums a single fee entry', () => {
    expect(
      extractProcessingFeeCents({
        processing_fee: [{ amount_money: { amount: 62 } }],
      }),
    ).toBe(62);
  });

  it('sums multiple fee entries (a payment can carry more than one)', () => {
    expect(
      extractProcessingFeeCents({
        processing_fee: [
          { amount_money: { amount: 62 } },
          { amount_money: { amount: 13 } },
        ],
      }),
    ).toBe(75);
  });

  it('preserves a genuine zero fee as 0, not null', () => {
    // A real $0 fee must be stored so the sweep stops retrying it.
    expect(
      extractProcessingFeeCents({ processing_fee: [{ amount_money: { amount: 0 } }] }),
    ).toBe(0);
  });

  it('ignores malformed entries but keeps well-formed ones', () => {
    expect(
      extractProcessingFeeCents({
        processing_fee: [
          { amount_money: null },
          {},
          { amount_money: { amount: 40 } },
        ],
      }),
    ).toBe(40);
  });

  it('returns null when every entry lacks an amount', () => {
    // Entries present but no usable numbers → still "unknown", so retry.
    expect(
      extractProcessingFeeCents({ processing_fee: [{ amount_money: null }, {}] }),
    ).toBeNull();
  });
});
