// Found looks the bin up by code (RLS-scoped), limited to the lot's own
// warehouse and to active, unretired bins, and hands its QR token to the
// missing_item_found RPC. Codes repeat across warehouses by design (every
// location is laid out 1-01-01, 3-09-01, ...), so an ambiguous code returns a
// pick list instead of an error. RPC refusals come back as staff text.

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Bin = { id: string; code: string; qr_token: string; warehouse_id: string; is_active: boolean; retired_at: string | null };

const HARRISON = 'wh-harrison';
const DODGE = 'wh-dodge';
const LOT = '00000000-0000-0000-0000-000000000001';
const BIN_DODGE_ID = '00000000-0000-0000-0000-0000000000d1';

const state = vi.hoisted(() => ({
  lotWarehouse: null as string | null,
  bins: [] as Bin[],
  ilike: [] as string[],
  binFilters: [] as Array<Record<string, unknown>>,
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: { data: { ok: true }, error: null } as { data: unknown; error: unknown },
}));

function fakeClient() {
  return {
    from(table: string) {
      if (table === 'lots') {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = () => b;
        b.maybeSingle = async () => ({ data: { warehouse_id: state.lotWarehouse } });
        return b;
      }
      if (table === 'warehouses') {
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.in = async () => ({ data: [{ id: HARRISON, name: 'Harrison' }, { id: DODGE, name: 'Dodge City' }] });
        return b;
      }
      // bins: apply the filters the action asks for, like PostgREST would.
      const f: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.is = (c: string, v: unknown) => ((f[`is:${c}`] = v), b);
      b.eq = (c: string, v: unknown) => ((f[`eq:${c}`] = v), b);
      b.ilike = (_c: string, v: string) => {
        state.ilike.push(v);
        f.ilike = v;
        return b;
      };
      b.limit = async () => {
        state.binFilters.push({ ...f });
        const code = typeof f.ilike === 'string' ? (f.ilike as string).replace(/\\(.)/g, '$1').toLowerCase() : null;
        const data = state.bins.filter(
          (x) =>
            (code === null || x.code.toLowerCase() === code) &&
            (f['is:retired_at'] === undefined || x.retired_at === null) &&
            (f['eq:is_active'] === undefined || x.is_active === f['eq:is_active']) &&
            (f['eq:warehouse_id'] === undefined || x.warehouse_id === f['eq:warehouse_id']) &&
            (f['eq:id'] === undefined || x.id === f['eq:id']),
        );
        return { data };
      };
      return b;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpc.push({ fn, args });
      return state.rpcResult;
    },
  };
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({ getSupabaseServer: async () => fakeClient() }));

import { confirmMissing, markFound, markUnsellable } from '../actions';

// The prod shape behind the bug: 3-09-01 exists in Harrison (115 lots) and Dodge City (empty).
const prodLike: Bin[] = [
  { id: 'h1', code: '3-09-01', qr_token: 'tok-harrison', warehouse_id: HARRISON, is_active: true, retired_at: null },
  { id: BIN_DODGE_ID, code: '3-09-01', qr_token: 'tok-dodge', warehouse_id: DODGE, is_active: true, retired_at: null },
  { id: 'h-old', code: '2-01-01', qr_token: 'tok-retired', warehouse_id: HARRISON, is_active: true, retired_at: '2026-06-01' },
  { id: 'h-off', code: '2-02-01', qr_token: 'tok-inactive', warehouse_id: HARRISON, is_active: false, retired_at: null },
];

beforeEach(() => {
  state.lotWarehouse = HARRISON;
  state.bins = prodLike;
  state.ilike = [];
  state.binFilters = [];
  state.rpc = [];
  state.rpcResult = { data: { ok: true }, error: null };
});

describe('markFound', () => {
  it('BIN-030583 case: 3-09-01 in Harrison and Dodge City; a Harrison lot puts away on the Harrison bin', async () => {
    const r = await markFound({ lotId: LOT, binCode: '3-09-01' });
    expect(r).toEqual({ ok: true });
    expect(state.binFilters[0]).toMatchObject({ 'eq:warehouse_id': HARRISON, 'eq:is_active': true, 'is:retired_at': null });
    expect(state.rpc).toEqual([
      { fn: 'missing_item_found', args: { p_lot_id: LOT, p_bin_qr_token: 'tok-harrison', p_note: null } },
    ]);
  });

  it('escapes LIKE wildcards and trims the typed code', async () => {
    state.bins = [{ id: 'x', code: 'A-01_02', qr_token: 'tok-1', warehouse_id: HARRISON, is_active: true, retired_at: null }];
    expect(await markFound({ lotId: LOT, binCode: ' A-01_02 ' })).toEqual({ ok: true });
    expect(state.ilike).toEqual(['A-01\\_02']);
  });

  it('ignores retired and inactive bins', async () => {
    expect(await markFound({ lotId: LOT, binCode: '2-01-01' })).toEqual({
      ok: false,
      error: "No active bin with code 2-01-01 in this lot's warehouse.",
    });
    expect((await markFound({ lotId: LOT, binCode: '2-02-01' })).ok).toBe(false);
    expect(state.rpc).toEqual([]);
  });

  it('a code that exists only in another warehouse is not used', async () => {
    state.bins = [prodLike[1]!];
    expect((await markFound({ lotId: LOT, binCode: '3-09-01' })).ok).toBe(false);
    expect(state.rpc).toEqual([]);
  });

  it('still ambiguous (lot has no warehouse): returns a pick list, no RPC', async () => {
    state.lotWarehouse = null;
    const r = await markFound({ lotId: LOT, binCode: '3-09-01' });
    expect(r).toEqual({
      ok: false,
      error: 'More than one bin has code 3-09-01. Pick the one it is going on.',
      choices: [
        { id: 'h1', code: '3-09-01', warehouse: 'Harrison' },
        { id: BIN_DODGE_ID, code: '3-09-01', warehouse: 'Dodge City' },
      ],
    });
    expect(state.rpc).toEqual([]);
  });

  it('a picked bin (binId) is used directly', async () => {
    state.lotWarehouse = null;
    expect(await markFound({ lotId: LOT, binCode: '3-09-01', binId: BIN_DODGE_ID })).toEqual({ ok: true });
    expect(state.binFilters[0]).toMatchObject({ 'eq:id': BIN_DODGE_ID });
    expect(state.rpc[0]?.args.p_bin_qr_token).toBe('tok-dodge');
  });

  it('a picked bin from another warehouse is refused for a lot that has one', async () => {
    expect((await markFound({ lotId: LOT, binCode: '3-09-01', binId: BIN_DODGE_ID })).ok).toBe(false);
    expect(state.rpc).toEqual([]);
  });

  it('requires a bin code', async () => {
    expect(await markFound({ lotId: LOT, binCode: '  ' })).toEqual({ ok: false, error: 'Enter the bin code' });
  });
});

describe('confirmMissing / markUnsellable', () => {
  it('shows the RPC refusal as staff text', async () => {
    state.rpcResult = { data: { ok: false, reason: 'already_found' }, error: null };
    expect(await confirmMissing({ lotId: LOT })).toEqual({
      ok: false,
      error: 'Already found — it was put away after it was marked missing.',
    });
  });

  it('BIN-011585 case (mig 0445): a written-off relist is named in the refusal', async () => {
    state.lotWarehouse = HARRISON;
    state.rpcResult = {
      data: { ok: false, reason: 'relist_removed_as_other', relist_lot_code: 'BIN-014913' },
      error: null,
    };
    expect(await markFound({ lotId: LOT, binCode: '3-09-01' })).toEqual({
      ok: false,
      error: 'This item was relisted as BIN-014913, and that lot was removed from inventory (other). Re-lot the box instead.',
    });
  });

  it('passes the disposal kind only when recording the disposal', async () => {
    await markUnsellable({ lotId: LOT, note: 'Crushed' });
    await markUnsellable({ lotId: LOT, disposalKind: 'donated' });
    expect(state.rpc.map((c) => c.args.p_disposal_kind)).toEqual([null, 'donated']);
  });
});
