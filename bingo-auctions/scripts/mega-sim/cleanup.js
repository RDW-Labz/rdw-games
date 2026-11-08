// scripts/mega-sim/cleanup.js
//
// Tear down a SIM operator and everything bound to it. Service-role
// only — bypasses RLS. Idempotent: running twice is fine.
//
// Cleanup order respects FKs:
//   bids → invoice_lots → invoices → watchlist → auctions → lots →
//   import_rows → imports → bins → warehouses → operator_users →
//   bidders → operator → auth.users
//
// Many of these CASCADE — explicit DELETEs are belt-and-suspenders so
// a partial run still leaves no orphans.

'use strict';

const { loadEnv } = require('./lib/env');
loadEnv();
const supa = require('./lib/supa');

async function cleanup({ operatorId, adminUserId, pickerUserId, bidderUserIds, tombstonedBidderIds, policyTestBidderId }) {
  const log = (m) => console.log('[cleanup] ' + m);

  // tombstonedBidderIds: these users ran delete_my_account() — their
  // bidders row must NOT be deleted (bids/invoices FK it). Only the
  // auth.users row gets cleaned up.
  const tombstoned = new Set(tombstonedBidderIds || []);

  if (operatorId) {
    // Find auctions for this operator so we can clear bids/watchlist
    // before the lots CASCADE.
    const { data: auctions } = await supa.supaSelect(
      null,
      'auctions',
      'operator_id=eq.' + operatorId,
      'id',
      true,
    );
    const auctionIds = (auctions || []).map((a) => a.id);

    // bids — FK on lot_id CASCADE, but the bids row also has bidder_id
    // RESTRICT to bidders. Easiest is to delete bids directly by lot.
    const { data: lots } = await supa.supaSelect(
      null,
      'lots',
      'operator_id=eq.' + operatorId,
      'id',
      true,
    );
    const lotIds = (lots || []).map((l) => l.id);

    if (lotIds.length > 0) {
      log('deleting bids for ' + lotIds.length + ' lots');
      await supa.supaDelete(null, 'bids', 'lot_id=in.(' + lotIds.join(',') + ')', true);

      log('deleting invoice_lots');
      await supa.supaDelete(null, 'invoice_lots', 'lot_id=in.(' + lotIds.join(',') + ')', true);

      log('deleting watchlist entries');
      await supa.supaDelete(null, 'watchlist', 'lot_id=in.(' + lotIds.join(',') + ')', true);
    }

    if (auctionIds.length > 0) {
      log('deleting invoices for auctions');
      await supa.supaDelete(null, 'invoices', 'auction_id=in.(' + auctionIds.join(',') + ')', true);

      log('deleting auctions');
      await supa.supaDelete(null, 'auctions', 'id=in.(' + auctionIds.join(',') + ')', true);
    }

    log('deleting lots');
    await supa.supaDelete(null, 'lots', 'operator_id=eq.' + operatorId, true);

    log('deleting import_rows');
    await supa.supaDelete(null, 'import_rows', 'operator_id=eq.' + operatorId, true);

    log('deleting imports');
    await supa.supaDelete(null, 'imports', 'operator_id=eq.' + operatorId, true);

    log('deleting bins via warehouses');
    const { data: whs } = await supa.supaSelect(null, 'warehouses', 'operator_id=eq.' + operatorId, 'id', true);
    if (whs && whs.length > 0) {
      const ids = whs.map((w) => w.id).join(',');
      await supa.supaDelete(null, 'bins', 'warehouse_id=in.(' + ids + ')', true);
    }

    log('deleting warehouses');
    await supa.supaDelete(null, 'warehouses', 'operator_id=eq.' + operatorId, true);

    log('deleting operator_policy_acceptances');
    await supa.supaDelete(null, 'operator_policy_acceptances', 'operator_id=eq.' + operatorId, true);

    log('deleting operator_policies');
    await supa.supaDelete(null, 'operator_policies', 'operator_id=eq.' + operatorId, true);

    log('deleting ai_calls');
    await supa.supaDelete(null, 'ai_calls', 'operator_id=eq.' + operatorId, true);

    log('deleting operator_users');
    await supa.supaDelete(null, 'operator_users', 'operator_id=eq.' + operatorId, true);

    log('deleting operator');
    await supa.supaDelete(null, 'operators', 'id=eq.' + operatorId, true);
  }

  // Bidders rows reference auth.users via id. Delete the bidder rows
  // FIRST, then the auth.users — otherwise the FK from bidders.id →
  // auth.users(id) would block the auth.users delete.
  //
  // EXCEPTION: tombstoned bidders ran delete_my_account() which anonymized
  // their row but left it intact (bids/invoices FK it for tax retention).
  // Skip the bidders-row DELETE for those IDs; only delete the auth.users row.

  // Clean up policy-test bidder's acceptances and bidders row separately
  // (they aren't in the main bidderUserIds list if the persona added them).
  if (policyTestBidderId) {
    log('deleting policy-test bidder acceptances + bidder row: ' + policyTestBidderId);
    await supa.supaDelete(null, 'operator_policy_acceptances', 'user_id=eq.' + policyTestBidderId, true);
    await supa.supaDelete(null, 'bidders', 'id=eq.' + policyTestBidderId, true);
    try { await supa.adminDeleteUser(policyTestBidderId); } catch (e) { log('  ignored policy bidder auth: ' + e.message); }
  }

  if (bidderUserIds && bidderUserIds.length > 0) {
    // IDs that can have their bidders row deleted (not tombstoned).
    const deletableBidderRows = bidderUserIds.filter((id) => !tombstoned.has(id));
    if (deletableBidderRows.length > 0) {
      log('deleting bidders rows (non-tombstoned): ' + deletableBidderRows.length);
      await supa.supaDelete(null, 'bidders', 'id=in.(' + deletableBidderRows.join(',') + ')', true);
    }
    if (tombstoned.size > 0) {
      log('skipping bidders row DELETE for tombstoned IDs (bids/invoices FK retained): ' + [...tombstoned].join(', '));
    }
    for (const id of bidderUserIds) {
      try { await supa.adminDeleteUser(id); } catch (e) { log('  ignored bidder auth user ' + id + ': ' + e.message); }
    }
  }

  if (adminUserId) {
    log('deleting auth admin user ' + adminUserId);
    try { await supa.adminDeleteUser(adminUserId); } catch (e) { log('  ignored: ' + e.message); }
  }
  if (pickerUserId) {
    log('deleting auth picker user ' + pickerUserId);
    try { await supa.adminDeleteUser(pickerUserId); } catch (e) { log('  ignored: ' + e.message); }
  }

  log('done');
}

// Allow direct CLI: `node cleanup.js --operator=<uuid>` (purges that operator
// and all SIM- prefixed users it can find).
async function findAndCleanupAllSim() {
  const { data: ops } = await supa.supaSelect(
    null,
    'operators',
    'slug=like.sim-*',
    'id,slug,code',
    true,
  );
  if (!ops || ops.length === 0) {
    console.log('[cleanup] no SIM operators found');
  } else {
    for (const op of ops) {
      console.log('[cleanup] tearing down ' + op.code + ' (' + op.id + ')');
      const { data: users } = await supa.supaSelect(
        null,
        'operator_users',
        'operator_id=eq.' + op.id,
        'user_id,email',
        true,
      );
      const adminUserId = users && users.find((u) => /^sim-admin/.test(u.email))?.user_id;
      const pickerUserId = users && users.find((u) => /^sim-picker/.test(u.email))?.user_id;
      await cleanup({ operatorId: op.id, adminUserId, pickerUserId, bidderUserIds: [] });
    }
  }

  // Sweep orphan bidder rows / auth users from previous SIM runs.
  console.log('[cleanup] sweeping orphan sim-bidder-* rows');
  const { data: orphanBidders } = await supa.supaSelect(
    null,
    'bidders',
    'email=like.sim-bidder-*',
    'id,email',
    true,
  );
  if (orphanBidders && orphanBidders.length > 0) {
    const ids = orphanBidders.map((b) => b.id);
    await supa.supaDelete(null, 'bidders', 'id=in.(' + ids.join(',') + ')', true);
    for (const id of ids) {
      try { await supa.adminDeleteUser(id); } catch (e) { /* ignore */ }
    }
    console.log('[cleanup] removed ' + ids.length + ' orphan bidder(s)');
  }
}

if (require.main === module) {
  const arg = process.argv.find((a) => a.startsWith('--operator='));
  if (arg) {
    cleanup({ operatorId: arg.split('=')[1], bidderUserIds: [] }).catch((e) => {
      console.error(e);
      process.exit(1);
    });
  } else {
    findAndCleanupAllSim().catch((e) => {
      console.error(e);
      process.exit(1);
    });
  }
}

module.exports = { cleanup, findAndCleanupAllSim };
