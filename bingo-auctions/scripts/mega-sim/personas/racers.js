// scripts/mega-sim/personas/racers.js
//
// Persona: covers two audit-flagged sim gaps that don't fit any other
// persona's semantics:
//
//   #5 Stale / invalid JWT mid-RPC
//      Real failure: a TS server action checks supabase.auth.getUser()
//      (valid), then calls an RPC; by the time PostgREST validates the
//      JWT, it's expired or revoked. The action should surface a clean
//      auth error, not a partial-state surprise. The sim doesn't wait
//      out a JWT lifetime; it just submits a deliberately-mangled
//      Bearer token and verifies PostgREST rejects cleanly without
//      creating any side-effects.
//
//   #6 Manifest edited / deleted AFTER a lot was minted from it
//      Once intake_lot_to_bin copies an import_rows row's fields onto
//      the new lot, the lot is an independent snapshot. Operators can
//      retroactively edit the source manifest (rename, recategorize,
//      drop) without disturbing the lot. We test:
//        - UPDATE on import_rows.title → lot.title unchanged.
//        - DELETE on import_rows → lot survives; lot.import_row_id
//          nullifies (FK is ON DELETE SET NULL).
//
// Runs in Phase 1 after photographer. Doesn't touch any of the
// in_inventory lots the auctioneer phase depends on; uses freshly-
// minted lots from a tiny side-manifest so failures here can't poison
// the rest of the run.

'use strict';

const { step, expect, setPhase } = require('../lib/assert');
const { time } = require('../lib/timer');
const supa = require('../lib/supa');

// Corrupt a JWT by flipping the last 8 characters of its signature.
// PostgREST validates the HS256 signature server-side; this will be
// rejected before any policy check or RPC body runs.
function mangleJwt(jwt) {
  if (!jwt || jwt.length < 8) return 'invalid';
  // JWTs are three base64-url segments split by '.'. Mangle just the
  // signature so the header+payload still parse — the rejection is
  // purely a signature failure.
  const parts = jwt.split('.');
  if (parts.length !== 3) return jwt + 'XXXX';
  const sig = parts[2];
  const flipped = sig.slice(0, -8) + 'AAAAAAAA';
  return parts[0] + '.' + parts[1] + '.' + flipped;
}

async function run({ ctx }) {
  setPhase('Racers');

  // ── Stale / invalid JWT: PostgREST rejects cleanly ──────────────────
  // Use create_draft_lot — a SECURITY DEFINER RPC the admin token can
  // normally call. The valid call succeeds; the mangled call must fail
  // BEFORE the function body runs, so no lot row gets created.
  let preCount = null;
  await step('count operator lots before stale-JWT test', async () => {
    const { value } = await time('supa.select.lots.count.preStaleJwt', () =>
      supa.supaSelect(
        ctx.adminToken,
        'lots',
        'operator_id=eq.' + ctx.operatorId + '&deleted_at=is.null',
        'id',
      ),
    );
    expect(value.error).toBeNull();
    preCount = value.data.length;
  });

  await step('mangled-signature JWT rejected by PostgREST (no lot created)', async () => {
    const mangled = mangleJwt(ctx.adminToken);
    const { value } = await time('rpc.create_draft_lot.mangledJwt', () =>
      supa.supaRpc(mangled, 'create_draft_lot', {
        p_operator_id: ctx.operatorId,
        p_title: 'Sim mangled-jwt lot (should NEVER mint)',
        p_description: null,
        p_category: null,
        p_category_id: null,
        p_condition: 'good',
        p_msrp_cents: 100,
        p_starting_bid_cents: 100,
        p_photo_urls: [],
        p_external_code: 'SIM-MANGLED-JWT',
        p_source: 'sim',
      }),
    );
    // Must be an error envelope (PostgREST returns 401 with a JSON body).
    expect(value.error).toBeTruthy('mangled JWT rejected');
    // The PostgREST status hint is in value.error.status when JSON parse
    // failed, OR value.error.code on a structured error (PGRST3xx for
    // auth, PGRSTxxx in general). Either way value.data is null.
    expect(value.data).toBeNull();
  });

  await step('no lot was created from the rejected request', async () => {
    const { value } = await time('supa.select.lots.count.postStaleJwt', () =>
      supa.supaSelect(
        ctx.adminToken,
        'lots',
        'operator_id=eq.' + ctx.operatorId + '&deleted_at=is.null',
        'id',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data.length).toBe(preCount);
  });

  await step('empty Bearer token rejected by PostgREST', async () => {
    const { value } = await time('rpc.create_draft_lot.emptyJwt', () =>
      supa.supaRpc('', 'create_draft_lot', {
        p_operator_id: ctx.operatorId,
        p_title: 'Sim empty-jwt lot (should NEVER mint)',
        p_description: null,
        p_category: null,
        p_category_id: null,
        p_condition: 'good',
        p_msrp_cents: 100,
        p_starting_bid_cents: 100,
        p_photo_urls: [],
        p_external_code: 'SIM-EMPTY-JWT',
        p_source: 'sim',
      }),
    );
    // Empty token → PostgREST falls back to apikey (anon role).
    // Anon role has no operator_users row, so the RPC raises
    // not_authenticated or not_staff. Either way: not a silent success.
    expect(value.error).toBeTruthy('empty Bearer token rejected');
  });

  // ── Manifest edits / deletes don't disturb minted lots ───────────────
  // Build a tiny side-manifest, intake one row → lot, then mutate /
  // delete the source row and verify the lot stays unchanged.
  let sideImportId = null;
  let sideRowToEdit = null;
  let sideRowToDelete = null;
  let editLotId = null;
  let editLotOriginalTitle = null;
  let deleteLotId = null;

  await step('seed a side-manifest for the edit + delete tests', async () => {
    const { value: impRes } = await time('supa.insert.imports.racers', () =>
      supa.supaInsert(
        null,
        'imports',
        {
          operator_id: ctx.operatorId,
          filename: 'racers-side-manifest.csv',
          source_label: 'Racers sim test',
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
    sideImportId = impRes.data.id;

    const editTitle = 'Original — racers edit test';
    const deleteTitle = 'Original — racers delete test';
    const editUpc = 'RACERS-EDIT-' + Date.now();
    const deleteUpc = 'RACERS-DEL-' + Date.now();

    const { value: rowsRes } = await time('supa.insert.import_rows.racers', () =>
      supa.supaInsertMany(
        null,
        'import_rows',
        [
          {
            import_id: sideImportId,
            operator_id: ctx.operatorId,
            raw_data: { title: editTitle },
            title: editTitle,
            upc: editUpc,
            warehouse_id: ctx.warehouseId,
            status: 'pending',
          },
          {
            import_id: sideImportId,
            operator_id: ctx.operatorId,
            raw_data: { title: deleteTitle },
            title: deleteTitle,
            upc: deleteUpc,
            warehouse_id: ctx.warehouseId,
            status: 'pending',
          },
        ],
        true,
      ),
    );
    expect(rowsRes.error).toBeNull();
    expect(rowsRes.data.length).toBe(2);
    sideRowToEdit = rowsRes.data[0];
    sideRowToDelete = rowsRes.data[1];
    editLotOriginalTitle = editTitle;
  });

  await step('intake mints lots from both side-manifest rows', async () => {
    // Use bins[0] (binA1's token is unchanged; binA2 was rotated in picker).
    const { value: intake1 } = await time('rpc.intake.racers.edit', () =>
      supa.supaRpc(ctx.pickerToken, 'intake_lot_to_bin', {
        p_lot_identifier: sideRowToEdit.upc,
        p_bin_qr_token: ctx.bins[0].qr_token,
      }),
    );
    expect(intake1.error).toBeNull();
    expect(intake1.data.ok).toBe(true);
    editLotId = intake1.data.lot_id;

    const { value: intake2 } = await time('rpc.intake.racers.delete', () =>
      supa.supaRpc(ctx.pickerToken, 'intake_lot_to_bin', {
        p_lot_identifier: sideRowToDelete.upc,
        p_bin_qr_token: ctx.bins[0].qr_token,
      }),
    );
    expect(intake2.error).toBeNull();
    expect(intake2.data.ok).toBe(true);
    deleteLotId = intake2.data.lot_id;
  });

  await step('UPDATE manifest row title — minted lot stays at original snapshot', async () => {
    const edited = 'EDITED AFTER MINT (must not propagate)';
    const { value: updateVal } = await time('supa.update.import_rows.editedAfterMint', () =>
      supa.supaUpdate(
        null,
        'import_rows',
        'id=eq.' + sideRowToEdit.id,
        { title: edited, raw_data: { title: edited } },
        true,
      ),
    );
    expect(updateVal.error).toBeNull();
    expect(updateVal.data[0].title).toBe(edited);

    // Re-fetch the lot and verify title is the ORIGINAL.
    const lotCheck = await supa.supaSelect(
      ctx.adminToken,
      'lots',
      'id=eq.' + editLotId,
      'id,title,import_row_id',
    );
    expect(lotCheck.error).toBeNull();
    expect(lotCheck.data.length).toBe(1);
    expect(lotCheck.data[0].title).toBe(editLotOriginalTitle);
    // Link still points at the (now-edited) import_rows row.
    expect(lotCheck.data[0].import_row_id).toBe(sideRowToEdit.id);
  });

  await step('DELETE manifest row — minted lot survives, FK nullifies (ON DELETE SET NULL)', async () => {
    const { value: delVal } = await time('supa.delete.import_rows.deletedAfterMint', () =>
      supa.supaDelete(
        null,
        'import_rows',
        'id=eq.' + sideRowToDelete.id,
        true,
      ),
    );
    expect(delVal.error).toBeNull();

    const lotCheck = await supa.supaSelect(
      ctx.adminToken,
      'lots',
      'id=eq.' + deleteLotId,
      'id,status,import_row_id',
    );
    expect(lotCheck.error).toBeNull();
    expect(lotCheck.data.length).toBe(1);
    // Lot is intact — still in_inventory, still queryable.
    expect(lotCheck.data[0].status).toBe('in_inventory');
    // import_row_id nullified per 0029's ON DELETE SET NULL.
    expect(lotCheck.data[0].import_row_id).toBeNull();
  });
}

module.exports = { run };
