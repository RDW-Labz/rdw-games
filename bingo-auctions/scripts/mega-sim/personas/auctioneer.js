// scripts/mega-sim/personas/auctioneer.js
//
// Persona: operator-admin doing auction setup. Creates an auction
// row, then calls assign_lots_to_auction to pull every in_inventory
// lot the picker left behind into it. After this runs the lots have:
//   • status = 'scheduled'
//   • auction_id, lot_number, close_at populated
//
// Doesn't actually transition auctions.status past 'scheduled' —
// per the audit, nothing in the codebase ever sets auctions.status
// to 'live' or 'closed'. Individual lots transition lot-by-lot.

'use strict';

const { step, expect, setPhase } = require('../lib/assert');
const { time } = require('../lib/timer');
const supa = require('../lib/supa');

async function run({ ctx }) {
  setPhase('Auctioneer');

  // ── Collect in_inventory lots the picker left behind ─────────────────
  await step('collect in_inventory lots from picker phase', async () => {
    const { value } = await time('supa.select.lots.in_inventory', () =>
      supa.supaSelect(
        ctx.adminToken,
        'lots',
        'operator_id=eq.' + ctx.operatorId +
          '&status=eq.in_inventory' +
          '&auction_id=is.null' +
          '&deleted_at=is.null',
        'id,lot_code,title,msrp_cents',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data.length).toBeGreaterThan(0);
    ctx.lotsForAuction = value.data;
    console.log('      [auctioneer] found ' + value.data.length + ' in_inventory lots');
  });

  // ── Create auction row ───────────────────────────────────────────────
  // starts_at: 1 minute in the future (sim doesn't wait — bids work
  //   against scheduled lots, place_bid flips first lot to 'live').
  // ends_at: 60 minutes in the future — gives bidders an unambiguous
  //   "open" window. Closer fast-forwards this to the past before
  //   calling finalize_lot.
  // pickup_starts_at: ends_at + 1 day. Must be >= ends_at per CHECK.
  // pickup_ends_at: pickup_starts_at + 3 days.
  await step('create auction (draft → manual UPDATE to scheduled)', async () => {
    const now = Date.now();
    const startsAt = new Date(now + 60 * 1000).toISOString();
    const endsAt = new Date(now + 60 * 60 * 1000).toISOString();
    const pickupStartsAt = new Date(now + 25 * 60 * 60 * 1000).toISOString();
    const pickupEndsAt = new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString();

    const { value: insertVal } = await time('supa.insert.auctions', () =>
      supa.supaInsert(
        null,
        'auctions',
        {
          operator_id: ctx.operatorId,
          warehouse_id: ctx.warehouseId,
          title: 'Sim Auction ' + ctx.operatorCode,
          description: 'Mega-sim Phase 2A auction.',
          status: 'draft',
          starts_at: startsAt,
          ends_at: endsAt,
          pickup_starts_at: pickupStartsAt,
          pickup_ends_at: pickupEndsAt,
          soft_close_minutes: 1, // shorten so sim bids near close are observable
          buyer_premium_bps: 1500,
          close_stagger_seconds: 0, // all lots close at the same time
        },
        true,
      ),
    );
    expect(insertVal.error).toBeNull();
    expect(insertVal.data && insertVal.data.id).toBeTruthy('auction created');
    ctx.auctionId = insertVal.data.id;
    ctx.auctionEndsAt = endsAt;

    // Flip to 'scheduled' — operator-web's scheduleAuction() does this
    // via a plain UPDATE (no RPC). Then assign_lots_to_auction is
    // happy to run.
    const { value: updateVal } = await time('supa.update.auctions.scheduled', () =>
      supa.supaUpdate(
        null,
        'auctions',
        'id=eq.' + ctx.auctionId,
        { status: 'scheduled' },
        true,
      ),
    );
    expect(updateVal.error).toBeNull();
  });

  // ── Assign lots to auction ───────────────────────────────────────────
  await step('assign_lots_to_auction populates lot_number + close_at', async () => {
    const lotIds = ctx.lotsForAuction.map((l) => l.id);
    const { value } = await time('rpc.assign_lots_to_auction', () =>
      supa.supaRpc(ctx.adminToken, 'assign_lots_to_auction', {
        p_auction_id: ctx.auctionId,
        p_lot_ids: lotIds,
      }),
    );
    expect(value.error).toBeNull();
    expect(Array.isArray(value.data)).toBe(true);
    expect(value.data.length).toBe(lotIds.length);
    // Each row has lot_id, lot_code, lot_number, close_at.
    for (const r of value.data) {
      expect(r.lot_number).toBeGreaterThan(0);
      expect(r.close_at).toBeTruthy('close_at set per lot');
    }
    ctx.assignedLots = value.data;
  });

  // ── close_stagger_seconds=0 → every close_at == ends_at ──────────────
  // Verifies the stagger math from 0030/0060 (v_close_at = v_ends_at +
  // make_interval(secs => v_stagger * (lot_number - 1))). With stagger=0
  // the second term zeroes out and every lot closes simultaneously.
  await step('close_stagger_seconds=0 → all close_at == ends_at (stagger math, baseline)', async () => {
    const endsMs = new Date(ctx.auctionEndsAt).getTime();
    for (const r of ctx.assignedLots) {
      const closeMs = new Date(r.close_at).getTime();
      const drift = Math.abs(closeMs - endsMs);
      expect(drift < 1000).toBe(true);
    }
  });

  // ── Verify lots now in scheduled status ──────────────────────────────
  await step('assigned lots transitioned to status=scheduled', async () => {
    const { value } = await time('supa.select.lots.scheduled', () =>
      supa.supaSelect(
        ctx.adminToken,
        'lots',
        'auction_id=eq.' + ctx.auctionId,
        'id,lot_code,status,lot_number,close_at',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data.length).toBe(ctx.lotsForAuction.length);
    for (const l of value.data) {
      expect(l.status).toBe('scheduled');
      expect(l.lot_number).toBeGreaterThan(0);
    }
  });

  // ── Duplicate-assign should fail ─────────────────────────────────────
  // assign_lots_to_auction raises 'lot_already_in_auction:<code>' when
  // a lot is re-submitted. Verify the guard works as a regression test.
  await step('re-assigning already-assigned lot is rejected', async () => {
    const { value } = await time('rpc.assign_lots_to_auction.duplicate', () =>
      supa.supaRpc(ctx.adminToken, 'assign_lots_to_auction', {
        p_auction_id: ctx.auctionId,
        p_lot_ids: [ctx.lotsForAuction[0].id],
      }),
    );
    // Expect an error from the PostgREST envelope.
    expect(value.error).toBeTruthy('duplicate-assignment errors');
    const msg = JSON.stringify(value.error);
    expect(/lot_already_in_auction/.test(msg)).toBe(true);
  });

  // ── Audit gap #8: warehouse mismatch ────────────────────────────────
  // assign_lots_to_auction raises 'lot_wrong_warehouse:<code>' when
  // a lot's warehouse_id doesn't match the auction's warehouse_id.
  // Build a second warehouse, mint a lot in it via create_draft_lot
  // (status='pending_intake' → intake into a bin in the second
  // warehouse → status='in_inventory'), then try to assign it to the
  // first auction (which is on warehouse #1).
  let secondWarehouseId = null;
  let mismatchLotId = null;
  let mismatchLotCode = null;

  await step('mint a second warehouse + bin for mismatch test', async () => {
    const { value: whRes } = await time('supa.insert.warehouses.mismatch', () =>
      supa.supaInsert(
        null,
        'warehouses',
        {
          operator_id: ctx.operatorId,
          name: 'Sim Mismatch Warehouse',
          address_line1: '2 Sim Way',
          city: 'Simtown',
          state: 'OH',
          postal_code: '45000',
          country: 'US',
          timezone: 'America/New_York',
        },
        true,
      ),
    );
    expect(whRes.error).toBeNull();
    secondWarehouseId = whRes.data.id;

    const { value: binRes } = await time('supa.insert.bins.mismatch', () =>
      supa.supaInsert(
        null,
        'bins',
        {
          warehouse_id: secondWarehouseId,
          code: 'MISMATCH-01',
          aisle: 'M',
          x_px: 100,
          y_px: 100,
          is_active: true,
        },
        true,
      ),
    );
    expect(binRes.error).toBeNull();
    ctx.mismatchBin = binRes.data;
  });

  await step('mint a lot in the second warehouse', async () => {
    const { value: lotRes } = await time('rpc.create_draft_lot.mismatch', () =>
      supa.supaRpc(ctx.adminToken, 'create_draft_lot', {
        p_operator_id: ctx.operatorId,
        p_title: 'Sim mismatch lot',
        p_description: null,
        p_category: null,
        p_category_id: null,
        p_condition: 'good',
        p_msrp_cents: 999,
        p_starting_bid_cents: 100,
        p_photo_urls: [],
        p_external_code: 'SIM-MISMATCH-' + Date.now(),
        p_source: 'sim',
      }),
    );
    expect(lotRes.error).toBeNull();
    const row = Array.isArray(lotRes.data) ? lotRes.data[0] : lotRes.data;
    expect(row && row.out_lot_id || row.out_id).toBeTruthy('mismatch lot minted');
    mismatchLotId = row.out_id;
    mismatchLotCode = row.out_lot_code;

    // Intake it into the SECOND warehouse so it gets warehouse_id set
    // properly. The intake RPC pulls warehouse_id from the bin.
    const { value: intake } = await time('rpc.intake.mismatchLot', () =>
      supa.supaRpc(ctx.pickerToken, 'intake_lot_to_bin', {
        p_lot_identifier: mismatchLotCode,
        p_bin_qr_token: ctx.mismatchBin.qr_token,
      }),
    );
    expect(intake.error).toBeNull();
    expect(intake.data.ok).toBe(true);
    expect(intake.data.reason).toBe('ok');
  });

  await step('assign_lots_to_auction rejects lot_wrong_warehouse', async () => {
    // ctx.auctionId's warehouse is ctx.warehouseId (first warehouse).
    // mismatchLotId is in secondWarehouseId. Should raise
    // 'lot_wrong_warehouse:<lot_code>'.
    const { value } = await time('rpc.assign_lots_to_auction.wrongWarehouse', () =>
      supa.supaRpc(ctx.adminToken, 'assign_lots_to_auction', {
        p_auction_id: ctx.auctionId,
        p_lot_ids: [mismatchLotId],
      }),
    );
    expect(value.error).toBeTruthy('wrong-warehouse rejection');
    const msg = JSON.stringify(value.error);
    expect(/lot_wrong_warehouse/.test(msg)).toBe(true);
  });

  // ── Audit gap: non-in_inventory rejection ───────────────────────────
  // assign_lots_to_auction also raises lot_not_in_inventory:<code>:<status>
  // when a lot isn't yet intaken (status='pending_intake'). Mint a
  // fresh field-lotted lot, leave it pending_intake (no bin scan),
  // and verify the rejection.
  let pendingLotId = null;
  await step('mint a pending_intake lot to test status guard', async () => {
    const { value: lotRes } = await time('rpc.create_draft_lot.statusGuard', () =>
      supa.supaRpc(ctx.adminToken, 'create_draft_lot', {
        p_operator_id: ctx.operatorId,
        p_title: 'Sim pending-only lot',
        p_description: null,
        p_category: null,
        p_category_id: null,
        p_condition: 'good',
        p_msrp_cents: 999,
        p_starting_bid_cents: 100,
        p_photo_urls: [],
        p_external_code: 'SIM-PENDING-' + Date.now(),
        p_source: 'sim',
      }),
    );
    expect(lotRes.error).toBeNull();
    const row = Array.isArray(lotRes.data) ? lotRes.data[0] : lotRes.data;
    pendingLotId = row.out_id;
  });

  await step('assign_lots_to_auction rejects pending_intake lots', async () => {
    const { value } = await time('rpc.assign_lots_to_auction.notInInventory', () =>
      supa.supaRpc(ctx.adminToken, 'assign_lots_to_auction', {
        p_auction_id: ctx.auctionId,
        p_lot_ids: [pendingLotId],
      }),
    );
    expect(value.error).toBeTruthy('non-in_inventory rejection');
    const msg = JSON.stringify(value.error);
    expect(/lot_not_in_inventory/.test(msg)).toBe(true);
  });

  // ── close_stagger_seconds>0 end-to-end test ─────────────────────────
  // Audit flagged "close_stagger_seconds may not be consumed." Reality:
  // it IS wired in assign_lots_to_auction (0030/0060 line: v_close_at =
  // v_ends_at + make_interval(secs => v_stagger * (lot_number - 1))).
  // This test proves it stays wired by mutating the auction's stagger
  // to 5s, minting + intaking 2 lots, assigning them, and verifying
  // the close_at delta is exactly 5 seconds.
  //
  // Note: these 2 extra lots get rolled into ctx.auctionId so closer
  // closes them along with everything else. They have no bids → unsold
  // (closer's wonCount>0 / unsoldCount>0 assertions stay green; the
  // specific scenarioLots assertions don't reference these lots).
  let staggerLotIds = [];
  await step('mutate auction stagger to 5s + mint 2 fresh lots to assign', async () => {
    const { value: updateVal } = await time('supa.update.auctions.stagger', () =>
      supa.supaUpdate(
        null,
        'auctions',
        'id=eq.' + ctx.auctionId,
        { close_stagger_seconds: 5 },
        true,
      ),
    );
    expect(updateVal.error).toBeNull();

    // Mint 2 lots
    const minted = [];
    for (let i = 0; i < 2; i += 1) {
      const { value: lotRes } = await time('rpc.create_draft_lot.staggerTest', () =>
        supa.supaRpc(ctx.adminToken, 'create_draft_lot', {
          p_operator_id: ctx.operatorId,
          p_title: 'Sim stagger test lot ' + (i + 1),
          p_description: null,
          p_category: null,
          p_category_id: null,
          p_condition: 'good',
          p_msrp_cents: 999,
          p_starting_bid_cents: 100,
          p_photo_urls: [],
          p_external_code: 'SIM-STAGGER-' + Date.now() + '-' + i,
          p_source: 'sim',
        }),
      );
      expect(lotRes.error).toBeNull();
      const row = Array.isArray(lotRes.data) ? lotRes.data[0] : lotRes.data;
      minted.push({ id: row.out_id, lot_code: row.out_lot_code });
    }

    // Intake both into binA1 (binA2's token was rotated in picker test).
    for (const lot of minted) {
      const { value: intake } = await time('rpc.intake.staggerTest', () =>
        supa.supaRpc(ctx.pickerToken, 'intake_lot_to_bin', {
          p_lot_identifier: lot.lot_code,
          p_bin_qr_token: ctx.bins[0].qr_token,
        }),
      );
      expect(intake.error).toBeNull();
      expect(intake.data.ok).toBe(true);
    }
    staggerLotIds = minted.map((l) => l.id);
  });

  await step('assign 2 lots → close_at delta is exactly 5 seconds', async () => {
    const { value } = await time('rpc.assign_lots_to_auction.stagger', () =>
      supa.supaRpc(ctx.adminToken, 'assign_lots_to_auction', {
        p_auction_id: ctx.auctionId,
        p_lot_ids: staggerLotIds,
      }),
    );
    expect(value.error).toBeNull();
    expect(value.data.length).toBe(2);

    // Sort by lot_number to compare consecutive close_at values.
    const rows = value.data.slice().sort((a, b) => a.lot_number - b.lot_number);
    const t0 = new Date(rows[0].close_at).getTime();
    const t1 = new Date(rows[1].close_at).getTime();
    const deltaMs = t1 - t0;
    expect(deltaMs).toBe(5000); // exactly 5s

    // Append to ctx.assignedLots so downstream personas (bidders RLS
    // count, closer assertions) see the new lots as part of the auction.
    for (const r of value.data) ctx.assignedLots.push(r);
  });
}

module.exports = { run };
