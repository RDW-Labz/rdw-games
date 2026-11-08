// 0476: the sticker scan resolver ignores dead sales (declined/canceled
// invoices) when it picks the current row of a relist chain. File-shape
// checks; behaviour is proven on the Docker copy: scripts/prod-rig/0476-rig/run.sh.
//
// Reads the in-repo path by default, so it FAILS ON PURPOSE (ENOENT) until
// the owner copies the pending file in. Override MIG0476 to point at
// ~/Documents/bingo-migrations-pending/0476_scan_resolver_ignores_dead_sales.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);

const MIG = process.env.MIG0476
  ?? new URL('../../packages/db/migrations/0476_scan_resolver_ignores_dead_sales.sql', import.meta.url).pathname;
const ROLLBACK = new URL('../prod-rig/0476_ROLLBACK_scan_resolver_ignores_dead_sales.sql', import.meta.url).pathname;
const LIVE = new URL('../prod-rig/0476-rig/live-body-2026-10-28.sql', import.meta.url).pathname;

test('0476: one transaction, function only, preflight refuses an unknown live body', () => {
  const body = readFileSync(MIG, 'utf8');
  assert.match(body, /^BEGIN;$/m);
  assert.match(body, /^COMMIT;$/m);
  assert.match(body, /SET LOCAL lock_timeout = '3s';/);
  assert.doesNotMatch(body, /ALTER TABLE|CREATE TRIGGER|^\s*(UPDATE|DELETE|INSERT)\b/im);
  assert.match(body, /IS DISTINCT FROM '6a40bb40390d5c812534d791b778fa8a'/);
});

test('0476 differs from the live body by exactly the dead-sale condition', () => {
  const mig = readFileSync(MIG, 'utf8');
  const live = readFileSync(LIVE, 'utf8').trimEnd();
  const fn = mig.slice(mig.indexOf('CREATE OR REPLACE FUNCTION public._find_lot_by_scan'), mig.indexOf('$function$;') + '$function$'.length);
  const added = fn.split('\n').filter((l) => !live.split('\n').includes(l));
  assert.deepEqual(
    added.map((l) => l.trim()).filter((l) => l && !l.startsWith('--')),
    ['JOIN public.invoices iv ON iv.id = il.invoice_id', "AND iv.status IN ('pending', 'paid', 'partially_refunded', 'payment_failed_grace')"],
  );
});

test('0476 rollback restores the live body exactly', () => {
  const rb = readFileSync(ROLLBACK, 'utf8');
  const live = readFileSync(LIVE, 'utf8').trimEnd();
  assert.ok(rb.includes(live + ';'));
});

test('0476 passes the repo function-grants and lot-migration lints', () => {
  const sql = readFileSync(MIG, 'utf8');
  const { lintGrants } = require('../check-function-grants.cjs');
  const { lintMigration } = require('../check-new-lot-migrations.cjs');
  assert.deepEqual(lintGrants(sql), []);
  assert.deepEqual(lintMigration(sql).errors, []);
});
