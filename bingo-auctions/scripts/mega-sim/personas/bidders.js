// scripts/mega-sim/personas/bidders.js
//
// Persona: three bidders walking through realistic bid scenarios.
//
//   Bidder A — wins one outright, gets outbid on another, wins via proxy on a third
//   Bidder B — outbids A on one lot, gets outbid by A's proxy on another
//   Bidder C — single sweep on an unconvested lot
//
// Lot 4 (or last) — intentionally left bidless so the closer can
// finalize it as 'unsold' and we exercise that branch.
//
// Each bidder gets a real Supabase auth user + a bidders row keyed by
// auth.users.id. place_bid is called via that bidder's JWT — same
// permission boundary the production app hits.

'use strict';

const { step, expect, setPhase } = require('../lib/assert');
const { time } = require('../lib/timer');
const supa = require('../lib/supa');

async function setupBidder(label, ts) {
  const email = 'sim-bidder-' + label.toLowerCase() + '-' + ts + '@example.com';
  const password = 'BidPass!' + ts + 'xyz';

  const { value: authUser } = await time('supa.admin.createUser.bidder.' + label, () =>
    supa.adminCreateUser({
      email,
      password,
      userMetadata: { sim: true, role: 'bidder', label },
    }),
  );
  const userId = authUser.userId;

  // bidders row keyed by auth.users.id.
  // birth_date is required since migration 0082 (§2.3 age verification).
  // Use 1990-01-01 — comfortably > 18, also unambiguously a sim fixture.
  const { value: bidderRes } = await time('supa.insert.bidders.' + label, () =>
    supa.supaInsert(
      null,
      'bidders',
      {
        id: userId,
        email,
        display_name: 'Sim Bidder ' + label,
        birth_date: '1990-01-01',
      },
      true,
    ),
  );
  expect(bidderRes.error).toBeNull();

  const { value: signIn } = await time('supa.signIn.bidder.' + label, () =>
    supa.signInWithPassword(email, password),
  );
  expect(signIn.token).toBeTruthy(label + ' token');
  return { email, password, userId, token: signIn.token, label };
}

async function run({ ctx }) {
  setPhase('Bidders');

  // Prereq check — if auctioneer failed to assign lots, abort cleanly
  // rather than crashing further down. Records a clear failure that
  // points the user at the upstream issue.
  if (!ctx.assignedLots || ctx.assignedLots.length === 0) {
    await step('prereq: auctioneer assigned lots to auction', async () => {
      expect(false).toBeTruthy('ctx.assignedLots missing — auctioneer phase likely failed');
    });
    return;
  }

  const ts = Date.now().toString().slice(-8);
  ctx.bidders = {};

  await step('create + sign in bidder A', async () => {
    ctx.bidders.A = await setupBidder('A', ts);
  });
  await step('create + sign in bidder B', async () => {
    ctx.bidders.B = await setupBidder('B', ts);
  });
  await step('create + sign in bidder C', async () => {
    ctx.bidders.C = await setupBidder('C', ts);
  });

  // ── Sanity: bidder can SELECT a scheduled lot via RLS ───────────────
  await step('bidder A can SELECT scheduled lots in the auction (RLS)', async () => {
    const { value } = await time('supa.select.lots.bidderToken', () =>
      supa.supaSelect(
        ctx.bidders.A.token,
        'lots',
        'auction_id=eq.' + ctx.auctionId,
        'id,lot_code,status,current_bid_cents,starting_bid_cents',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data.length).toBe(ctx.assignedLots.length);
    // Every lot should be 'scheduled' (no bids yet).
    for (const l of value.data) {
      expect(['scheduled', 'live']).toContain(l.status);
    }
  });

  // Pin lot references for the scenarios.
  // We have ~5 in_inventory lots → 5 in this auction. Use first 4 + leave
  // any extras bidless to be unsold too.
  const lots = ctx.assignedLots.slice().sort((a, b) => a.lot_number - b.lot_number);
  ctx.scenarioLots = {
    soloWin: lots[0],       // A bids low, no one else → A wins
    twoWayWin: lots[1],     // A then B then A → A's proxy wins
    cSweep: lots[2],        // C bids high, no one else → C wins
    unsold: lots[3] || lots[lots.length - 1], // no bids → unsold
  };
  ctx.unsoldLotId = ctx.scenarioLots.unsold.lot_id;

  // ── Scenario 1: solo win ─────────────────────────────────────────────
  await step('A places first bid → flips lot scheduled→live, A leads', async () => {
    const lotId = ctx.scenarioLots.soloWin.lot_id;
    const { value } = await time('rpc.place_bid.A.solo', () =>
      supa.supaRpc(ctx.bidders.A.token, 'place_bid', {
        p_lot_id: lotId,
        p_max_amount_cents: 500, // $5 cap
      }),
    );
    expect(value.error).toBeNull();
    expect(value.data.ok).toBe(true);
    expect(value.data.current_leader_id).toBe(ctx.bidders.A.userId);
    expect(value.data.current_bid_cents).toBeGreaterThan(0);
  });

  await step('soloWin lot is now status=live, A leads', async () => {
    const { value } = await time('supa.select.lots.soloWin', () =>
      supa.supaSelect(
        ctx.adminToken,
        'lots',
        'id=eq.' + ctx.scenarioLots.soloWin.lot_id,
        'status,current_bid_cents,winner_bidder_id,bid_count',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data[0].status).toBe('live');
    expect(value.data[0].bid_count).toBeGreaterThan(0);
  });

  // ── Scenario 2: two-way proxy ────────────────────────────────────────
  await step('A places proxy max $20 on twoWay lot', async () => {
    const { value } = await time('rpc.place_bid.A.twoway-initial', () =>
      supa.supaRpc(ctx.bidders.A.token, 'place_bid', {
        p_lot_id: ctx.scenarioLots.twoWayWin.lot_id,
        p_max_amount_cents: 2000, // $20
      }),
    );
    expect(value.error).toBeNull();
    expect(value.data.ok).toBe(true);
    expect(value.data.current_leader_id).toBe(ctx.bidders.A.userId);
  });

  await step('B bids $10 — A\'s proxy escalates, A keeps lead', async () => {
    const { value } = await time('rpc.place_bid.B.twoway-outbid', () =>
      supa.supaRpc(ctx.bidders.B.token, 'place_bid', {
        p_lot_id: ctx.scenarioLots.twoWayWin.lot_id,
        p_max_amount_cents: 1000, // $10 — below A's hidden max
      }),
    );
    expect(value.error).toBeNull();
    expect(value.data.ok).toBe(true);
    // A should still lead (proxy auto-bids).
    expect(value.data.current_leader_id).toBe(ctx.bidders.A.userId);
    // The auto-bid increment should push the current bid above B's max.
    expect(value.data.current_bid_cents).toBeGreaterThan(1000);
  });

  // ── Scenario 3: C sweep ──────────────────────────────────────────────
  await step('C bids $50 on cSweep lot, no one else', async () => {
    const { value } = await time('rpc.place_bid.C.sweep', () =>
      supa.supaRpc(ctx.bidders.C.token, 'place_bid', {
        p_lot_id: ctx.scenarioLots.cSweep.lot_id,
        p_max_amount_cents: 5000, // $50
      }),
    );
    expect(value.error).toBeNull();
    expect(value.data.ok).toBe(true);
    expect(value.data.current_leader_id).toBe(ctx.bidders.C.userId);
  });

  // ── Same-bidder-raises-own-max ───────────────────────────────────────
  // Audit-flagged gap: a bidder who is already leading can raise their
  // own maximum without anyone else bidding. The place_bid RPC path
  // for this (0003_place_bid_fn.sql:139-143) is real production code
  // that was previously untested.
  //
  // Scenario: A bids $20 max on a NEW lot (not soloWin/twoWay/cSweep —
  // we reuse the unsold lot since it's bidless). Then A bids $30 max.
  // Verify A still leads, bid_count incremented (twice for the two
  // place_bid calls plus any auto-bids), and current_bid_cents
  // tracks the max-vs-second-max increment ladder.
  await step('same bidder raising own max keeps lead + updates max', async () => {
    const lotId = ctx.scenarioLots.unsold.lot_id;

    // First bid: A places $20 max as the only bidder. current_bid
    // lands at the starting bid (typically $1) since there's no
    // competition to push it up.
    const { value: r1 } = await time('rpc.place_bid.A.ownmax-first', () =>
      supa.supaRpc(ctx.bidders.A.token, 'place_bid', {
        p_lot_id: lotId,
        p_max_amount_cents: 2000,
      }),
    );
    expect(r1.error).toBeNull();
    expect(r1.data.ok).toBe(true);
    expect(r1.data.current_leader_id).toBe(ctx.bidders.A.userId);
    const firstBidCents = r1.data.current_bid_cents;

    // Second bid: A raises their OWN max to $30. With no opposing
    // bidder, current_bid stays at firstBidCents (no auto-bid fires
    // — see 0003's "leader keeps lead at min(their_max, new_max +
    // increment)" branch). The MAX on the bids row is what gets
    // updated, not the current price.
    const { value: r2 } = await time('rpc.place_bid.A.ownmax-raise', () =>
      supa.supaRpc(ctx.bidders.A.token, 'place_bid', {
        p_lot_id: lotId,
        p_max_amount_cents: 3000,
      }),
    );
    expect(r2.error).toBeNull();
    expect(r2.data.ok).toBe(true);
    expect(r2.data.current_leader_id).toBe(ctx.bidders.A.userId);
    // current_bid did not jump just because the leader raised their
    // own max — no opposing bidder pushed it. Sanity-check that it
    // stayed at the first-bid value (or matched the new max if the
    // RPC chose to surface it; both are reasonable interpretations
    // of the proxy contract, but the test documents the actual one).
    expect(r2.data.current_bid_cents).toBe(firstBidCents);

    // The unsold lot is now bid-on, so the closer's expectation that
    // it ends "unsold" will fail. Re-map scenarioLots so closer sees
    // a different lot as unsold. The auction has more lots than the
    // 4 named scenarios; pick another.
    // CTX MUTATION: closer.js reads ctx.scenarioLots.unsold to assert
    // it ends unsold. Move that pointer to a lot we know we won't bid
    // on. The original `assignedLots` array has every lot from the
    // auction; pick the highest lot_number that's not in any scenario.
    const usedIds = new Set([
      ctx.scenarioLots.soloWin.lot_id,
      ctx.scenarioLots.twoWayWin.lot_id,
      ctx.scenarioLots.cSweep.lot_id,
      ctx.scenarioLots.unsold.lot_id, // the OLD unsold, now bid on by A
    ]);
    const freshUnsold = ctx.assignedLots.find((l) => !usedIds.has(l.lot_id));
    if (freshUnsold) {
      ctx.scenarioLots.unsold = freshUnsold;
      ctx.unsoldLotId = freshUnsold.lot_id;
      // The freshUnsold lot inherits scenario role: stays bidless,
      // closer expects it to finalize as 'unsold'.
    } else {
      // Auction didn't have a spare lot — closer will need to skip the
      // unsold-specific assertion. Flag it so closer can adapt.
      ctx.scenarioLots.unsold = null;
      ctx.unsoldLotId = null;
    }
  });

  // ── Soft-close: bidding near close_at extends the close window ──────
  // Audit-flagged gap: 0003_place_bid_fn.sql:197-201 implements
  // soft-close by setting close_at = now() + soft_close_minutes when
  // a bid lands within that window. Previously untested in mega-sim.
  //
  // We fast-forward the soloWin lot's close_at to 30 seconds from now,
  // then have C bid on it. soft_close_minutes was set to 1 by the
  // auctioneer persona (line 60 of auctioneer.js), so the post-bid
  // close_at should be ~60 seconds from now — a clear push-forward.
  await step('soft-close extends close_at when bid lands in the window', async () => {
    const lotId = ctx.scenarioLots.soloWin.lot_id;

    // Read current close_at before fast-forward.
    const { value: before } = await time('supa.select.lots.softCloseBefore', () =>
      supa.supaSelect(ctx.adminToken, 'lots', 'id=eq.' + lotId, 'close_at'),
    );
    expect(before.error).toBeNull();

    // Fast-forward close_at to 30s from now (within the 60s soft-close
    // window). Service-role write — bypasses RLS.
    const nearClose = new Date(Date.now() + 30 * 1000).toISOString();
    const { value: ff } = await time('supa.update.lots.softCloseFastFwd', () =>
      supa.supaUpdate(null, 'lots', 'id=eq.' + lotId, { close_at: nearClose }, true),
    );
    expect(ff.error).toBeNull();

    // C bids. soloWin's current leader is A; C's bid should extend
    // close_at AND outbid A (since A's max was only $5 and C bids $50,
    // C now leads).
    const { value: bid } = await time('rpc.place_bid.C.softCloseTrigger', () =>
      supa.supaRpc(ctx.bidders.C.token, 'place_bid', {
        p_lot_id: lotId,
        p_max_amount_cents: 5000,
      }),
    );
    expect(bid.error).toBeNull();
    expect(bid.data.ok).toBe(true);
    expect(bid.data.was_extended).toBe(true);

    // Verify the new close_at is well past `nearClose` — at least 30s
    // later. (soft_close_minutes=1 = 60s; close_at should be ~now+60s.)
    const { value: after } = await time('supa.select.lots.softCloseAfter', () =>
      supa.supaSelect(ctx.adminToken, 'lots', 'id=eq.' + lotId, 'close_at'),
    );
    expect(after.error).toBeNull();
    const newCloseMs = new Date(after.data[0].close_at).getTime();
    const oldFFMs = new Date(nearClose).getTime();
    // New close_at should be at least 25s later than the fast-forward.
    expect(newCloseMs - oldFFMs > 25 * 1000).toBe(true);

    // Soft-close changed scenarioLots.soloWin's winner from A → C.
    // Update so closer.js's final assertions match reality.
    ctx.scenarioLots.soloWinWinnerUserId = ctx.bidders.C.userId;
  });

  // ── Negative: B tries to bid below current with proxy ────────────────
  await step('B bidding below A\'s proxy on twoWay returns ok (rolled into proxy) or below_min_increment', async () => {
    // B bids $1 — below the starting bid in some cases, or below min
    // increment depending on current price. Server returns failure with
    // a specific reason; we just want to confirm it returns cleanly.
    const { value } = await time('rpc.place_bid.B.too-low', () =>
      supa.supaRpc(ctx.bidders.B.token, 'place_bid', {
        p_lot_id: ctx.scenarioLots.twoWayWin.lot_id,
        p_max_amount_cents: 100,
      }),
    );
    expect(value.error).toBeNull();
    expect(typeof value.data.ok).toBe('boolean');
    // Either ok:false with below_* reason OR ok:true but A still leads.
    if (!value.data.ok) {
      expect(['below_starting_bid', 'below_min_increment']).toContain(value.data.reason);
    } else {
      expect(value.data.current_leader_id).toBe(ctx.bidders.A.userId);
    }
  });

  // ── Verification snapshot before close ───────────────────────────────
  await step('snapshot: each contested lot has a leader, unsold has none', async () => {
    const { value } = await time('supa.select.lots.preCloseSnapshot', () =>
      supa.supaSelect(
        ctx.adminToken,
        'lots',
        'auction_id=eq.' + ctx.auctionId,
        'id,lot_code,status,current_bid_cents,winner_bidder_id,bid_count',
      ),
    );
    expect(value.error).toBeNull();

    const byId = {};
    for (const l of value.data) byId[l.id] = l;

    // soloWin: A bid first, then C outbid A in the soft-close test
    // above. ctx.scenarioLots.soloWinWinnerUserId is set when the
    // soft-close path ran; absent = A still leads.
    const solo = byId[ctx.scenarioLots.soloWin.lot_id];
    const expectedSoloLeader =
      ctx.scenarioLots.soloWinWinnerUserId || ctx.bidders.A.userId;
    expect(solo && solo.winner_bidder_id).toBe(expectedSoloLeader);

    const twoWay = byId[ctx.scenarioLots.twoWayWin.lot_id];
    expect(twoWay && twoWay.winner_bidder_id).toBe(ctx.bidders.A.userId);
    expect(twoWay.bid_count).toBeGreaterThan(1);

    const cSweep = byId[ctx.scenarioLots.cSweep.lot_id];
    expect(cSweep && cSweep.winner_bidder_id).toBe(ctx.bidders.C.userId);

    // Unsold pointer may have been rerouted to a different bidless
    // lot when the same-bidder-raises-own-max test took the original.
    // NULL = no spare lot was available (auction only had the 4
    // scenario lots) — skip the assertion in that case.
    if (ctx.scenarioLots.unsold) {
      const unsold = byId[ctx.scenarioLots.unsold.lot_id];
      expect(unsold && unsold.winner_bidder_id).toBeNull();
      expect(unsold.bid_count).toBe(0);
    }
  });
}

module.exports = { run };
