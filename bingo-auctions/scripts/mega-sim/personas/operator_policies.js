// scripts/mega-sim/personas/operator_policies.js
//
// Persona: operator T&C versioning + bidder consent flow.
//
// Steps:
//   1. Verify operator got a default v1 published policy (migration 0088 seed)
//   2. Read it via get_active_operator_policy() RPC
//   3. Verify v1 fields: payment_window_hours=0, pickup_window_days=7,
//      shipping_offered=false, refund_window_post_pickup_hours=48
//      (the post-pickup window matches the platform Bidder Agreement;
//      bumped from 0 -> 48 by audit fix migration 0093 to remove the
//      contradiction between the auto-seeded "no exceptions" copy and
//      the 48-hour platform dispute window).
//   4. Admin publishes a v2 policy (INSERT + flip published=true)
//   5. Verify get_active_operator_policy now returns v2
//   6. New bidder signs up
//   7. Before consent: query operator_policy_acceptances → 0 rows
//   8. Call record_operator_consent(op.id, 2) via bidder JWT
//   9. Verify acceptance row exists with correct version
//  10. Place a bid on a lot to verify bidding still works post-consent
//
// The test bidder created here is tracked on ctx.policyTestBidderId so
// cleanup.js can remove them.

'use strict';

const { step, expect, setPhase } = require('../lib/assert');
const { time } = require('../lib/timer');
const supa = require('../lib/supa');

async function run({ ctx }) {
  setPhase('Operator Policies');

  if (!ctx.operatorId) {
    await step('prereq: operatorId present', async () => {
      expect(false).toBeTruthy('ctx.operatorId missing — operator setup failed');
    });
    return;
  }

  const ts = Date.now().toString().slice(-8);
  let policyBidder = null;

  // ── 1. Verify v1 published policy seeded by migration 0088 ────────────────
  await step('migration 0088 seed created a default v1 published policy', async () => {
    const { value } = await time('supa.select.operator_policies.v1', () =>
      supa.supaSelect(
        null,
        'operator_policies',
        'operator_id=eq.' + ctx.operatorId + '&version=eq.1',
        'operator_id,version,published,payment_window_hours,pickup_window_days,shipping_offered,refund_window_post_pickup_hours',
        true,
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data && value.data.length).toBe(1);
    const p = value.data[0];
    console.log(
      '      [policies] v1: published=' + p.published +
      ' pay_window=' + p.payment_window_hours +
      ' pickup_days=' + p.pickup_window_days +
      ' shipping=' + p.shipping_offered,
    );
    expect(p.published).toBe(true);
  });

  // ── 2 + 3. Read via RPC and verify default field values ──────────────────
  await step('get_active_operator_policy returns v1 with correct defaults', async () => {
    const { value } = await time('rpc.get_active_operator_policy.v1', () =>
      supa.supaRpc(null, 'get_active_operator_policy', {
        p_operator_id: ctx.operatorId,
      }, true),
    );
    expect(value.error).toBeNull();
    // TABLE RPC returns array; we want the first (latest published) row.
    const row = Array.isArray(value.data) ? value.data[0] : value.data;
    expect(row).toBeTruthy('get_active_operator_policy returned a row');
    console.log(
      '      [policies] active v' + row.version +
      ' pay_window_hours=' + row.payment_window_hours +
      ' pickup_days=' + row.pickup_window_days +
      ' shipping=' + row.shipping_offered +
      ' refund_hours=' + row.refund_window_post_pickup_hours,
    );
    // Migration 0088 seed defaults per the spec.
    expect(row.payment_window_hours).toBe(0);      // pay-at-win
    expect(row.pickup_window_days).toBe(7);
    expect(row.shipping_offered).toBe(false);
    expect(row.refund_window_post_pickup_hours).toBe(48);
  });

  // ── 4. Admin publishes v2 policy (24h grace, 10-day pickup, shipping) ─────
  await step('admin inserts + publishes v2 policy', async () => {
    // Build a stable content_hash for the new version.
    const contentHash = 'sim-v2-' + ts;
    const { value } = await time('supa.insert.operator_policies.v2', () =>
      supa.supaInsert(
        null,
        'operator_policies',
        {
          operator_id: ctx.operatorId,
          version: 2,
          terms_md: '# Updated Terms v2\nSim test v2 terms.',
          refund_md: '# Refund Policy v2\nSim test v2 refund.',
          shipping_md: '# Shipping Policy v2\nShipping now offered.',
          payment_window_hours: 24,
          pickup_window_days: 10,
          shipping_offered: true,
          refund_window_post_pickup_hours: 48,
          published: true,
          content_hash: contentHash,
          created_by: ctx.adminUserId,
        },
        true,
      ),
    );
    expect(value.error).toBeNull();
    console.log('      [policies] v2 published');
  });

  // ── 5. Verify get_active_operator_policy now returns v2 ──────────────────
  await step('get_active_operator_policy returns v2 after publish', async () => {
    const { value } = await time('rpc.get_active_operator_policy.v2', () =>
      supa.supaRpc(null, 'get_active_operator_policy', {
        p_operator_id: ctx.operatorId,
      }, true),
    );
    expect(value.error).toBeNull();
    const row = Array.isArray(value.data) ? value.data[0] : value.data;
    expect(row).toBeTruthy('get_active_operator_policy v2 returned a row');
    console.log(
      '      [policies] active v' + row.version +
      ' pay_window_hours=' + row.payment_window_hours +
      ' shipping=' + row.shipping_offered,
    );
    expect(row.version).toBe(2);
    expect(row.payment_window_hours).toBe(24);
    expect(row.pickup_window_days).toBe(10);
    expect(row.shipping_offered).toBe(true);
  });

  // ── 6. New bidder signs up ────────────────────────────────────────────────
  await step('create policy-test bidder', async () => {
    const email = 'sim-bidder-policy-' + ts + '@example.com';
    const password = 'PolicyPass!' + ts + 'xyz';

    const { value: authUser } = await time('supa.admin.createUser.policyBidder', () =>
      supa.adminCreateUser({
        email,
        password,
        userMetadata: { sim: true, role: 'bidder', label: 'policy' },
      }),
    );
    const userId = authUser.userId;

    const { value: bidderRes } = await time('supa.insert.bidders.policyBidder', () =>
      supa.supaInsert(
        null,
        'bidders',
        {
          id: userId,
          email,
          display_name: 'Sim Bidder Policy',
          birth_date: '1990-01-01',
        },
        true,
      ),
    );
    expect(bidderRes.error).toBeNull();

    const { value: signIn } = await time('supa.signIn.policyBidder', () =>
      supa.signInWithPassword(email, password),
    );
    expect(signIn.token).toBeTruthy('policy bidder token');

    policyBidder = { email, password, userId, token: signIn.token };

    // Store on ctx so cleanup.js can delete the user.
    ctx.policyTestBidderId = userId;
    console.log('      [policies] policy-test bidder ' + userId);
  });

  if (!policyBidder) {
    await step('policy bidder available', async () => {
      expect(false).toBeTruthy('policy bidder creation failed — skipping consent tests');
    });
    return;
  }

  // ── 7. Before consent: 0 acceptance rows ─────────────────────────────────
  await step('no policy acceptance rows before consent', async () => {
    const { value } = await time('supa.select.operator_policy_acceptances.before', () =>
      supa.supaSelect(
        policyBidder.token,
        'operator_policy_acceptances',
        'user_id=eq.' + policyBidder.userId + '&operator_id=eq.' + ctx.operatorId,
        'id,version',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data && value.data.length).toBe(0);
  });

  // ── 8. Call record_operator_consent via bidder JWT ────────────────────────
  let acceptanceId = null;
  await step('record_operator_consent(op, 2) via bidder JWT returns UUID', async () => {
    const { value } = await time('rpc.record_operator_consent', () =>
      supa.supaRpc(policyBidder.token, 'record_operator_consent', {
        p_operator_id: ctx.operatorId,
        p_version: 2,
      }),
    );
    expect(value.error).toBeNull();
    // record_operator_consent returns a UUID (the new acceptance id).
    expect(value.data).toBeTruthy('consent returned UUID');
    acceptanceId = value.data;
    console.log('      [policies] consent id=' + acceptanceId);
  });

  // ── 9. Verify acceptance row exists with correct fields ───────────────────
  await step('operator_policy_acceptances has 1 row with version=2', async () => {
    const { value } = await time('supa.select.operator_policy_acceptances.after', () =>
      supa.supaSelect(
        policyBidder.token,
        'operator_policy_acceptances',
        'user_id=eq.' + policyBidder.userId + '&operator_id=eq.' + ctx.operatorId,
        'id,version,accepted_at,ip_address,user_agent',
      ),
    );
    expect(value.error).toBeNull();
    expect(value.data && value.data.length).toBe(1);
    const row = value.data[0];
    expect(row.version).toBe(2);
    expect(row.accepted_at).toBeTruthy('accepted_at set');
    console.log(
      '      [policies] acceptance: version=' + row.version +
      ' ip=' + (row.ip_address || 'null') +
      ' ua=' + (row.user_agent || 'null'),
    );
    // ip_address and user_agent come from request headers; in the sim
    // they may be null (no reverse proxy forwarding headers). That's fine —
    // the RPC doesn't require them and the acceptance itself is valid.
  });

  // ── 10. Place a bid to verify bidding works post-consent ─────────────────
  // Use a lot from the auction that isn't already closed. If the closer
  // persona already finalized all lots, placing a bid may fail — that's
  // acceptable and we handle it gracefully.
  if (ctx.assignedLots && ctx.assignedLots.length > 0) {
    await step('policy bidder places a bid post-consent (functional verify)', async () => {
      // Pick the first available lot. Use the cSweep lot — it already has
      // bids from bidder C, so a fresh bid here just tests the plumbing.
      // If lots are closed, place_bid will return ok:false with a reason.
      const targetLot =
        (ctx.scenarioLots && ctx.scenarioLots.cSweep) ||
        ctx.assignedLots[0];
      const lotId = targetLot.lot_id || targetLot.id;

      const { value } = await time('rpc.place_bid.policyBidder', () =>
        supa.supaRpc(policyBidder.token, 'place_bid', {
          p_lot_id: lotId,
          p_max_amount_cents: 100000, // $1,000 max — enough to win if open
        }),
      );
      // If the lot is closed, place_bid will return an error or ok:false.
      // Either is acceptable — we only care that the auth layer didn't
      // reject us due to missing policy consent (which would be a 403/RLS
      // error, not a business-logic ok:false).
      if (value.error) {
        // HTTP error (403/RLS/etc.) — surface it but don't fail hard since
        // the lot might already be closed. Only fail if it looks like an
        // auth rejection.
        const errStr = JSON.stringify(value.error).toLowerCase();
        const isAuthError =
          errStr.includes('rls') ||
          errStr.includes('policy') ||
          errStr.includes('permission') ||
          errStr.includes('unauthorized');
        if (isAuthError) {
          // This is a real failure — policy consent didn't gate properly.
          expect(false).toBeTruthy(
            'bid rejected for auth/RLS reason after consent: ' + errStr,
          );
        } else {
          console.log('      [policies] bid returned business error (lot likely closed): ' + errStr.slice(0, 80));
          expect(true).toBe(true); // soft pass
        }
      } else {
        // ok:true (we got the bid in) or ok:false (business rule, not auth)
        console.log('      [policies] bid result: ok=' + value.data.ok + (value.data.reason ? ' reason=' + value.data.reason : ''));
        expect(typeof value.data.ok).toBe('boolean');
      }
    });
  }
}

module.exports = { run };
