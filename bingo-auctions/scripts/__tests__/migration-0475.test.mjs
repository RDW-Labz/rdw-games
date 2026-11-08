// 0475: refunded lot status + refund trigger + relist after refund (manager
// PIN). File-shape checks; behaviour is proven on the Docker copy:
// scripts/prod-rig/0475-rig/run.sh (standard flows identical BEFORE / AFTER /
// after rollback, money identical with and without, 36 cases, 12 bidder-read
// cases, apply / re-apply / rollback / re-apply, preflight refusal) and on
// Supabase's 17.6 image as non-superuser: 0475-rig/supabase176.sh.
//
// Reads the in-repo path by default, so it FAILS ON PURPOSE (ENOENT) until
// the owner copies the pending file in. Override MIG0475 to point at
// ~/Documents/bingo-migrations-pending/0475_refund_lot_status.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);

const MIG = process.env.MIG0475
  ?? new URL('../../packages/db/migrations/0475_refund_lot_status.sql', import.meta.url).pathname;
const ROLLBACK = new URL('../prod-rig/0475_ROLLBACK_refund_lot_status.sql', import.meta.url).pathname;
const code = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

test('0475: the enum value is alone in its own committed transaction, first', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  const tx = body.split(/^COMMIT;$/m).map((t) => t.trim()).filter(Boolean);
  assert.equal(tx.length, 2, 'two transactions');
  assert.match(tx[0], /^BEGIN;\s*SET LOCAL lock_timeout = '3s';\s*ALTER TYPE public\.lot_status ADD VALUE IF NOT EXISTS 'refunded';$/);
  assert.doesNotMatch(tx[1], /ALTER TYPE/);
  assert.match(tx[1], /SET LOCAL lock_timeout = '3s';/);
});

test('0475: no data change, no table rewrite', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  assert.doesNotMatch(body, /ALTER TABLE/i);
  const topLevel = body.replace(/\$\$[\s\S]*?\$\$/g, '');
  assert.doesNotMatch(topLevel, /^\s*(UPDATE|DELETE|INSERT)\b/im);
});

test('0475: deferred trigger, full line refunds only; skips picked-up, forfeited, missing and other open sales', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  assert.match(body, /CREATE CONSTRAINT TRIGGER invoice_lots_0475_refund_to_refunded\s+AFTER UPDATE OF refunded_at ON public\.invoice_lots\s+DEFERRABLE INITIALLY DEFERRED/);
  assert.match(body, /WHEN \(OLD\.refunded_at IS NULL AND NEW\.refunded_at IS NOT NULL\)/);
  assert.match(body, /v_line\.picked_up_at IS NOT NULL/);
  assert.match(body, /v_line\.forfeited_at IS NOT NULL/);
  // only a FULL refund of the line moves the lot
  assert.match(body, /v_refunded \+ v_extra < v_line_paid - 2/);
  assert.match(body, /'invoice\.refund_item'/);
  assert.match(body, /o\.outcome = 'missing'/);
  assert.match(body, /'lot\.refunded'/);
});

test('0475: relist after refund needs a manager PIN, name and reason, and is signed-in only', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  for (const r of ['staff_name_required', 'reason_required', 'pin_not_manager', 'buyer_took_it', 'not_refunded']) {
    assert.match(body, new RegExp(`'${r}'`));
  }
  assert.match(body, /public\.verify_worker_pin\(p_manager_worker_id/);
  assert.match(body, /'lot\.relist_after_refund'/);
  assert.match(body, /REVOKE ALL ON FUNCTION public\.relist_refunded_lot\(UUID, UUID, TEXT, TEXT, TEXT, UUID\) FROM anon;/);
});

test('0475 passes the repo function-grants and lot-migration lints', () => {
  const sql = readFileSync(MIG, 'utf8');
  const { lintGrants } = require('../check-function-grants.cjs');
  const { lintMigration } = require('../check-new-lot-migrations.cjs');
  assert.deepEqual(lintGrants(sql), []);
  assert.deepEqual(lintMigration(sql).errors, []);
});

test('0475: bidders may read refunded lots; policy otherwise prod\'s, behind an md5 preflight, last in transaction 2', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  const tx2 = body.split(/^COMMIT;$/m).map((t) => t.trim()).filter(Boolean)[1];
  assert.match(tx2, /'b250d666540e8f077a6a5d72a1fd422f'/);
  assert.match(tx2, /'47a1fc5867fb1127177d0623e8ad814c'/);
  assert.match(tx2, /status IN \('scheduled', 'live', 'won', 'unsold', 'relisted', 'refunded'\)/);
  assert.match(tx2, /early_access_until IS NULL/);
  assert.match(tx2, /o\.is_demo/);
  assert.match(tx2, /b\.is_reviewer/);
  const drop = tx2.indexOf('DROP POLICY IF EXISTS lots_bidder_read_published ON public.lots;');
  assert.ok(drop > tx2.indexOf('relist_refunded_lot'), 'policy step comes after the trigger and function');
  assert.ok(drop > tx2.indexOf("RAISE EXCEPTION '0475: lots_bidder_read_published"), 'preflight before the drop');
});

test('0475 rollback drops the trigger and both functions; any lot write stays commented out', () => {
  const rb = readFileSync(ROLLBACK, 'utf8');
  const live = code(rb);
  assert.match(live, /DROP TRIGGER IF EXISTS invoice_lots_0475_refund_to_refunded ON public\.invoice_lots;/);
  assert.match(live, /DROP FUNCTION IF EXISTS public\.invoice_lots_0475_refund_to_refunded\(\);/);
  assert.match(live, /DROP FUNCTION IF EXISTS public\.relist_refunded_lot\(UUID, UUID, TEXT, TEXT, TEXT, UUID\);/);
  assert.match(live, /status IN \('scheduled', 'live', 'won', 'unsold', 'relisted'\)\n/);
  assert.doesNotMatch(live, /'refunded'\)\n/);
  assert.doesNotMatch(live, /^\s*UPDATE\b/im);
});
