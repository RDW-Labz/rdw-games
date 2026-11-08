// scripts/mega-sim/personas/picker.js
//
// Persona: warehouse picker. Scans things at bins. Exercises the
// 0059 unified intake RPC across:
//   • field-lotted lot (by lot_code)
//   • manifest row by UPC
//   • manifest row by title (Lowe's-style supplier SKU as title)
//   • manifest row by ASIN (Amazon-style)
//   • batch_intake with mixed identifiers
//   • bogus identifier returns lot_not_found
//
// All RPC calls go through the picker user's JWT — so we're testing
// the actual permission boundary, not just the SECURITY DEFINER body.

'use strict';

const { step, expect, setPhase } = require('../lib/assert');
const { time } = require('../lib/timer');
const supa = require('../lib/supa');

async function run({ ctx }) {
  setPhase('Picker');

  const binA1 = ctx.bins[0];
  const binA2 = ctx.bins[1];
  expect(binA1 && binA1.qr_token).toBeTruthy('bin A-01 qr_token');

  // ── Single intake of a field-lotted lot ──────────────────────────────
  await step('intake field-lotted lot by lot_code → in_inventory', async () => {
    const { value } = await time('rpc.intake_lot_to_bin.field-lotted', () =>
      supa.supaRpc(ctx.pickerToken, 'intake_lot_to_bin', {
        p_lot_identifier: ctx.quickLotCode,
        p_bin_qr_token: binA1.qr_token,
      }),
    );
    expect(value.error).toBeNull();
    // Returns intake_lot_result composite
    expect(value.data).toBeTruthy();
    expect(value.data.ok).toBe(true);
    expect(value.data.reason).toBe('ok');
    expect(value.data.lot_code).toBe(ctx.quickLotCode);
    expect(value.data.bin_code).toBe(binA1.code);
  });

  await step('field-lotted lot now status=in_inventory + has bin', async () => {
    const { value } = await time('supa.select.lots.afterIntake', () =>
      supa.supaSelect(
        ctx.adminToken,
        'lots',
        'id=eq.' + ctx.quickLotId,
        'status,intake_bin_id,intake_at,warehouse_id',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data[0].status).toBe('in_inventory');
    expect(value.data[0].intake_bin_id).toBe(binA1.id);
    expect(value.data[0].warehouse_id).toBe(ctx.warehouseId);
    expect(value.data[0].intake_at).toBeTruthy('intake_at set');
  });

  // ── Manifest fall-through by UPC (the 0059 hot path) ────────────────
  await step('intake manifest row by UPC → mints fresh lot in_inventory', async () => {
    expect(ctx.manifestPickByUpc).toBeTruthy('UPC available from fixtures');
    const { value } = await time('rpc.intake_lot_to_bin.manifest-upc', () =>
      supa.supaRpc(ctx.pickerToken, 'intake_lot_to_bin', {
        p_lot_identifier: ctx.manifestPickByUpc,
        p_bin_qr_token: binA1.qr_token,
      }),
    );
    expect(value.error).toBeNull();
    expect(value.data.ok).toBe(true);
    expect(value.data.reason).toBe('ok_minted_from_manifest');
    expect(value.data.lot_code).toMatch(new RegExp('^' + ctx.operatorCode + '-\\d{6}$'));
    ctx.manifestUpcLotCode = value.data.lot_code;
    ctx.manifestUpcLotId = value.data.lot_id;
  });

  await step('manifest-derived lot lands in_inventory with full identity', async () => {
    const { value } = await time('supa.select.lots.manifestUpc', () =>
      supa.supaSelect(
        ctx.adminToken,
        'lots',
        'id=eq.' + ctx.manifestUpcLotId,
        'status,source,external_code,title,msrp_cents,cost_cents,intake_bin_id,import_row_id,condition',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data[0].status).toBe('in_inventory');
    expect(value.data[0].intake_bin_id).toBe(binA1.id);
    expect(value.data[0].import_row_id).toBeTruthy('import_row_id linked');
    // source_label propagation — the bug we fixed earlier
    expect(value.data[0].source).toBeTruthy('source propagated from imports.source_label');
    expect(value.data[0].source).toMatch(/^Sim Truck/);
    // 0063 verification: cost_cents propagation from import_rows.cost_cents.
    // Fixture set this UPC row's cost_cents to 4500 (DeWalt drill).
    expect(value.data[0].cost_cents).toBe(ctx.manifestPickByUpcExpectedCostCents);
  });

  await step('manifest_row.status flipped to lotted after intake', async () => {
    const { value } = await time('supa.select.import_rows.afterUpc', () =>
      supa.supaSelect(
        ctx.adminToken,
        'import_rows',
        'lot_id=eq.' + ctx.manifestUpcLotId,
        'id,status,lotted_at',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data && value.data.length).toBe(1);
    expect(value.data[0].status).toBe('lotted');
    expect(value.data[0].lotted_at).toBeTruthy('lotted_at set');
  });

  // ── Manifest fall-through by title (Lowe's-style SKU) ───────────────
  await step('intake manifest row by title (supplier SKU) → mints lot', async () => {
    expect(ctx.manifestPickByTitle).toBeTruthy('title-only row available');
    const { value } = await time('rpc.intake_lot_to_bin.manifest-title', () =>
      supa.supaRpc(ctx.pickerToken, 'intake_lot_to_bin', {
        p_lot_identifier: ctx.manifestPickByTitle,
        p_bin_qr_token: binA2.qr_token,
      }),
    );
    expect(value.error).toBeNull();
    expect(value.data.ok).toBe(true);
    expect(value.data.reason).toBe('ok_minted_from_manifest');
    ctx.manifestTitleLotCode = value.data.lot_code;
  });

  // ── Manifest fall-through by ASIN ────────────────────────────────────
  await step('intake manifest row by ASIN → mints lot with asin/fnsku/lpn copied', async () => {
    expect(ctx.manifestPickByAsin).toBeTruthy('asin row available');
    const { value: rpcVal } = await time('rpc.intake_lot_to_bin.manifest-asin', () =>
      supa.supaRpc(ctx.pickerToken, 'intake_lot_to_bin', {
        p_lot_identifier: ctx.manifestPickByAsin,
        p_bin_qr_token: binA1.qr_token,
      }),
    );
    expect(rpcVal.error).toBeNull();
    expect(rpcVal.data.ok).toBe(true);
    expect(rpcVal.data.reason).toBe('ok_minted_from_manifest');

    const { value: lotVal } = await time('supa.select.lots.afterAsin', () =>
      supa.supaSelect(
        ctx.adminToken,
        'lots',
        'id=eq.' + rpcVal.data.lot_id,
        'asin,fnsku,lpn,brand,model',
      ),
    );
    expect(lotVal.error).toBeNull();
    expect(lotVal.data[0].asin).toBe(ctx.manifestPickByAsin);
    expect(lotVal.data[0].fnsku).toBeTruthy('fnsku copied');
    expect(lotVal.data[0].lpn).toBeTruthy('lpn copied');
  });

  // ── Bogus identifier ─────────────────────────────────────────────────
  await step('bogus identifier returns lot_not_found', async () => {
    const { value } = await time('rpc.intake_lot_to_bin.bogus', () =>
      supa.supaRpc(ctx.pickerToken, 'intake_lot_to_bin', {
        p_lot_identifier: 'BOGUS-NEVER-EXISTS-' + Date.now(),
        p_bin_qr_token: binA1.qr_token,
      }),
    );
    expect(value.error).toBeNull();
    expect(value.data.ok).toBe(false);
    expect(value.data.reason).toBe('lot_not_found');
  });

  // ── Batch intake with mixed identifiers ──────────────────────────────
  await step('batch_intake_lot_to_bin handles [UPC, title, FNSKU, bogus]', async () => {
    const identifiers = [
      // Pick remaining unused manifest rows. The previous steps already
      // intook one UPC, one title, one ASIN — so use *different* rows.
      ctx.manifestPickByFnsku || 'X005QR0ST1',
      'BOGUS-DUMMY',
    ];
    const { value } = await time('rpc.batch_intake_lot_to_bin', () =>
      supa.supaRpc(ctx.pickerToken, 'batch_intake_lot_to_bin', {
        p_lot_identifiers: identifiers,
        p_bin_qr_token: binA2.qr_token,
      }),
    );
    expect(value.error).toBeNull();
    expect(Array.isArray(value.data)).toBe(true);
    expect(value.data.length).toBe(identifiers.length);
    // First identifier should mint from manifest
    const first = value.data[0];
    expect(first.ok).toBe(true);
    expect(first.code).toBe('ok_minted_from_manifest');
    // Bogus returns lot_not_found
    const last = value.data[value.data.length - 1];
    expect(last.ok).toBe(false);
    expect(last.code).toBe('lot_not_found');
  });

  // ── Idempotency: re-scanning same UPC after intake ──────────────────
  // Moved BEFORE the bin-revocation tests so the test bin (binA2) is
  // still active when this fires. After revocation, this same scan
  // would error with bin_not_found_or_revoked instead of lot_not_found.
  await step('re-scanning same UPC after intake hits the just-minted lot, not manifest', async () => {
    const { value } = await time('rpc.intake_lot_to_bin.rescan', () =>
      supa.supaRpc(ctx.pickerToken, 'intake_lot_to_bin', {
        p_lot_identifier: ctx.manifestPickByUpc,
        p_bin_qr_token: binA2.qr_token,
      }),
    );
    expect(value.error).toBeNull();
    expect(value.data.ok).toBe(false);
    expect(value.data.reason).toBe('lot_not_found');
  });

  // ── 0062: Condition normalization round-trip ────────────────────────
  // Lot the four "CONDNORM-*" manifest rows (each with a different
  // supplier-vocab raw condition string) by title, then assert each
  // lot's lots.condition matches the expected normalizer mapping.
  // Catches drift in normalize_manifest_condition() OR any future
  // regression that re-introduces the silent 'good' coercion.
  for (const sample of ctx.condNormSamples || []) {
    const stepName =
      'condition normalize: "' + sample.raw + '" → ' + sample.expected;
    await step(stepName, async () => {
      const { value: rpcVal } = await time(
        'rpc.intake.condNorm.' + sample.expected,
        () =>
          supa.supaRpc(ctx.pickerToken, 'intake_lot_to_bin', {
            p_lot_identifier: sample.title,
            p_bin_qr_token: binA1.qr_token,
          }),
      );
      expect(rpcVal.error).toBeNull();
      expect(rpcVal.data.ok).toBe(true);
      expect(rpcVal.data.reason).toBe('ok_minted_from_manifest');

      const { value: lotVal } = await time(
        'supa.select.lots.condNorm.' + sample.expected,
        () =>
          supa.supaSelect(
            ctx.adminToken,
            'lots',
            'id=eq.' + rpcVal.data.lot_id,
            'condition',
          ),
      );
      expect(lotVal.error).toBeNull();
      expect(lotVal.data[0].condition).toBe(sample.expected);
    });
  }

  // ── 0064: Bin token revocation + rotation ───────────────────────────
  // Pick a bin that hasn't been used in earlier steps. binA2 has
  // intakes against it, but the lot statuses are already in_inventory
  // so this revoke doesn't break anything retroactively.
  //
  // Test plan:
  //   1. Revoke binA2's token → its current qr_token is now revoked.
  //   2. Try an intake against the revoked token → expect
  //      bin_not_found_or_revoked.
  //   3. Rotate binA2's token → get a fresh UUID.
  //   4. Try the same intake with the NEW token → expect success.
  //   5. Try the same intake with the OLD (revoked) token → still
  //      rejected (proves rotate didn't accidentally reactivate old).
  let oldBinToken = binA2.qr_token;
  let newBinToken = null;

  await step('revoke_bin_token rejects future scans of binA2', async () => {
    const { value: revoke } = await time('rpc.revoke_bin_token', () =>
      supa.supaRpc(ctx.adminToken, 'revoke_bin_token', {
        p_bin_id: binA2.id,
        p_reason: 'sim: testing revocation flow',
      }),
    );
    expect(revoke.error).toBeNull();
  });

  await step('intake against revoked binA2 token → bin_not_found_or_revoked', async () => {
    // Create a fresh field-lotted lot so we have something to intake.
    const { value: createRes } = await time('rpc.create_draft_lot.revokeTest', () =>
      supa.supaRpc(ctx.adminToken, 'create_draft_lot', {
        p_operator_id: ctx.operatorId,
        p_title: 'Sim revoke-test lot',
        p_description: null,
        p_category: null,
        p_category_id: null,
        p_condition: 'good',
        p_msrp_cents: 999,
        p_starting_bid_cents: 100,
        p_photo_urls: [],
        p_external_code: 'SIM-REVOKE-' + Date.now(),
        p_source: 'sim',
      }),
    );
    if (createRes.error) {
      throw new Error('create_draft_lot failed: ' + JSON.stringify(createRes.error));
    }
    const row = Array.isArray(createRes.data) ? createRes.data[0] : createRes.data;
    expect(row && row.out_lot_code).toBeTruthy('revoke-test lot minted');
    const revokeLotCode = row.out_lot_code;

    const { value: intake } = await time('rpc.intake.revokedToken', () =>
      supa.supaRpc(ctx.pickerToken, 'intake_lot_to_bin', {
        p_lot_identifier: revokeLotCode,
        p_bin_qr_token: oldBinToken,
      }),
    );
    expect(intake.error).toBeNull();
    expect(intake.data.ok).toBe(false);
    expect(intake.data.reason).toBe('bin_not_found_or_revoked');
    ctx.revokeTestLotCode = revokeLotCode;
  });

  await step('rotate_bin_token returns a fresh UUID + reactivates the bin', async () => {
    const { value: rotate } = await time('rpc.rotate_bin_token', () =>
      supa.supaRpc(ctx.adminToken, 'rotate_bin_token', {
        p_bin_id: binA2.id,
      }),
    );
    expect(rotate.error).toBeNull();
    expect(rotate.data).toBeTruthy('rotate returned a token');
    // RPC returns the new UUID as the raw value, not wrapped.
    newBinToken = rotate.data;
    expect(typeof newBinToken).toBe('string');
    // Sanity: new UUID must differ from old.
    expect(newBinToken === oldBinToken).toBe(false);
  });

  await step('intake against the NEW rotated token succeeds', async () => {
    expect(ctx.revokeTestLotCode).toBeTruthy('revoke test lot exists');
    expect(newBinToken).toBeTruthy('new token captured');
    const { value: intake } = await time('rpc.intake.rotatedToken', () =>
      supa.supaRpc(ctx.pickerToken, 'intake_lot_to_bin', {
        p_lot_identifier: ctx.revokeTestLotCode,
        p_bin_qr_token: newBinToken,
      }),
    );
    expect(intake.error).toBeNull();
    expect(intake.data.ok).toBe(true);
    expect(intake.data.reason).toBe('ok');
  });

  await step('intake against the OLD token still rejected (rotate did not reactivate old)', async () => {
    // Mint another quick lot so we have something fresh to try.
    const { value: createRes } = await time('rpc.create_draft_lot.staleTokenTest', () =>
      supa.supaRpc(ctx.adminToken, 'create_draft_lot', {
        p_operator_id: ctx.operatorId,
        p_title: 'Sim stale-token-test lot',
        p_description: null,
        p_category: null,
        p_category_id: null,
        p_condition: 'good',
        p_msrp_cents: 999,
        p_starting_bid_cents: 100,
        p_photo_urls: [],
        p_external_code: 'SIM-STALE-' + Date.now(),
        p_source: 'sim',
      }),
    );
    const row = Array.isArray(createRes.data) ? createRes.data[0] : createRes.data;
    const staleLotCode = row.out_lot_code;

    const { value: intake } = await time('rpc.intake.oldToken', () =>
      supa.supaRpc(ctx.pickerToken, 'intake_lot_to_bin', {
        p_lot_identifier: staleLotCode,
        p_bin_qr_token: oldBinToken,
      }),
    );
    expect(intake.error).toBeNull();
    expect(intake.data.ok).toBe(false);
    expect(intake.data.reason).toBe('bin_not_found_or_revoked');
  });

}

module.exports = { run };
