// 0473: warehouse transfer (named, audited) + guard against silent
// cross-building re-shelving; replaces the held 0468. File-shape checks;
// behaviour is proven on the Docker copy: scripts/prod-rig/0473-rig/run.sh
// (45 cases, apply / re-apply, rollback, re-apply).
//
// Reads the in-repo path by default, so it FAILS ON PURPOSE (ENOENT) until
// the owner copies the pending file in. Override MIG0473 to point at
// ~/Documents/bingo-migrations-pending/0473_lot_warehouse_transfer.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);

const MIG = process.env.MIG0473
  ?? new URL('../../packages/db/migrations/0473_lot_warehouse_transfer.sql', import.meta.url).pathname;
const ROLLBACK = new URL('../prod-rig/0473_ROLLBACK_lot_warehouse_transfer.sql', import.meta.url).pathname;
const code = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

test('0473: one transaction, short lock timeout, no table rewrite, no data change', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  assert.match(body, /^BEGIN;$/m);
  assert.match(body, /^COMMIT;$/m);
  assert.match(body, /SET LOCAL lock_timeout = '3s';/);
  assert.doesNotMatch(body, /ALTER TABLE/i);
  // the only top-level statements are function/trigger DDL and grants
  const topLevel = body.replace(/\$\$[\s\S]*?\$\$/g, '');
  assert.doesNotMatch(topLevel, /^\s*(UPDATE|DELETE|INSERT)\b/im);
});

test('0473: the guard fires only when the shelf changes, never on bids', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  assert.match(body, /BEFORE UPDATE OF intake_bin_id ON public\.lots/);
  assert.match(body, /WHEN \(NEW\.intake_bin_id IS DISTINCT FROM OLD\.intake_bin_id\)/);
  // sorts before lots_check_auction_warehouse so its plain message wins
  assert.ok('lots_0473_transfer_guard' < 'lots_check_auction_warehouse');
});

test('0473: transfer needs a typed name and reason, is audited, and is signed-in staff only', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  assert.match(body, /'staff_name_required'/);
  assert.match(body, /'reason_required'/);
  assert.match(body, /'lot\.warehouse_transferred'/);
  for (const r of ['in_sale', 'sold', 'not_in_stock', 'in_open_auction', 'open_invoice', 'staged_for_pickup']) {
    assert.match(body, new RegExp(`'${r}'`));
  }
  assert.match(body, /REVOKE ALL ON FUNCTION public\.transfer_lot_to_bin\(UUID, UUID, TEXT, TEXT\) FROM anon;/);
  assert.match(body, /GRANT EXECUTE ON FUNCTION public\.transfer_lot_to_bin\(UUID, UUID, TEXT, TEXT\) TO authenticated, service_role;/);
  // the bypass flag is transaction-local and reset straight after the move
  assert.match(body, /set_config\('bingo\.lot_transfer', 'on', true\)/);
  assert.match(body, /set_config\('bingo\.lot_transfer', '', true\)/);
});

test('0473 passes the repo function-grants and lot-migration lints', () => {
  const sql = readFileSync(MIG, 'utf8');
  const { lintGrants } = require('../check-function-grants.cjs');
  const { lintMigration } = require('../check-new-lot-migrations.cjs');
  assert.deepEqual(lintGrants(sql), []);
  assert.deepEqual(lintMigration(sql).errors, []);
});

test('0473 rollback drops the trigger and both functions', () => {
  const rb = code(readFileSync(ROLLBACK, 'utf8'));
  assert.match(rb, /DROP TRIGGER IF EXISTS lots_0473_transfer_guard ON public\.lots;/);
  assert.match(rb, /DROP FUNCTION IF EXISTS public\.lots_0473_transfer_guard\(\);/);
  assert.match(rb, /DROP FUNCTION IF EXISTS public\.transfer_lot_to_bin\(UUID, UUID, TEXT, TEXT\);/);
});
