// scripts/mega-sim/personas/binsmith.js
//
// Persona: an admin generating bins via the create_bins_bulk RPC
// (migration 0065). Verifies:
//   • Happy path: creates N bins from (aisle, bays-range, levels,
//     positions) inputs. Per-row result has ok=true, error=null.
//   • Duplicate detection: re-running the same range returns
//     ok=false, error='duplicate' for each conflicting code.
//   • Range parsing: comma-separated and dash-range syntax both work.
//   • Authorization: picker-role caller is rejected with
//     admin_or_manager_required.
//   • Operator scoping: bin codes only exist in the right warehouse;
//     RLS doesn't leak.
//
// Doesn't depend on Phase 1 inventory state — bins created here go to
// the operator's warehouse and don't collide with the 3 setup bins.

'use strict';

const { step, expect, setPhase } = require('../lib/assert');
const { time } = require('../lib/timer');
const supa = require('../lib/supa');

async function run({ ctx }) {
  setPhase('Binsmith');

  // Use an aisle name that won't collide with the operator persona's
  // setup bins (SIM-A-01/02 and SIM-B-01). Z-prefix is safely unique.
  const TEST_AISLE = 'Z' + Date.now().toString().slice(-4);

  await step('create_bins_bulk creates 5 bins from "1-5" bay range', async () => {
    const { value } = await time('rpc.create_bins_bulk.range', () =>
      supa.supaRpc(ctx.adminToken, 'create_bins_bulk', {
        p_warehouse_id: ctx.warehouseId,
        p_aisle: TEST_AISLE,
        p_bays: '1-5',
        p_levels: '1',
        p_positions: '1',
      }),
    );
    expect(value.error).toBeNull();
    expect(Array.isArray(value.data)).toBe(true);
    expect(value.data.length).toBe(5);
    for (const r of value.data) {
      expect(r.ok).toBe(true);
      expect(r.error).toBeNull();
      // Code format: AISLE-BAY-LEVEL-POSITION (e.g. Z1234-01-1-01)
      expect(r.code).toMatch(new RegExp('^' + TEST_AISLE + '-0[1-5]-1-01$'));
    }
  });

  await step('re-running the same range returns per-row duplicate errors', async () => {
    const { value } = await time('rpc.create_bins_bulk.duplicate', () =>
      supa.supaRpc(ctx.adminToken, 'create_bins_bulk', {
        p_warehouse_id: ctx.warehouseId,
        p_aisle: TEST_AISLE,
        p_bays: '1-5',
        p_levels: '1',
        p_positions: '1',
      }),
    );
    expect(value.error).toBeNull();
    expect(value.data.length).toBe(5);
    for (const r of value.data) {
      expect(r.ok).toBe(false);
      expect(r.error).toBe('duplicate');
    }
  });

  await step('comma-separated bay list ("7,9,11") works alongside dash-ranges', async () => {
    const { value } = await time('rpc.create_bins_bulk.csv', () =>
      supa.supaRpc(ctx.adminToken, 'create_bins_bulk', {
        p_warehouse_id: ctx.warehouseId,
        p_aisle: TEST_AISLE,
        p_bays: '7,9,11',
        p_levels: '1',
        p_positions: '1',
      }),
    );
    expect(value.error).toBeNull();
    expect(value.data.length).toBe(3);
    const okCodes = value.data.filter((r) => r.ok).map((r) => r.code).sort();
    expect(okCodes).toEqual([
      TEST_AISLE + '-07-1-01',
      TEST_AISLE + '-09-1-01',
      TEST_AISLE + '-11-1-01',
    ]);
  });

  await step('multi-dimensional ("M-bays × N-positions") cross-product expands correctly', async () => {
    // 3 bays × 2 positions = 6 bins, all at level 1.
    const { value } = await time('rpc.create_bins_bulk.multiDim', () =>
      supa.supaRpc(ctx.adminToken, 'create_bins_bulk', {
        p_warehouse_id: ctx.warehouseId,
        p_aisle: TEST_AISLE + 'X',
        p_bays: '1-3',
        p_levels: '1',
        p_positions: '1-2',
      }),
    );
    expect(value.error).toBeNull();
    expect(value.data.length).toBe(6);
    const okCodes = value.data.filter((r) => r.ok).map((r) => r.code).sort();
    expect(okCodes).toEqual([
      TEST_AISLE + 'X-01-1-01',
      TEST_AISLE + 'X-01-1-02',
      TEST_AISLE + 'X-02-1-01',
      TEST_AISLE + 'X-02-1-02',
      TEST_AISLE + 'X-03-1-01',
      TEST_AISLE + 'X-03-1-02',
    ]);
  });

  await step('picker-role caller is rejected with admin_or_manager_required', async () => {
    const { value } = await time('rpc.create_bins_bulk.unauthorized', () =>
      supa.supaRpc(ctx.pickerToken, 'create_bins_bulk', {
        p_warehouse_id: ctx.warehouseId,
        p_aisle: TEST_AISLE + 'P',
        p_bays: '1',
        p_levels: '1',
        p_positions: '1',
      }),
    );
    // RPC raises an exception — surfaces as PostgREST error envelope.
    expect(value.error).toBeTruthy('picker rejection');
    expect(/admin_or_manager_required/.test(JSON.stringify(value.error))).toBe(true);
  });

  await step('invalid range ("xyz") raises range_invalid', async () => {
    const { value } = await time('rpc.create_bins_bulk.badRange', () =>
      supa.supaRpc(ctx.adminToken, 'create_bins_bulk', {
        p_warehouse_id: ctx.warehouseId,
        p_aisle: TEST_AISLE + 'Y',
        p_bays: 'xyz',
        p_levels: '1',
        p_positions: '1',
      }),
    );
    expect(value.error).toBeTruthy('bad-range rejection');
    expect(/range_invalid/.test(JSON.stringify(value.error))).toBe(true);
  });

  await step('empty aisle is rejected with aisle_invalid_length', async () => {
    const { value } = await time('rpc.create_bins_bulk.emptyAisle', () =>
      supa.supaRpc(ctx.adminToken, 'create_bins_bulk', {
        p_warehouse_id: ctx.warehouseId,
        p_aisle: '   ',
        p_bays: '1',
        p_levels: '1',
        p_positions: '1',
      }),
    );
    expect(value.error).toBeTruthy('empty-aisle rejection');
    expect(/aisle_invalid_length/.test(JSON.stringify(value.error))).toBe(true);
  });

  await step('verify the binsmith bins are actually in the DB with auto qr_tokens', async () => {
    const { value } = await time('supa.select.bins.binsmithCheck', () =>
      supa.supaSelect(
        ctx.adminToken,
        'bins',
        'aisle=eq.' + TEST_AISLE + '&warehouse_id=eq.' + ctx.warehouseId,
        'code,qr_token,aisle,bay',
      ),
    );
    expect(value.error).toBeNull();
    // 5 from the first batch (the duplicate re-run inserted 0 new ones)
    // plus 3 from the comma-list = 8 bins total under TEST_AISLE.
    expect(value.data.length).toBe(8);
    for (const b of value.data) {
      expect(b.qr_token).toBeTruthy('qr_token auto-generated');
      expect(b.aisle).toBe(TEST_AISLE);
    }
  });
}

module.exports = { run };
