// scripts/mega-sim/personas/closer.js
//
// Persona: the system-level "auction closer." In production this is a
// BullMQ delayed job that calls finalize_lot at each lot's close_at.
// In the sim we fast-forward close_at to the past via service-role
// UPDATE, then call finalize_lot directly per lot.
//
// finalize_lot is GRANT EXECUTE TO service_role only — the sim must use
// the service-role-keyed REST call (not a user JWT).
//
// Verifies:
//   • won lots → status='won', winner_bidder_id set, closed_at set
//   • unsold lots → status='unsold', winner_bidder_id NULL, closed_at set
//   • finalize_lot is idempotent (re-call returns already_closed)

'use strict';

const { step, expect, setPhase } = require('../lib/assert');
const { time } = require('../lib/timer');
const supa = require('../lib/supa');

async function run({ ctx }) {
  setPhase('Closer');

  // Prereq check — if upstream phases didn't set up an auction with
  // scenario lots, abort cleanly.
  if (!ctx.auctionId || !ctx.scenarioLots) {
    await step('prereq: auction + scenario lots populated by upstream', async () => {
      expect(false).toBeTruthy('ctx.auctionId or ctx.scenarioLots missing — upstream phase failed');
    });
    return;
  }

  // ── Fast-forward close_at on all auction lots ────────────────────────
  await step('fast-forward close_at on all auction lots to 1s ago', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const { value } = await time('supa.update.lots.fastForwardClose', () =>
      supa.supaUpdate(
        null,
        'lots',
        'auction_id=eq.' + ctx.auctionId,
        { close_at: past },
        true,
      ),
    );
    expect(value.error).toBeNull();
  });

  // ── Pull every lot in the auction ────────────────────────────────────
  let lots = [];
  await step('list auction lots for finalize loop', async () => {
    const { value } = await time('supa.select.lots.toClose', () =>
      supa.supaSelect(
        null,
        'lots',
        'auction_id=eq.' + ctx.auctionId,
        'id,lot_code,status,current_bid_cents,winner_bidder_id',
        true,
      ),
    );
    expect(value.error).toBeNull();
    lots = value.data;
    expect(lots.length).toBeGreaterThan(0);
  });

  // ── Call finalize_lot per lot (service-role) ─────────────────────────
  const closeResults = [];
  await step('finalize_lot for each lot (service-role)', async () => {
    for (const lot of lots) {
      const { value } = await time('rpc.finalize_lot', () =>
        supa.supaRpc(null, 'finalize_lot', { p_lot_id: lot.id }, true),
      );
      expect(value.error).toBeNull();
      // finalize_lot returns a composite — Supabase REST returns the
      // composite as either a single object or an array of one. Normalize.
      const row = Array.isArray(value.data) ? value.data[0] : value.data;
      expect(row).toBeTruthy('finalize_lot returned a row');
      closeResults.push({ lotId: lot.id, lotCode: lot.lot_code, result: row });
    }
    // The sim wants all of these to be won/unsold (NOT reschedule —
    // we fast-forwarded close_at). Reschedule means soft-close kept
    // pushing close_at back, which shouldn't happen since the bids
    // landed long before now() exceeded close_at.
    for (const r of closeResults) {
      expect(['won', 'unsold']).toContain(r.result.reason);
    }
  });

  // ── Idempotency: re-call finalize_lot on a won lot ──────────────────
  await step('finalize_lot is idempotent (re-call returns already_closed)', async () => {
    const wonResult = closeResults.find((r) => r.result.reason === 'won');
    expect(wonResult).toBeTruthy('at least one won lot');
    const { value } = await time('rpc.finalize_lot.idempotent', () =>
      supa.supaRpc(null, 'finalize_lot', { p_lot_id: wonResult.lotId }, true),
    );
    expect(value.error).toBeNull();
    const row = Array.isArray(value.data) ? value.data[0] : value.data;
    expect(row.reason).toBe('already_closed');
  });

  // ── Verify final lot states ──────────────────────────────────────────
  await step('final state: won lots have winner_bidder_id + status=won', async () => {
    const { value } = await time('supa.select.lots.finalState', () =>
      supa.supaSelect(
        ctx.adminToken,
        'lots',
        'auction_id=eq.' + ctx.auctionId,
        'id,lot_code,status,current_bid_cents,winner_bidder_id,closed_at',
      ),
    );
    expect(value.error).toBeNull();

    let wonCount = 0;
    let unsoldCount = 0;
    for (const l of value.data) {
      expect(['won', 'unsold']).toContain(l.status);
      expect(l.closed_at).toBeTruthy(l.lot_code + ' closed_at set');

      if (l.status === 'won') {
        expect(l.winner_bidder_id).toBeTruthy(l.lot_code + ' winner set');
        expect(l.current_bid_cents).toBeGreaterThan(0);
        wonCount += 1;
      } else {
        expect(l.winner_bidder_id).toBeNull();
        unsoldCount += 1;
      }
    }
    console.log('      [closer] won=' + wonCount + ' unsold=' + unsoldCount);
    // We bid on 3 lots → 3 won; the 4th was unsold by design.
    expect(wonCount).toBeGreaterThan(0);
    expect(unsoldCount).toBeGreaterThan(0);

    ctx.finalLotStates = value.data;
  });

  // ── Verify scenario outcomes specifically ────────────────────────────
  await step('Bidder A won twoWay; C won cSweep + soloWin (if soft-close test ran)', async () => {
    const byId = {};
    for (const l of ctx.finalLotStates) byId[l.id] = l;

    // soloWin's winner is normally A (A bid $5 solo), but the bidders
    // persona's soft-close test re-bids on soloWin with C at $50 to
    // verify close_at extension. ctx.scenarioLots.soloWinWinnerUserId
    // is set by that step when it runs; absent = A still wins.
    const solo = byId[ctx.scenarioLots.soloWin.lot_id];
    expect(solo.status).toBe('won');
    const expectedSoloWinner =
      ctx.scenarioLots.soloWinWinnerUserId || ctx.bidders.A.userId;
    expect(solo.winner_bidder_id).toBe(expectedSoloWinner);

    const twoWay = byId[ctx.scenarioLots.twoWayWin.lot_id];
    expect(twoWay.status).toBe('won');
    expect(twoWay.winner_bidder_id).toBe(ctx.bidders.A.userId);

    const cSweep = byId[ctx.scenarioLots.cSweep.lot_id];
    expect(cSweep.status).toBe('won');
    expect(cSweep.winner_bidder_id).toBe(ctx.bidders.C.userId);

    // The originally-unsold lot may have been bid on by the same-bidder
    // raises-own-max test; bidders.js moves the scenarioLots.unsold
    // pointer if so. NULL = no spare lot was available to take the role.
    if (ctx.scenarioLots.unsold) {
      const unsold = byId[ctx.scenarioLots.unsold.lot_id];
      expect(unsold.status).toBe('unsold');
      expect(unsold.winner_bidder_id).toBeNull();
    }
  });
}

module.exports = { run };
