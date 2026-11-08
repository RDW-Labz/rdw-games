// 0454: sq-ft bidding PR 4/11 — database guards (two BEFORE triggers).
// File-shape checks only; the behaviour proof (standard flows identical
// before/after, every guard case, repo SQL tests, timing, lock_timeout,
// rollback, apply after rollback) runs on the Docker prod copy:
// scripts/prod-rig/0454-rig/run.sh.
//
// Per the deny-rule on packages/db/migrations for this PR, the real file
// lives at ~/Documents/bingo-migrations-pending/0454_sqft_guards.sql until
// the owner copies it into packages/db/migrations/. This test reads the
// normal in-repo path by default, so it fails on purpose (ENOENT) until that
// copy happens — set SQFT0454_MIGRATION to the pending file for a local check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);

const root = (p) => new URL(`../../${p}`, import.meta.url).pathname;
const MIG = process.env.SQFT0454_MIGRATION ?? root('packages/db/migrations/0454_sqft_guards.sql');
const ROLLBACK = process.env.SQFT0454_ROLLBACK ?? root('scripts/prod-rig/0454_ROLLBACK_sqft_guards.sql');
const code = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const outsideBodies = (sql) => sql.replace(/AS \$function\$[\s\S]*?\$function\$;/g, '').replace(/DO \$pre\$[\s\S]*?\$pre\$;/g, '');
const fnBody = (sql, name) => {
  const m = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(\\)[\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`));
  assert.ok(m, `${name} defined`);
  return { def: m[0], body: m[1] };
};

test('0454 shape: one transaction, 0451 preflight, triggers only (no rewrite, no data change)', () => {
  const raw = readFileSync(MIG, 'utf8');
  const sql = code(raw);
  assert.match(sql, /^SET lock_timeout = '3s';$/m);
  assert.match(sql, /^BEGIN;$/m);
  assert.match(sql, /^COMMIT;$/m);
  for (const c of ["'bid_mode', 'unit_start_cents'", "'unit_qty', 'unit_label'"]) assert.ok(sql.includes(c), `preflight checks ${c}`);
  assert.match(sql, /RAISE EXCEPTION '0454: needs 0451/);

  const top = outsideBodies(sql);
  assert.doesNotMatch(top, /\b(ALTER TABLE|CREATE (UNIQUE )?INDEX|INSERT INTO|UPDATE \w+(\.\w+)? SET|DELETE FROM|TRUNCATE|DROP)\b/i,
    'no table change, index, data change or DROP at top level');
  // CREATE OR REPLACE TRIGGER (SHARE ROW EXCLUSIVE), never DROP TRIGGER (ACCESS EXCLUSIVE).
  assert.match(top, /CREATE OR REPLACE TRIGGER lots_sqft_guard\s+BEFORE INSERT OR UPDATE OF auction_id, unit_qty, unit_label, starting_bid_cents\s+ON public\.lots\s+FOR EACH ROW EXECUTE FUNCTION public\.lots_sqft_guard\(\);/);
  assert.match(top, /CREATE OR REPLACE TRIGGER auctions_sqft_mode_lock\s+BEFORE UPDATE OF bid_mode\s+ON public\.auctions\s+FOR EACH ROW EXECUTE FUNCTION public\.auctions_sqft_mode_lock\(\);/);
  assert.equal((top.match(/CREATE OR REPLACE TRIGGER/g) ?? []).length, 2);
  // the lock is commented where it is taken (Rule 9)
  assert.equal((raw.match(/^-- LOCK: SHARE ROW EXCLUSIVE on public\.(lots|auctions)/gm) ?? []).length, 2);
});

test('0454 functions: SECURITY DEFINER, pinned search_path, not callable by PUBLIC, every rule', () => {
  const raw = readFileSync(MIG, 'utf8');
  for (const name of ['lots_sqft_guard', 'auctions_sqft_mode_lock']) {
    const { def } = fnBody(raw, name);
    assert.match(def, /RETURNS trigger\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public, pg_temp\n/);
    assert.match(raw, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(\\) FROM PUBLIC;`));
  }
  const lots = fnBody(raw, 'lots_sqft_guard').body;
  // relist copy: only when the child names no sq ft of its own
  assert.match(lots, /TG_OP = 'INSERT' AND NEW\.relisted_from_lot_id IS NOT NULL\s+AND NEW\.unit_qty IS NULL AND NEW\.unit_label IS NULL THEN\s+SELECT p\.unit_qty, p\.unit_label INTO NEW\.unit_qty, NEW\.unit_label/);
  // standard fast paths return the row untouched
  assert.match(lots, /IF NOT v_qty_changed AND NOT v_entering\s+AND NEW\.starting_bid_cents IS NOT DISTINCT FROM OLD\.starting_bid_cents THEN\s+RETURN NEW;/);
  assert.match(lots, /IF NOT v_entering AND NOT v_qty_changed AND NEW\.unit_qty IS NULL THEN\s+RETURN NEW;/);
  // lock conditions
  assert.match(lots, /OLD\.status IN \('live', 'won'\)/);
  assert.match(lots, /EXISTS \(SELECT 1 FROM bids b WHERE b\.lot_id = OLD\.id\)/);
  assert.match(lots, /a\.status IN \('live', 'closed'\)/);
  // starting price: auction default when the lot has no own per-unit start
  assert.match(lots, /NEW\.starting_bid_cents % NEW\.unit_qty <> 0 OR NEW\.starting_bid_cents = 100\) THEN\s+NEW\.starting_bid_cents := v_unit_start::bigint \* NEW\.unit_qty;/);
  assert.match(lots, /NEW\.starting_bid_cents := \(OLD\.starting_bid_cents \/ OLD\.unit_qty\) \* NEW\.unit_qty;/);
  // The only writes are to NEW (a BEFORE trigger), never to a table.
  const writes = /\bUPDATE\s+(public\.)?\w+\s+SET\b|\bINSERT INTO\b|\bDELETE FROM\b/i;
  assert.doesNotMatch(lots, writes);
  assert.doesNotMatch(fnBody(raw, 'auctions_sqft_mode_lock').body, writes);

  for (const hint of ['sqft_qty_label_pair', 'sqft_locked', 'sqft_lot_in_standard_auction', 'sqft_auction_needs_qty', 'sqft_start_not_whole', 'sqft_mode_locked', 'sqft_mode_lots_mismatch']) {
    assert.ok(raw.includes(`HINT = '${hint}'`), `HINT ${hint}`);
  }
  for (const sentence of [
    "Set the quantity and its unit together (for example 247 and sq ft), or leave both empty.",
    "on this lot can''t change once it is live or has bids.",
    "This auction is priced per sq ft. Add the lot''s sq ft before it goes in.",
    "How this auction is priced (per sq ft or standard) can''t change once it is live.",
    "This auction has lots priced the other way. Take them out first, then change how it is priced.",
  ]) assert.ok(raw.includes(sentence), `plain message: ${sentence}`);

  const { lintMigration } = require('../check-new-lot-migrations.cjs');
  assert.deepEqual(lintMigration(raw).errors, [], 'guard lint clean');
  const { lintGrants } = require('../check-function-grants.cjs');
  assert.deepEqual(lintGrants(raw), [], 'function-grants lint clean');
});

test('0454 rollback: drops exactly the two triggers and two functions, idempotent', () => {
  const raw = readFileSync(ROLLBACK, 'utf8');
  const sql = code(raw);
  assert.match(sql, /^SET lock_timeout = '3s';$/m);
  assert.match(sql, /^BEGIN;$/m);
  assert.match(sql, /^COMMIT;$/m);
  const stmts = sql.split(';').map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT|SET lock_timeout = '3s')$/.test(s));
  assert.deepEqual(stmts, [
    'DROP TRIGGER IF EXISTS lots_sqft_guard ON public.lots',
    'DROP TRIGGER IF EXISTS auctions_sqft_mode_lock ON public.auctions',
    'DROP FUNCTION IF EXISTS public.lots_sqft_guard()',
    'DROP FUNCTION IF EXISTS public.auctions_sqft_mode_lock()',
  ]);
});
