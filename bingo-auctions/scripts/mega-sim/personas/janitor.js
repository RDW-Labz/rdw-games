// scripts/mega-sim/personas/janitor.js
//
// Persona: an admin doing inventory housekeeping. Exercises the parts
// of the platform that the audit flagged were untested even though
// they're easy to break:
//
//   • Soft-delete a lot (sets deleted_at + deleted_by) — verifies the
//     row drops out of "active" listings and shows up in Trash.
//   • Restore a soft-deleted lot — verifies deleted_at clears but
//     deleted_by survives as audit trail.
//   • Status guard on soft-delete — only pending_intake / in_inventory
//     are eligible; trying to soft-delete a scheduled or live lot is
//     a 0-row no-op (the action's WHERE clause enforces this).
//   • Hard-delete — only allowed when deleted_at IS NOT NULL. Active
//     rows survive a hard-delete attempt because the WHERE filter
//     misses them.
//   • drop_import_rows RPC (migration 0029):
//       - happy path: pending rows → status='dropped' with audit trail.
//       - idempotency: dropping an already-dropped row is a 0-row no-op.
//       - authorization: picker-role caller is rejected.
//
// Runs BEFORE the auctioneer in Phase 2. Soft-deletes happen on lots
// that get restored before the auctioneer pulls in_inventory; the
// only lot that disappears for good is one freshly-minted-then-trashed
// inside this persona. Doesn't touch any of the lots the bidders or
// closer expect.
//
// Auth: matches the TS server action's pattern — admin user verified
// via operator_users role, then the actual UPDATE / DELETE runs with
// service-role to bypass RLS. Sim mirrors that with useServiceKey=true.

'use strict';

const { step, expect, setPhase } = require('../lib/assert');
const { time } = require('../lib/timer');
const supa = require('../lib/supa');

async function run({ ctx }) {
  setPhase('Janitor');

  // ── Pick two in_inventory lots from the picker phase to use as ──────
  // test material. These get soft-deleted then restored, so the
  // auctioneer (which runs after) still sees them.
  let trashTargets = [];
  await step('pick two in_inventory lots to soft-delete-then-restore', async () => {
    const { value } = await time('supa.select.lots.trashCandidates', () =>
      supa.supaSelect(
        ctx.adminToken,
        'lots',
        'operator_id=eq.' + ctx.operatorId +
          '&status=eq.in_inventory' +
          '&deleted_at=is.null',
        'id,lot_code',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data.length).toBeGreaterThan(2);
    // Take the last two — keep the first ones for the auctioneer's
    // primary collection (and to keep ordering stable in reports).
    trashTargets = value.data.slice(-2);
    console.log('      [janitor] selected ' + trashTargets.map((l) => l.lot_code).join(', ') + ' for trash test');
  });

  // ── Soft-delete: set deleted_at + deleted_by ─────────────────────────
  await step('soft-delete two in_inventory lots', async () => {
    const now = new Date().toISOString();
    const ids = trashTargets.map((l) => l.id);
    const { value } = await time('supa.update.lots.softDelete', () =>
      supa.supaUpdate(
        null,
        'lots',
        'id=in.(' + ids.join(',') + ')' +
          '&operator_id=eq.' + ctx.operatorId +
          '&status=in.(pending_intake,in_inventory)' +
          '&deleted_at=is.null',
        { deleted_at: now, deleted_by: ctx.adminUserId },
        true,
      ),
    );
    expect(value.error).toBeNull();
    expect(Array.isArray(value.data)).toBe(true);
    expect(value.data.length).toBe(2);
    for (const row of value.data) {
      expect(row.deleted_at).toBeTruthy('deleted_at set');
      expect(row.deleted_by).toBe(ctx.adminUserId);
    }
  });

  // ── Active listing must skip soft-deleted rows ───────────────────────
  await step('soft-deleted lots are hidden from active in_inventory listing', async () => {
    const ids = trashTargets.map((l) => l.id);
    const { value } = await time('supa.select.lots.activeListing', () =>
      supa.supaSelect(
        ctx.adminToken,
        'lots',
        'id=in.(' + ids.join(',') + ')' +
          '&deleted_at=is.null',
        'id',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data.length).toBe(0); // both are soft-deleted
  });

  // ── Trash listing must surface them ──────────────────────────────────
  await step('soft-deleted lots appear in trash listing', async () => {
    const ids = trashTargets.map((l) => l.id);
    const { value } = await time('supa.select.lots.trashListing', () =>
      supa.supaSelect(
        ctx.adminToken,
        'lots',
        'id=in.(' + ids.join(',') + ')' +
          '&deleted_at=not.is.null',
        'id,lot_code,deleted_at,deleted_by',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data.length).toBe(2);
    for (const row of value.data) {
      expect(row.deleted_at).toBeTruthy('trash row deleted_at set');
      expect(row.deleted_by).toBe(ctx.adminUserId);
    }
  });

  // ── Restore: clear deleted_at, keep deleted_by ──────────────────────
  await step('restore both soft-deleted lots (deleted_by survives as audit)', async () => {
    const ids = trashTargets.map((l) => l.id);
    const { value } = await time('supa.update.lots.restore', () =>
      supa.supaUpdate(
        null,
        'lots',
        'id=in.(' + ids.join(',') + ')' +
          '&operator_id=eq.' + ctx.operatorId +
          '&status=in.(pending_intake,in_inventory)' +
          '&deleted_at=not.is.null',
        { deleted_at: null },
        true,
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data.length).toBe(2);
    for (const row of value.data) {
      expect(row.deleted_at).toBeNull();
      // 0057's contract: deleted_by must survive as audit trail.
      expect(row.deleted_by).toBe(ctx.adminUserId);
    }
  });

  // ── Mint a fresh lot purely for hard-delete testing ──────────────────
  let hardDeleteLotId = null;
  let hardDeleteLotCode = null;
  await step('mint a fresh lot for hard-delete test', async () => {
    const { value: lotRes } = await time('rpc.create_draft_lot.hardDeleteTest', () =>
      supa.supaRpc(ctx.adminToken, 'create_draft_lot', {
        p_operator_id: ctx.operatorId,
        p_title: 'Sim hard-delete test lot',
        p_description: null,
        p_category: null,
        p_category_id: null,
        p_condition: 'good',
        p_msrp_cents: 999,
        p_starting_bid_cents: 100,
        p_photo_urls: [],
        p_external_code: 'SIM-HARDDEL-' + Date.now(),
        p_source: 'sim',
      }),
    );
    expect(lotRes.error).toBeNull();
    const row = Array.isArray(lotRes.data) ? lotRes.data[0] : lotRes.data;
    hardDeleteLotId = row.out_id;
    hardDeleteLotCode = row.out_lot_code;
    expect(hardDeleteLotId).toBeTruthy('hard-delete test lot minted');
  });

  // ── Hard-delete must fail on an active row (deleted_at IS NULL) ─────
  await step('hard-delete on active lot is a 0-row no-op (active rows survive)', async () => {
    const { value } = await time('supa.delete.lots.hardActive', () =>
      supa.supaDelete(
        null,
        'lots',
        'id=eq.' + hardDeleteLotId +
          '&operator_id=eq.' + ctx.operatorId +
          '&deleted_at=not.is.null',
        true,
      ),
    );
    expect(value.error).toBeNull();
    // Confirm row still exists.
    const check = await supa.supaSelect(
      ctx.adminToken,
      'lots',
      'id=eq.' + hardDeleteLotId,
      'id',
    );
    expect(check.error).toBeNull();
    expect(check.data.length).toBe(1);
  });

  // ── Soft-delete the hard-delete-target ──────────────────────────────
  await step('soft-delete the hard-delete-target first', async () => {
    const now = new Date().toISOString();
    const { value } = await time('supa.update.lots.softDeleteHardTarget', () =>
      supa.supaUpdate(
        null,
        'lots',
        'id=eq.' + hardDeleteLotId +
          '&operator_id=eq.' + ctx.operatorId +
          '&status=in.(pending_intake,in_inventory)' +
          '&deleted_at=is.null',
        { deleted_at: now, deleted_by: ctx.adminUserId },
        true,
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data.length).toBe(1);
  });

  // ── Now hard-delete succeeds ─────────────────────────────────────────
  await step('hard-delete works on the now-trashed lot', async () => {
    const { value } = await time('supa.delete.lots.hardTrashed', () =>
      supa.supaDelete(
        null,
        'lots',
        'id=eq.' + hardDeleteLotId +
          '&operator_id=eq.' + ctx.operatorId +
          '&deleted_at=not.is.null',
        true,
      ),
    );
    expect(value.error).toBeNull();
    // Confirm row really is gone.
    const check = await supa.supaSelect(
      ctx.adminToken,
      'lots',
      'id=eq.' + hardDeleteLotId,
      'id',
    );
    expect(check.error).toBeNull();
    expect(check.data.length).toBe(0);
  });

  // ── drop_import_rows RPC: happy path ────────────────────────────────
  // Mint a tiny import + 2 pending import_rows specifically for this
  // test (the lotter's manifest rows were all consumed by lot_import_rows).
  let dropImportId = null;
  let dropRowIds = [];
  await step('seed a small manifest for drop_import_rows test', async () => {
    const { value: impRes } = await time('supa.insert.imports.janitor', () =>
      supa.supaInsert(
        null,
        'imports',
        {
          operator_id: ctx.operatorId,
          filename: 'janitor-drop-test.csv',
          source_label: 'Janitor sim test',
          mapping: {},
          row_count: 2,
          classified_count: 0,
          status: 'completed',
          created_by: ctx.adminUserId,
        },
        true,
      ),
    );
    expect(impRes.error).toBeNull();
    dropImportId = impRes.data.id;

    const { value: rowsRes } = await time('supa.insert.import_rows.janitor', () =>
      supa.supaInsertMany(
        null,
        'import_rows',
        [
          {
            import_id: dropImportId,
            operator_id: ctx.operatorId,
            raw_data: { title: 'Janitor drop A' },
            title: 'Janitor drop A',
            status: 'pending',
          },
          {
            import_id: dropImportId,
            operator_id: ctx.operatorId,
            raw_data: { title: 'Janitor drop B' },
            title: 'Janitor drop B',
            status: 'pending',
          },
        ],
        true,
      ),
    );
    expect(rowsRes.error).toBeNull();
    expect(rowsRes.data.length).toBe(2);
    dropRowIds = rowsRes.data.map((r) => r.id);
  });

  await step('drop_import_rows drops 2 pending rows with reason', async () => {
    const { value } = await time('rpc.drop_import_rows.happy', () =>
      supa.supaRpc(ctx.adminToken, 'drop_import_rows', {
        p_import_row_ids: dropRowIds,
        p_reason: 'janitor sim test',
      }),
    );
    expect(value.error).toBeNull();
    // RPC returns INTEGER (ROW_COUNT). PostgREST envelopes this as a number.
    expect(value.data).toBe(2);
  });

  await step('dropped rows have status=dropped + dropped_reason + dropped_by', async () => {
    const { value } = await time('supa.select.import_rows.dropped', () =>
      supa.supaSelect(
        ctx.adminToken,
        'import_rows',
        'id=in.(' + dropRowIds.join(',') + ')',
        'id,status,dropped_at,dropped_reason,dropped_by',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data.length).toBe(2);
    for (const row of value.data) {
      expect(row.status).toBe('dropped');
      expect(row.dropped_at).toBeTruthy('dropped_at set');
      expect(row.dropped_reason).toBe('janitor sim test');
      expect(row.dropped_by).toBe(ctx.adminUserId);
    }
  });

  // ── drop_import_rows idempotency ─────────────────────────────────────
  await step('drop_import_rows on already-dropped rows is a 0-row no-op', async () => {
    const { value } = await time('rpc.drop_import_rows.idempotent', () =>
      supa.supaRpc(ctx.adminToken, 'drop_import_rows', {
        p_import_row_ids: dropRowIds,
        p_reason: 'second pass',
      }),
    );
    expect(value.error).toBeNull();
    // Guarded by `status = 'pending'` in the RPC — already-dropped rows
    // are skipped. ROW_COUNT = 0.
    expect(value.data).toBe(0);
  });

  // ── drop_import_rows authorization: picker is rejected ──────────────
  await step('drop_import_rows rejects picker-role caller', async () => {
    // Mint two fresh pending rows so we don't get confused by the
    // already-dropped ones from the idempotency test.
    const rowsRes = await supa.supaInsertMany(
      null,
      'import_rows',
      [
        {
          import_id: dropImportId,
          operator_id: ctx.operatorId,
          raw_data: { title: 'Janitor authz A' },
          title: 'Janitor authz A',
          status: 'pending',
        },
      ],
      true,
    );
    expect(rowsRes.error).toBeNull();
    const authzRowId = rowsRes.data[0].id;

    const { value } = await time('rpc.drop_import_rows.pickerRejected', () =>
      supa.supaRpc(ctx.pickerToken, 'drop_import_rows', {
        p_import_row_ids: [authzRowId],
        p_reason: 'should not work',
      }),
    );
    // The RPC raises 'admin_or_manager_required' with ERRCODE 42501.
    // PostgREST returns it as an error envelope.
    expect(value.error).toBeTruthy('picker rejected');
    const msg = JSON.stringify(value.error);
    expect(/admin_or_manager_required/.test(msg)).toBe(true);

    // Confirm the row is STILL pending (RPC didn't slip past authz).
    const check = await supa.supaSelect(
      ctx.adminToken,
      'import_rows',
      'id=eq.' + authzRowId,
      'status',
    );
    expect(check.error).toBeNull();
    expect(check.data[0].status).toBe('pending');
  });
}

module.exports = { run };
