// scripts/mega-sim/personas/lotter.js
//
// Persona: lotter / operator-admin doing intake-prep work. Uploads a
// manifest, runs Quick Lot (catalog + AI fallback), Photo Scan, and
// Shelf Scan. Each AI call is captured by the cost tracker.
//
// IMPORTANT: this persona writes a `imports` row + `import_rows` rows
// using the service-role key (mirroring what `commitImport` does on
// the server but without going through the Next runtime). RLS-aware
// reads use the admin user's JWT.

'use strict';

const { step, expect, setPhase } = require('../lib/assert');
const { time } = require('../lib/timer');
const supa = require('../lib/supa');
const cost = require('../lib/cost');
const fixtures = require('../lib/fixtures');

async function run({ ctx, noAi }) {
  setPhase('Lotter');

  // ── Manifest import (service-role direct DB writes) ─────────────────
  const manifestRows = fixtures.buildManifestRows();
  let importId = null;
  let importRowIds = [];

  await step('create imports row', async () => {
    const { value } = await time('supa.insert.imports', () =>
      supa.supaInsert(
        null,
        'imports',
        {
          operator_id: ctx.operatorId,
          filename: fixtures.MANIFEST_FILENAME,
          source_label: 'Sim Truck ' + new Date().toISOString().slice(0, 10),
          mapping: {},
          row_count: manifestRows.length,
          classified_count: 0,
          status: 'completed',
          created_by: ctx.adminUserId,
        },
        true,
      ),
    );
    expect(value.error).toBeNull();
    importId = value.data.id;
    ctx.importId = importId;
  });

  await step('insert ' + manifestRows.length + ' import_rows (chunked)', async () => {
    const payload = manifestRows.map((r) => ({
      operator_id: ctx.operatorId,
      import_id: importId,
      raw_data: r,
      title: r.title,
      description: r.description || null,
      brand: r.brand || null,
      model: r.model || null,
      category_raw: r.category_raw || null,
      sub_category_raw: null,
      category_id: null,
      upc: r.upc || null,
      asin: r.asin || null,
      fnsku: r.fnsku || null,
      lpn: r.lpn || null,
      external_code: r.external_code || null,
      pallet_id: null,
      quantity: 1,
      msrp_cents: r.msrp_cents || null,
      // 0063 verification: pass cost_cents so the picker can assert
      // it propagates onto the minted lot at intake. NULL if fixture
      // didn't set one (test that NULL stays NULL on the lot, no
      // accidental zero-coercion).
      cost_cents: r.cost_cents || null,
      starting_bid_cents: null,
      photo_url: null,
      // 0062 verification: keep supplier-vocab raw values here so the
      // normalizer is exercised end-to-end. Picker asserts the lot's
      // resulting condition matches the expected normalized value.
      condition: r.condition || null,
      return_reason: null,
      warehouse_id: ctx.warehouseId,
      status: 'pending',
    }));

    const { value } = await time('supa.insert.import_rows.bulk', () =>
      supa.supaInsertMany(null, 'import_rows', payload, true),
    );
    expect(value.error).toBeNull();
    expect(value.data && value.data.length).toBe(manifestRows.length);
    importRowIds = value.data.map((r) => r.id);
    ctx.importRowIds = importRowIds;
  });

  await step('admin can SELECT own pending manifest rows via RLS', async () => {
    const { value } = await time('supa.select.import_rows.adminToken', () =>
      supa.supaSelect(
        ctx.adminToken,
        'import_rows',
        'import_id=eq.' + importId + '&status=eq.pending',
        'id,title,upc,asin,fnsku,lpn,status',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data && value.data.length).toBe(manifestRows.length);
  });

  // Save references back into ctx so other personas can pick rows.
  // Important: each test pulls a DIFFERENT row so we don't accidentally
  // collide on a row already lotted by an earlier step. The batch test
  // and the ASIN test must not share an underlying row.
  const upcRow = manifestRows.find((r) => r.upc);
  ctx.manifestPickByUpc = upcRow.upc;
  ctx.manifestPickByUpcExpectedCostCents = upcRow.cost_cents || null;
  ctx.manifestPickByUpcExpectedCondition = upcRow.condition;

  const titleOnlyRow = manifestRows.find(
    (r) => !r.upc && !r.asin && !r.fnsku && !r.title.startsWith('CONDNORM-'),
  );
  ctx.manifestPickByTitle = titleOnlyRow ? titleOnlyRow.title : null;
  // The ASIN test takes row[0] of the asin set; the batch FNSKU test
  // needs a *different* row so we use row[1]'s fnsku.
  const asinRows = manifestRows.filter((r) => r.asin);
  ctx.manifestPickByAsin = asinRows[0] ? asinRows[0].asin : null;
  ctx.manifestPickByFnsku = asinRows[1] ? asinRows[1].fnsku : null;

  // 0062 verification: pull the 4 condition-normalization test rows
  // out by title prefix. Picker asserts each ends up with the correct
  // normalized lot.condition after intake.
  ctx.condNormSamples = [
    {
      raw: 'New',
      title: 'CONDNORM-NEW-SEALED-XBOX',
      expected: 'appears_new',
    },
    {
      raw: 'Customer Return',
      title: 'CONDNORM-CUSTOMER-RETURN-IRON',
      expected: 'open_box',
    },
    {
      raw: 'Used',
      title: 'CONDNORM-USED-VACUUM',
      expected: 'good',
    },
    {
      raw: 'Salvage',
      title: 'CONDNORM-SALVAGE-LAPTOP',
      expected: 'as_is',
    },
  ];

  // ── Quick Lot via create_draft_lot RPC ──────────────────────────────
  // Real Quick Lot calls go through createDraftLotFromCandidate (which
  // wraps create_draft_lot RPC). We exercise the RPC directly with
  // fabricated candidates — tests the persistence layer end-to-end.

  await step('Quick Lot mints lot via create_draft_lot RPC', async () => {
    const { value } = await time('rpc.create_draft_lot', () =>
      supa.supaRpc(ctx.adminToken, 'create_draft_lot', {
        p_operator_id: ctx.operatorId,
        p_title: 'Sim Quick Lot 1',
        p_description: 'Created by mega-sim lotter persona',
        p_category: 'Tools',
        p_category_id: null,
        p_condition: 'good',
        p_msrp_cents: 4999,
        p_starting_bid_cents: 100,
        p_photo_urls: [],
        p_external_code: 'SIM-QL-001',
        p_source: 'sim',
      }),
    );
    expect(value.error).toBeNull();
    // Result is .single()-style: { out_id, out_lot_code }
    const row = Array.isArray(value.data) ? value.data[0] : value.data;
    expect(row && row.out_lot_code).toBeTruthy('lot_code returned');
    expect(row.out_lot_code).toMatch(new RegExp('^' + ctx.operatorCode + '-\\d{6}$'));
    ctx.quickLotCode = row.out_lot_code;
    ctx.quickLotId = row.out_id;
  });

  await step('Quick Lot lot lands in pending_intake', async () => {
    const { value } = await time('supa.select.lots.quicklot', () =>
      supa.supaSelect(
        ctx.adminToken,
        'lots',
        'id=eq.' + ctx.quickLotId,
        'id,lot_code,status,external_code,msrp_cents,source',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data && value.data.length).toBe(1);
    expect(value.data[0].status).toBe('pending_intake');
    expect(value.data[0].external_code).toBe('SIM-QL-001');
    expect(value.data[0].source).toBe('sim');
  });

  // ── AI: Photo Scan ──────────────────────────────────────────────────
  if (!noAi) {
    cost.pushTag('lotter.photo-scan');
    await step('AI photo_identify completes (cost tracked)', async () => {
      const dl = require('@auction-platform/domain-lotting');
      // Configure the LLM client with the OpenRouter key.
      if (typeof dl.setLottingConfig === 'function') {
        dl.setLottingConfig({
          openrouterKey: process.env.OPENROUTER_API_KEY || '',
          anthropicKey: process.env.ANTHROPIC_API_KEY || '',
        });
      }
      // Run identifyPhoto only (cheap, vision-only). scanPhoto would
      // also hit Sonar for image enrichment which doubles the cost.
      const b64 = fixtures.getMockPhotoBase64();
      const before = cost.getEvents().length;
      const { value } = await time('ai.identify_photo', () =>
        dl.identifyPhoto(b64, 'image/jpeg'),
      );
      const after = cost.getEvents().length;
      // The call may return null (tiny stub photo can't be identified)
      // — we just want to verify it didn't throw and a cost event landed.
      expect(after - before).toBeGreaterThan(0);
      // Last event should be photo_identify
      const last = cost.getEvents()[after - 1];
      expect(last.task).toBe('photo_identify');
    });

    cost.pushTag('lotter.shelf-scan');
    await step('AI shelf_scan completes (cost tracked)', async () => {
      const dl = require('@auction-platform/domain-lotting');
      const b64 = fixtures.getMockPhotoBase64();
      const before = cost.getEvents().length;
      const { value } = await time('ai.shelf_scan', () =>
        dl.shelfScan(b64, 'image/jpeg'),
      );
      const after = cost.getEvents().length;
      expect(after - before).toBeGreaterThan(0);
      const last = cost.getEvents()[after - 1];
      expect(last.task).toBe('shelf_scan');
      // shelfScan always uses Sonnet — verify cost wiring is right.
      expect(last.model).toMatch(/sonnet/i);
    });
    cost.pushTag(null);
  } else {
    await step('AI photo_identify (skipped — no-ai)', async () => {});
    await step('AI shelf_scan (skipped — no-ai)', async () => {});
  }
}

module.exports = { run };
