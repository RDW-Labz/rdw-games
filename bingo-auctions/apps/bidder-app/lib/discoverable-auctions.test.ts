// Tests for the "which auctions may customers discover" rule. The bug this
// guards: Browse listed lots from unlisted staff test auctions (mig 0242), so
// real customers saw and bid on test lots.

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DISCOVERABLE_AUCTION_STATUSES,
  fetchDiscoverableAuctionIds,
  withoutUnlistedAuctionRows,
} from './discoverable-auctions';

type Call = [method: string, ...args: unknown[]];

// Records every builder call and resolves with a canned result when awaited.
function fakeClient(result: { data: Array<{ id: string }> | null; error: unknown }) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {
    then: (resolve: (v: typeof result) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  for (const m of ['select', 'in', 'eq']) {
    builder[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return builder;
    };
  }
  const client = {
    from: (table: string) => {
      calls.push(['from', table]);
      return builder;
    },
  } as unknown as Pick<SupabaseClient, 'from'>;
  return { client, calls };
}

describe('fetchDiscoverableAuctionIds', () => {
  it('asks only for open, listed auctions', async () => {
    const { client, calls } = fakeClient({ data: [{ id: 'a1' }, { id: 'a2' }], error: null });
    const ids = await fetchDiscoverableAuctionIds(client);
    expect(ids).toEqual(['a1', 'a2']);
    expect(calls).toContainEqual(['from', 'auctions']);
    expect(calls).toContainEqual(['in', 'status', ['scheduled', 'live']]);
    expect(calls).toContainEqual(['eq', 'unlisted', false]);
  });

  it('allows an unlisted auction the customer linked to directly, but only that one', async () => {
    const { client, calls } = fakeClient({ data: [{ id: 'test-auction' }], error: null });
    await fetchDiscoverableAuctionIds(client, { auctionId: 'test-auction' });
    expect(calls).toContainEqual(['eq', 'id', 'test-auction']);
    expect(calls).toContainEqual(['in', 'status', ['scheduled', 'live']]);
    expect(calls).not.toContainEqual(['eq', 'unlisted', false]);
  });

  it('filters unlisted when no auction was picked (null)', async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    await fetchDiscoverableAuctionIds(client, { auctionId: null });
    expect(calls).toContainEqual(['eq', 'unlisted', false]);
  });

  it('returns [] when the query fails', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom' } });
    expect(await fetchDiscoverableAuctionIds(client)).toEqual([]);
  });

  it('only treats scheduled and live as open', () => {
    expect([...DISCOVERABLE_AUCTION_STATUSES]).toEqual(['scheduled', 'live']);
  });
});

describe('withoutUnlistedAuctionRows', () => {
  const rows = [
    { id: 'lot-real', auction_id: 'real' },
    { id: 'lot-test', auction_id: 'test' },
    { id: 'lot-none', auction_id: null },
  ];

  it('drops lots of unlisted auctions and keeps the rest', async () => {
    const { client, calls } = fakeClient({ data: [{ id: 'test' }], error: null });
    const out = await withoutUnlistedAuctionRows(client, rows);
    expect(out?.map((r) => r.id)).toEqual(['lot-real', 'lot-none']);
    expect(calls).toContainEqual(['in', 'id', ['real', 'test']]);
    expect(calls).toContainEqual(['eq', 'unlisted', true]);
  });

  it('returns null when the check fails, so callers hide the results', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom' } });
    expect(await withoutUnlistedAuctionRows(client, rows)).toBeNull();
  });

  it('skips the query when no row has an auction', async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    const onlyNone = [{ id: 'lot-none', auction_id: null }];
    expect(await withoutUnlistedAuctionRows(client, onlyNone)).toEqual(onlyNone);
    expect(calls).toEqual([]);
  });
});
