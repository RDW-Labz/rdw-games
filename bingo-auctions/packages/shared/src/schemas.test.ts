import { describe, expect, it } from 'vitest';
import { lotInputSchema } from './schemas';

const base = {
  auctionId: '369e6b1a-dfdb-44db-8351-22346af967ae',
  warehouseId: 'ce9646af-55b5-412b-bff1-b86a5cdd8b54',
  title: 'Staff keep test',
  condition: 'good' as const,
  startingBidCents: 100,
  photoUrls: [],
};

describe('lotInputSchema.closeAt', () => {
  // The New lot form sends auction.ends_at exactly as PostgREST returns it.
  it('accepts a timestamptz with a +00:00 offset (what the database returns)', () => {
    expect(lotInputSchema.safeParse({ ...base, closeAt: '2026-10-07T18:51:00+00:00' }).success).toBe(true);
    expect(lotInputSchema.safeParse({ ...base, closeAt: '2026-10-07T18:51:00.123456+00:00' }).success).toBe(true);
  });

  it('still accepts Z and still rejects garbage', () => {
    expect(lotInputSchema.safeParse({ ...base, closeAt: '2026-10-07T18:51:00Z' }).success).toBe(true);
    expect(lotInputSchema.safeParse({ ...base, closeAt: 'next tuesday' }).success).toBe(false);
    expect(lotInputSchema.safeParse({ ...base, closeAt: '2026-10-07 18:51:00' }).success).toBe(false);
  });

  it('earlyAccessUntil takes an offset too', () => {
    expect(
      lotInputSchema.safeParse({ ...base, closeAt: '2026-10-07T18:51:00Z', earlyAccessUntil: '2026-10-01T18:50:00+00:00' }).success,
    ).toBe(true);
  });
});
