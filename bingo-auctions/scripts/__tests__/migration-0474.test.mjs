// 0474: manager refund override for invoices Square cannot refund. File-shape
// checks; behaviour is proven on the Docker copy: scripts/prod-rig/0474-rig/run.sh
// (34 cases, apply / re-apply, rollback, re-apply).
//
// Reads the in-repo path by default, so it FAILS ON PURPOSE (ENOENT) until
// the owner copies the pending file in. Override MIG0474 to point at
// ~/Documents/bingo-migrations-pending/0474_refund_override.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);

const MIG = process.env.MIG0474
  ?? new URL('../../packages/db/migrations/0474_refund_override.sql', import.meta.url).pathname;
const ROLLBACK = new URL('../prod-rig/0474_ROLLBACK_refund_override.sql', import.meta.url).pathname;
const code = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

test('0474: one transaction, no ALTER of existing tables, no data change', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  assert.match(body, /^BEGIN;$/m);
  assert.match(body, /^COMMIT;$/m);
  assert.match(body, /SET LOCAL lock_timeout = '3s';/);
  assert.doesNotMatch(body, /ALTER TABLE\s+(public\.)?(lots|bids|invoices|invoice_lots|bidder_credits|operator_policies)\b/i);
  const topLevel = body.replace(/\$\$[\s\S]*?\$\$/g, '');
  assert.doesNotMatch(topLevel, /^\s*(UPDATE|DELETE|INSERT)\b/im);
});

test('0474: never around Square, never over the line, both caps, manager only, named', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  for (const r of ['use_card_refund', 'over_line_paid', 'cash_over_paid_offline', 'over_per_use_cap', 'over_daily_cap', 'manager_only', 'staff_name_required', 'reason_required']) {
    assert.match(body, new RegExp(`'${r}'`));
  }
  assert.match(body, /square_payment_id IS NOT NULL OR v_inv\.stripe_charge_id IS NOT NULL/);
  assert.match(body, /pg_advisory_xact_lock\(hashtextextended\('refund_override:'/);
  assert.match(body, /'invoice\.refund_override'/);
});

test('0474: tables are server-only; functions are signed-in only', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  for (const t of ['refund_override_settings', 'refund_overrides']) {
    assert.match(body, new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY;`));
    assert.match(body, new RegExp(`REVOKE ALL ON public\\.${t} FROM anon, authenticated;`));
  }
  assert.match(body, /REVOKE ALL ON FUNCTION public\.record_refund_override\(UUID, UUID, INT, TEXT, TEXT, TEXT, TEXT\) FROM anon;/);
  assert.match(body, /REVOKE ALL ON FUNCTION public\.refund_override_settings_set\(INT, INT, TEXT\) FROM anon;/);
});

test('0474 passes the repo function-grants and lot-migration lints', () => {
  const sql = readFileSync(MIG, 'utf8');
  const { lintGrants } = require('../check-function-grants.cjs');
  const { lintMigration } = require('../check-new-lot-migrations.cjs');
  assert.deepEqual(lintGrants(sql), []);
  assert.deepEqual(lintMigration(sql).errors, []);
});

test('0474 rollback drops both functions and both tables', () => {
  const rb = code(readFileSync(ROLLBACK, 'utf8'));
  assert.match(rb, /DROP FUNCTION IF EXISTS public\.record_refund_override\(UUID, UUID, INT, TEXT, TEXT, TEXT, TEXT\);/);
  assert.match(rb, /DROP FUNCTION IF EXISTS public\.refund_override_settings_set\(INT, INT, TEXT\);/);
  assert.match(rb, /DROP TABLE IF EXISTS public\.refund_overrides;/);
  assert.match(rb, /DROP TABLE IF EXISTS public\.refund_override_settings;/);
});
