// "X lots live now" on the homepage counted every live lot, including those of
// unlisted staff test auctions (0242) and the demo operator. It must count only
// lots in active, listed, non-demo auctions — the same gate as Final Call.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { calls, auctions, lotCounts } = vi.hoisted(() => ({
  calls: [] as Array<[string, string, unknown]>,
  auctions: { rows: [] as Array<{ id: string }> },
  lotCounts: { live: 0, soon: 0 },
}));

function builder(table: string) {
  let hasCloseBefore = false;
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'in', 'eq', 'gt', 'not']) {
    b[m] = (...args: unknown[]) => {
      calls.push([table, m, args]);
      return b;
    };
  }
  b.lt = (...args: unknown[]) => {
    calls.push([table, 'lt', args]);
    hasCloseBefore = true;
    return b;
  };
  b.then = (res: (v: unknown) => unknown) =>
    Promise.resolve(
      table === 'auctions'
        ? { data: auctions.rows, error: null }
        : table === 'lots'
          ? { count: hasCloseBefore ? lotCounts.soon : lotCounts.live, error: null }
          : { count: 2, error: null },
    ).then(res);
  return b;
}

vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => ({ from: builder }) }));
vi.mock('@/lib/demo-operators', () => ({
  getDemoOperatorIds: async () => ['op-demo'],
  demoExclusionList: (ids: string[]) => (ids.length ? `(${ids.join(',')})` : null),
}));

import { GET } from '../route';

describe('GET /api/public/stats counts listed auctions only', () => {
  beforeEach(() => {
    calls.length = 0;
    auctions.rows = [{ id: 'a-real' }];
    lotCounts.live = 7;
    lotCounts.soon = 2;
  });

  it('asks for active, listed, non-demo auctions and counts lots only in those', async () => {
    const res = await GET();
    expect(await res.json()).toEqual({ live_lots_count: 7, ending_within_hour_count: 2, operators_count: 2 });

    expect(calls).toContainEqual(['auctions', 'eq', ['unlisted', false]]);
    expect(calls).toContainEqual(['auctions', 'in', ['status', ['scheduled', 'live']]]);
    expect(calls).toContainEqual(['auctions', 'not', ['operator_id', 'in', '(op-demo)']]);
    const lotAuctionFilters = calls.filter(([t, m, a]) => t === 'lots' && m === 'in' && (a as unknown[])[0] === 'auction_id');
    expect(lotAuctionFilters).toHaveLength(2);
    for (const [, , a] of lotAuctionFilters) expect((a as unknown[])[1]).toEqual(['a-real']);
  });

  it('no listed auction → 0 lots, without querying lots', async () => {
    auctions.rows = [];
    const res = await GET();
    expect(await res.json()).toMatchObject({ live_lots_count: 0, ending_within_hour_count: 0 });
    expect(calls.some(([t]) => t === 'lots')).toBe(false);
  });
});
