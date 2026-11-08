// Console "Delete lot" and Drafts "Delete" refuse lots with a physical
// footprint (2026-10-06: BIN-028904, in_inventory with a sticker and a shelf,
// was hard-deleted with no trace). Two layers, both covered here:
//   - deleteLot checks the row's own sticker / shelf / intake before deleting;
//   - the 0400 trigger's refusal (child-table evidence) is mapped to the same
//     staff copy instead of the raw Postgres error.
// Also: an RLS-filtered delete (0 rows) is reported, not claimed as success,
// and the Drafts delete tells the trigger who asked (x-bingo-actor).

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Result = { data?: unknown; error?: unknown; count?: number };
type Script = {
  lot: Record<string, unknown> | null;
  bids?: number;
  deleteResult?: Result;
};

const state = vi.hoisted(() => ({
  script: null as unknown as Script,
  deletes: 0,
  headers: [] as Array<[string, string]>,
}));

// A minimal chainable stand-in for the supabase-js query builder.
function fakeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-admin' } } }) },
    from(table: string) {
      let op: 'select' | 'count' | 'delete' = 'select';
      const b: Record<string, unknown> = {};
      b.select = (_cols?: string, o?: { head?: boolean }) => {
        if (op !== 'delete') op = o?.head ? 'count' : 'select';
        return b;
      };
      b.eq = () => b;
      b.setHeader = (k: string, v: string) => {
        state.headers.push([k, v]);
        return b;
      };
      b.delete = () => {
        op = 'delete';
        state.deletes++;
        return b;
      };
      b.single = async () =>
        table === 'operator_users'
          ? { data: { operator_id: 'op-1', role: 'admin' } }
          : { data: state.script.lot };
      b.then = (res: (v: Result) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(
          op === 'count'
            ? { count: state.script.bids ?? 0 }
            : op === 'delete'
              ? (state.script.deleteResult ?? { data: [{ id: 'lot-1' }], error: null })
              : { data: null },
        ).then(res, rej);
      return b;
    },
  };
}

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase-server', () => ({ getSupabaseServer: async () => fakeClient() }));
vi.mock('@/lib/supabase-admin', () => ({ getSupabaseAdmin: () => fakeClient() }));
vi.mock('@/lib/relist', () => ({ relistLotInto: vi.fn() }));

import { deleteLot } from '../actions';
import { deleteDraftLot } from '../../../lotting/drafts/actions';

const LOT_ID = '00000000-0000-0000-0000-000000000d06';
const bareLot = {
  id: LOT_ID,
  status: 'in_inventory',
  operator_id: 'op-1',
  auction_id: null,
  sticker_code: null,
  intake_bin_id: null,
  intake_at: null,
};
const triggerRefusal = (details: string) => ({
  data: null,
  error: {
    code: 'P0001',
    message: `lot_has_physical_footprint: BIN-028904 cannot be deleted (${details})`,
    details,
    hint: 'Use Remove from inventory on the lot page instead of deleting it.',
  },
});

beforeEach(() => {
  state.deletes = 0;
  state.headers = [];
});

describe('deleteLot (console)', () => {
  it('refuses the BIN-028904 shape before any DELETE is sent', async () => {
    state.script = {
      lot: { ...bareLot, sticker_code: 'BRN:4982227', intake_bin_id: 'bin-1', intake_at: '2026-10-01T15:00:00Z' },
    };
    const r = await deleteLot({ lot_id: LOT_ID });
    expect(r).toEqual({
      ok: false,
      error:
        "This lot has a sticker, a shelf and location history, so it's a real item and can't be deleted. " +
        'Use Remove from inventory on the lot page to dispose of it instead.',
    });
    expect(state.deletes).toBe(0);
  });

  it('refuses a lot with only a sticker', async () => {
    state.script = { lot: { ...bareLot, status: 'pending_intake', sticker_code: 'BRN:1' } };
    const r = await deleteLot({ lot_id: LOT_ID });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^This lot has a sticker, so/);
    expect(state.deletes).toBe(0);
  });

  it('maps the trigger refusal (child-table evidence) to staff copy', async () => {
    state.script = { lot: bareLot, deleteResult: triggerRefusal('bin_assignments,lot_location_events') };
    const r = await deleteLot({ lot_id: LOT_ID });
    expect(state.deletes).toBe(1);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^This lot has a shelf and location history, so .*Remove from inventory/);
    expect(!r.ok && r.error).not.toContain('lot_has_physical_footprint');
  });

  it('deletes a bare lot', async () => {
    state.script = { lot: bareLot };
    expect(await deleteLot({ lot_id: LOT_ID })).toEqual({ ok: true });
    expect(state.deletes).toBe(1);
  });

  it('a delete that removed no row (RLS) is not reported as success', async () => {
    state.script = { lot: bareLot, deleteResult: { data: [], error: null } };
    const r = await deleteLot({ lot_id: LOT_ID });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/not deleted/);
  });

  it('still refuses a lot with bids, before the footprint check', async () => {
    state.script = { lot: { ...bareLot, sticker_code: 'BRN:1' }, bids: 2 };
    const r = await deleteLot({ lot_id: LOT_ID });
    expect(!r.ok && r.error).toMatch(/has bids/);
    expect(state.deletes).toBe(0);
  });
});

describe('deleteDraftLot (Drafts page, service role)', () => {
  it('maps the trigger refusal for a stickered draft', async () => {
    state.script = { lot: null, deleteResult: triggerRefusal('sticker_code') };
    const r = await deleteDraftLot({ lot_id: LOT_ID });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^This lot has a sticker, so .*Remove from inventory/);
  });

  it('tells the trigger who asked, so the audit row has an actor', async () => {
    state.script = { lot: null };
    expect(await deleteDraftLot({ lot_id: LOT_ID })).toEqual({ ok: true });
    expect(state.headers).toEqual([['x-bingo-actor', 'user-admin']]);
  });
});
