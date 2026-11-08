// 0453: sq-ft bidding PR 3/11 — the bidding engine (per-unit place_bid).
// File-shape and byte-provenance checks; the behaviour proof (standard bids
// identical before/after, per-unit cases, concurrency, timing, PostgREST
// overload resolution, preflight refusals, rollback) runs on the Docker prod
// copy: scripts/prod-rig/0453-rig/run.sh (+ postgrest.sh).
//
// Per the deny-rule on packages/db/migrations for this PR, the real file
// lives at ~/Documents/bingo-migrations-pending/0453_sqft_place_bid_per_unit.sql
// until the owner copies it into packages/db/migrations/. This test reads the
// normal in-repo path by default, so it fails on purpose (ENOENT) until that
// copy happens — set SQFT0453_MIGRATION to the pending file for a local check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);

const root = (p) => new URL(`../../${p}`, import.meta.url).pathname;
const MIG = process.env.SQFT0453_MIGRATION ?? root('packages/db/migrations/0453_sqft_place_bid_per_unit.sql');
const ROLLBACK = process.env.SQFT0453_ROLLBACK ?? root('scripts/prod-rig/0453_ROLLBACK_sqft_place_bid_per_unit.sql');
const SENTENCE = 'Bidding on this lot needs the latest BinGo app. Please update to bid.';
const md5 = (s) => createHash('md5').update(s).digest('hex');
const body = (def) => def.slice(def.indexOf('$function$') + 10, def.lastIndexOf('$function$'));
const code = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

// The live place_bid(uuid,bigint): 0263's CREATE OR REPLACE + 0350's patch.
function liveBody() {
  const lines = readFileSync(root('packages/db/migrations/0263_restore_outbid_notification.sql'), 'utf8').split('\n');
  const def = lines.slice(27, 382).join('\n') + '\n';
  const from = '    UPDATE bids\n    SET max_amount_cents = p_max_amount_cents\n    WHERE id = v_current_max_bid.id;';
  assert.equal(def.split(from).length, 2, '0350 patch target found exactly once in 0263');
  return def.replace(from, '    UPDATE bids\n    SET max_amount_cents = GREATEST(max_amount_cents, p_max_amount_cents)\n    WHERE id = v_current_max_bid.id;');
}
const LIVE = liveBody();
const PRE_MD5 = '7b6261a9548864b102f841546003db0d';

// Every CREATE OR REPLACE FUNCTION public.place_bid(...) ... $function$; in a file.
function defs(sql) {
  return [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.place_bid\([\s\S]*?\n\$function\$;\n/g)].map((m) => m[0]);
}

test('live base body is 0263 + 0350 (md5 matches rig0431 master replay)', () => {
  assert.equal(md5(body(LIVE)), PRE_MD5);
});

test('0453 shape: one transaction, preflight, two overloads, grants, postflight', () => {
  const raw = readFileSync(MIG, 'utf8');
  const sql = code(raw);
  assert.match(sql, /^SET lock_timeout = '3s';$/m);
  assert.match(sql, /^BEGIN;$/m);
  assert.match(sql, /^COMMIT;$/m);
  // preflight: 0451 columns + the live body it was built from (or itself)
  assert.match(sql, /column_name = 'bid_mode'/);
  assert.match(sql, /column_name = 'unit_qty'/);
  assert.match(sql, new RegExp(`v_md5 NOT IN \\('${PRE_MD5}', '[0-9a-f]{32}'\\)`));
  // functions only: no table, trigger, index, data change at top level
  const outside = sql.replace(/AS \$function\$[\s\S]*?\$function\$;/g, '');
  assert.doesNotMatch(outside, /\b(ALTER TABLE|CREATE TRIGGER|CREATE (UNIQUE )?INDEX|INSERT INTO|UPDATE (public\.)?\w+ SET|DELETE FROM|DROP FUNCTION)\b/i);
  // grants identical to every prior place_bid migration, both overloads
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.place_bid\(UUID, BIGINT\) TO authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.place_bid\(UUID, BIGINT, INTEGER\) TO authenticated;/);
  assert.match(sql, /3-arg place_bid grants differ from the 2-arg/);
  assert.doesNotMatch(outside, /\bREVOKE\b/);

  const [two, three] = defs(raw);
  assert.ok(two && three, 'two CREATE OR REPLACE place_bid definitions');
  assert.match(two, /^CREATE OR REPLACE FUNCTION public\.place_bid\(p_lot_id uuid, p_max_amount_cents bigint\)\n/);
  // No DEFAULT on p_unit_qty: a 2-key PostgREST call can never resolve to it.
  assert.match(three, /^CREATE OR REPLACE FUNCTION public\.place_bid\(p_lot_id uuid, p_max_amount_cents bigint, p_unit_qty integer\)\n/);

  // 2-arg = the live body + exactly one inserted block containing the sentence.
  assert.ok(two.includes(`'${SENTENCE}'`), 'exact owner sentence as the reason');
  const lock = '  PERFORM pg_advisory_xact_lock(hashtext(p_lot_id::text));\n';
  const start = two.indexOf(lock) + lock.length;
  const end = two.indexOf('  -- 1. Auth check');
  const inserted = two.slice(start, end);
  assert.match(inserted, /a\.bid_mode = 'per_unit'/);
  assert.equal(two.slice(0, start) + '\n' + two.slice(end), LIVE, '2-arg minus the 0453 block == live body, byte for byte');
  assert.match(sql, new RegExp(`<> '${md5(body(two))}' THEN\\s+RAISE EXCEPTION '0453: 2-arg body after apply`), 'postflight pins the 2-arg md5');

  // 3-arg: standard → the 2-arg itself; per_unit → §4 rules.
  assert.equal(three.split('RETURN public.place_bid(p_lot_id, p_max_amount_cents);').length, 3, 'delegates (pre-check + re-check under lock)');
  for (const r of ['unit_qty_mismatch', 'not_whole_cents_per_unit', 'lot_start_not_multiple', 'per_unit_schedule_missing', 'lot_amounts_not_multiple']) {
    assert.ok(three.includes(`'${r}'`), r);
  }
  assert.match(three, /min_bid_increment_cents\(\s*v_lot\.current_bid_cents \/ v_q,\s*v_auction\.bid_increment_schedule\s*\) \* v_q;/);
  assert.doesNotMatch(three, /COALESCE\(v_auction\.bid_increment_schedule, v_op_schedule\)/, 'per-unit never uses the operator ladder');
  // the guards it must keep, verbatim from the live body
  for (const kept of [
    'PERFORM pg_advisory_xact_lock(hashtext(p_lot_id::text));',
    "SET max_amount_cents = GREATEST(max_amount_cents, p_max_amount_cents)",
    "status      = 'payment_failed_grace'",
    "'shill_bidding_forbidden:",
    'PERFORM enqueue_notification(',
    'PERFORM _ensure_operator_bidder_relation(v_auction.operator_id, v_bidder_id);',
    "AND COALESCE(v_auction.soft_close_minutes, 0) > 0 THEN",
    'false, now()',
  ]) assert.ok(three.includes(kept), `3-arg keeps: ${kept}`);

  const { lintMigration } = require('../check-new-lot-migrations.cjs');
  const { errors } = lintMigration(raw);
  assert.deepEqual(errors, [], 'guard lint clean (no dynamic EXECUTE, no lot mutation outside function bodies)');

  // Same check as the Physical footprint guard job. place_bid keeps the live
  // 2-arg's ACL on purpose (opt-out comment in the header); 0460 narrows it.
  const { lintGrants } = require('../check-function-grants.cjs');
  assert.deepEqual(lintGrants(raw), [], 'function-grants lint clean');
});

test('0453 rollback: drops the 3-arg, restores the exact live 2-arg', () => {
  const raw = readFileSync(ROLLBACK, 'utf8');
  const sql = code(raw);
  assert.match(sql, /^SET lock_timeout = '3s';$/m);
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.place_bid\(uuid, bigint, integer\);/);
  const [def, extra] = defs(raw);
  assert.equal(extra, undefined);
  assert.equal(def, LIVE, 'rollback body == live body, byte for byte');
  assert.match(sql, new RegExp(`<> '${PRE_MD5}' THEN`));
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.place_bid\(UUID, BIGINT\) TO authenticated;/);
});
