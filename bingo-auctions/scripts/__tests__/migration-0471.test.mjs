// 0471: withdraw a lot from its auction (typed name + reason, bidders told by
// push / in-app), undo it while the auction is open, and an admin undo of
// Dispose / Business use within 24 h (owner 2026-10-27). File-shape checks;
// behaviour is proven on the Docker copy: scripts/prod-rig/0471-rig/run.sh
// (68 cases, apply / re-apply, rollback refused while a withdrawal can be
// undone, rollback restores the replaced functions byte for byte).
//
// Reads the in-repo path by default, so it FAILS ON PURPOSE (ENOENT) until
// the owner copies the pending file in. Override MIG0471 to point at
// ~/Documents/bingo-migrations-pending/0471_lot_withdraw_and_undo.sql.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);

const MIG = process.env.MIG0471
  ?? new URL('../../packages/db/migrations/0471_lot_withdraw_and_undo.sql', import.meta.url).pathname;
const ROLLBACK = new URL('../prod-rig/0471_ROLLBACK_lot_withdraw_and_undo.sql', import.meta.url).pathname;
const code = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

test('0471: enum values outside the transaction, the rest in one, short lock timeout', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  assert.ok(body.indexOf("ADD VALUE IF NOT EXISTS 'lot_withdrawn'") < body.indexOf('BEGIN;'));
  assert.match(body, /^COMMIT;$/m);
  assert.match(body, /SET LOCAL lock_timeout = '3s';/);
  // no lock on lots: no ALTER TABLE lots / CREATE TRIGGER on lots
  assert.doesNotMatch(body, /ALTER TABLE\s+(public\.)?lots\b/i);
  assert.doesNotMatch(body, /CREATE TRIGGER[\s\S]{0,200}ON\s+(public\.)?lots\b/i);
});

test('0471: every staff action needs a typed name and a reason', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  for (const f of ['withdraw_lot_from_auction', 'undo_lot_withdrawal', 'dispose_lot_attributed',
    'keep_lot_for_business_attributed', 'undo_lot_removal']) {
    const start = body.indexOf(`FUNCTION public.${f}(`);
    assert.ok(start > 0, f);
    assert.match(body.slice(start, start + 2500), /lot_staff_action_check\(/, f);
  }
  assert.match(body, /'staff_name_required'/);
  assert.match(body, /'reason_required'/);
  // undo of a removal is admin-only and 24 h
  const undo = body.slice(body.indexOf('FUNCTION public.undo_lot_removal('));
  assert.match(undo, /ARRAY\['admin'\]\)/);
  assert.match(undo, /INTERVAL '24 hours'/);
});

test('0471: withdraw refuses won / invoiced, keeps bids, notifies push / in-app only', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  const w = body.slice(body.indexOf('FUNCTION public.withdraw_lot_from_auction('), body.indexOf('FUNCTION public.undo_lot_withdrawal('));
  assert.match(w, /'lot_won'/);
  assert.match(w, /'lot_on_invoice'/);
  assert.doesNotMatch(w, /DELETE FROM bids/i);
  assert.match(w, /'lot_withdrawn'::notification_kind/);
});

test('0471: the terminal trigger opens only for an undo row written in the same transaction', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  const t = body.slice(body.indexOf('FUNCTION public.lots_removal_is_terminal('));
  assert.match(t, /u\.txid = txid_current\(\)/);
  assert.match(t, /lot_removal_is_permanent/);
  assert.match(body, /REVOKE ALL ON public\.lot_removal_undos FROM anon, authenticated;/);
});

test('0471 passes the repo function-grants and lot-migration lints', () => {
  const sql = readFileSync(MIG, 'utf8');
  const { lintGrants } = require('../check-function-grants.cjs');
  const { lintMigration } = require('../check-new-lot-migrations.cjs');
  assert.deepEqual(lintGrants(sql), []);
  assert.deepEqual(lintMigration(sql).errors, []);
});

test('0471 rollback refuses while a withdrawal can be undone and drops the new pieces', () => {
  const rb = code(readFileSync(ROLLBACK, 'utf8'));
  assert.match(rb, /0471 rollback refused/);
  assert.ok(rb.indexOf('LOCK TABLE public.lot_withdrawals') < rb.indexOf('0471 rollback refused'));
  assert.match(rb, /DROP TABLE IF EXISTS public\.lot_withdrawals;/);
  assert.match(rb, /DROP TABLE IF EXISTS public\.lot_removal_undos;/);
  assert.match(rb, /DROP FUNCTION IF EXISTS public\.withdraw_lot_from_auction\(UUID, TEXT, TEXT\);/);
});
