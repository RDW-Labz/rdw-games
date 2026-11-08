// Jared 2026-10-15: items refunded as missing (PNK4821346, TEA4841809) were
// selectable in the builder, and carryover died part-way on mig 0345's
// relist_blocked_item_missing, leaving staff unsure what was added.
//   - unfound-missing lots are skipped before any relist is attempted;
//   - a per-lot failure no longer stops the batch;
//   - the result lists what carried over and what did not, and why;
//   - an error about the target auction stops the rest as "Not tried".

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  unfound: new Map<string, string>(),
  relist: {} as Record<
    string,
    | { ok: true; newLotId: string; newLotCode: string }
    | { ok: false; error: string; alreadyCarried?: boolean; alreadyCarriedTo?: string | null }
  >,
  relistCalls: [] as string[],
}));

const codes: Record<string, string> = {
  '00000000-0000-0000-0000-00000000000a': 'PNK4821346',
  '00000000-0000-0000-0000-00000000000b': 'GOOD000001',
  '00000000-0000-0000-0000-00000000000c': 'GOOD000002',
  '00000000-0000-0000-0000-00000000000d': 'TEA4841809',
};
const [A, B, C, D] = Object.keys(codes) as [string, string, string, string];
const AUCTION = '00000000-0000-0000-0000-0000000000aa';

function fakeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-admin' } } }) },
    rpc: async () => ({ data: null, error: null }),
    from(table: string) {
      const b: Record<string, unknown> = {};
      let ids: string[] = [];
      b.select = () => b;
      b.eq = () => b;
      b.in = (_c: string, v: string[]) => {
        ids = v;
        return b;
      };
      b.single = async () => ({ data: { operator_id: 'op-1', role: 'admin' } });
      b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(
          table === 'lots'
            ? { data: ids.map((id) => ({ id, lot_code: 'BIN-x', display_code: codes[id] ?? null })) }
            : { data: [] },
        ).then(res, rej);
      return b;
    },
  };
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({ getSupabaseServer: async () => fakeClient() }));
vi.mock('@/lib/operator-can', () => ({ operatorCan: async () => true }));
vi.mock('@/lib/missing-items', () => ({ loadUnfoundMissing: async () => state.unfound }));
vi.mock('@/lib/relist', () => ({
  relistLotInto: vi.fn(async (_s: unknown, lotId: string) => {
    state.relistCalls.push(lotId);
    return state.relist[lotId] ?? { ok: true, newLotId: `new-${lotId}`, newLotCode: `BIN-NEW-${codes[lotId]}` };
  }),
}));

import { addInventoryToAuction } from '../actions';

beforeEach(() => {
  state.unfound = new Map();
  state.relist = {};
  state.relistCalls = [];
});

describe('carryover with missing items', () => {
  it('skips unfound-missing lots without calling relist, and carries the rest', async () => {
    state.unfound = new Map([
      [A, '2026-10-09T19:51:54Z'],
      [D, '2026-10-09T20:55:43Z'],
    ]);
    const r = await addInventoryToAuction({ auction_id: AUCTION, lot_ids: [A, B, C, D], source: 'unsold' });

    expect(state.relistCalls).toEqual([B, C]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('Carried over 2 of 4. 2 not added — see the list below.');
    expect(r.carryover?.carried.map((c) => c.code)).toEqual(['GOOD000001', 'GOOD000002']);
    expect(r.carryover?.failed).toEqual([
      {
        lotId: A,
        code: 'PNK4821346',
        reason: 'Refunded as missing on 2026-10-09 and not found since. Find it and put it away, then it can be listed again.',
      },
      {
        lotId: D,
        code: 'TEA4841809',
        reason: 'Refunded as missing on 2026-10-09 and not found since. Find it and put it away, then it can be listed again.',
      },
    ]);
  });

  it('keeps going after a per-lot failure (e.g. the 0345 trigger on a stale page)', async () => {
    state.relist[B] = {
      ok: false,
      error: 'relist_blocked_item_missing: GOOD000001 was refunded as missing on 2026-10-01 and has not been found since. Locate it and put it away, then it can be listed again.',
    };
    const r = await addInventoryToAuction({ auction_id: AUCTION, lot_ids: [B, C], source: 'unsold' });

    expect(state.relistCalls).toEqual([B, C]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.carryover?.carried.map((c) => c.code)).toEqual(['GOOD000002']);
    expect(r.carryover?.failed[0]?.reason).toMatch(/^GOOD000001 was refunded as missing/);
  });

  it('stops on a target-auction error and marks the rest Not tried', async () => {
    state.relist[B] = { ok: false, error: 'Target auction must be draft or scheduled.' };
    const r = await addInventoryToAuction({ auction_id: AUCTION, lot_ids: [B, C], source: 'unsold' });

    expect(state.relistCalls).toEqual([B]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/^Nothing was carried over/);
    expect(r.carryover?.failed.map((f) => f.reason)).toEqual([
      'Target auction must be draft or scheduled.',
      'Not tried: Target auction must be draft or scheduled.',
    ]);
  });

  it('2026-10-23 retry after a lost answer: already-carried lots are listed apart, not as failures', async () => {
    const already = {
      ok: false as const,
      error: 'Already carried over — it now lives on lot BIN-037218. Refresh the list; this item should no longer appear.',
      alreadyCarried: true,
      alreadyCarriedTo: 'BIN-037218',
    };
    state.relist[B] = already;
    const r = await addInventoryToAuction({ auction_id: AUCTION, lot_ids: [B, C], source: 'unpicked_up' });

    expect(state.relistCalls).toEqual([B, C]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.added).toBe(1);
    expect(r.carryover?.failed).toEqual([]);
    expect(r.carryover?.already).toEqual([{ lotId: B, code: 'GOOD000001', newCode: 'BIN-037218' }]);
  });

  it('every lot already carried over: says nothing new, with the list', async () => {
    const already = { ok: false as const, error: 'Already carried over.', alreadyCarried: true, alreadyCarriedTo: null };
    state.relist[B] = already;
    state.relist[C] = already;
    const r = await addInventoryToAuction({ auction_id: AUCTION, lot_ids: [B, C], source: 'unpicked_up' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('Nothing new to add: 2 were already carried over earlier — see the list below.');
    expect(r.carryover?.already.map((a) => a.code)).toEqual(['GOOD000001', 'GOOD000002']);
    expect(r.carryover?.failed).toEqual([]);
  });

  it('returns ok with the full report when everything carries over', async () => {
    const r = await addInventoryToAuction({ auction_id: AUCTION, lot_ids: [B, C], source: 'unpicked_up' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.added).toBe(2);
    expect(r.carryover?.failed).toEqual([]);
  });
});

describe('carryover stop reason (chunked builder)', () => {
  it('reports the target-auction stop so the builder stops sending chunks', async () => {
    state.relist[B] = { ok: false, error: 'Auction not found.' };
    const r = await addInventoryToAuction({ auction_id: AUCTION, lot_ids: [B, C], source: 'unsold' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.carryover?.stopped).toBe('Auction not found.');
  });

  it('no stop reason on a normal run', async () => {
    const r = await addInventoryToAuction({ auction_id: AUCTION, lot_ids: [B], source: 'unsold' });
    expect(r.carryover?.stopped ?? null).toBeNull();
  });
});
