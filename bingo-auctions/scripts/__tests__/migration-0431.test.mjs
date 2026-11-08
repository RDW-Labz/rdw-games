// 0431 data migration (#533): file shape only, no database.
// Run: node --test scripts/__tests__/migration-0431.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const mig = read('packages/db/migrations/0431_correct_stale_load_picks.sql');
const dry = read('scripts/prod-rig/0431-dry-run.sql');
const undo = read('scripts/prod-rig/0431_ROLLBACK_correct_stale_load_picks.sql');
const list = JSON.parse(read('scripts/data/stale-load-picks-20261020.json'));
const { lintMigration } = createRequire(import.meta.url)('../check-new-lot-migrations.cjs');

test('exactly the 9 approved lots, BIN-036548..555 + 036566, to no load', () => {
  assert.deepEqual(list.map((r) => r.lot_code), [
    'BIN-036548', 'BIN-036549', 'BIN-036550', 'BIN-036551',
    'BIN-036552', 'BIN-036553', 'BIN-036554', 'BIN-036555', 'BIN-036566',
  ]);
  for (const r of list) {
    assert.ok(mig.includes(`('${r.id}'::uuid, '${r.lot_code}')`), r.lot_code);
    assert.ok(dry.includes(`'${r.id}'`), r.lot_code);
  }
  assert.equal((mig.match(/::uuid, 'BIN-/g) ?? []).length, 9);
  assert.match(mig, /SET load_id = NULL/);
});

test('migration guards, logs, and times out on locks', () => {
  assert.match(mig, /^SET lock_timeout = '3s';$/m);
  assert.match(mig, /FOR UPDATE OF l/);
  assert.match(mig, /<> 9 THEN/);
  assert.match(mig, /'load\.correction'/);
  assert.match(mig, /a lot now has a manifest row/);
  assert.doesNotMatch(mig, /\bDELETE\b|\bTRUNCATE\b|\bALTER\b|\bDROP (TABLE|INDEX|FUNCTION|TRIGGER)\b/i);
});

test('dry run is read-only and query-mode safe', () => {
  const body = dry.split('\n').filter((l) => !l.startsWith('--')).join('\n').trim();
  assert.match(body, /^WITH /);
  assert.doesNotMatch(body, /\b(UPDATE|INSERT|DELETE)\b/i);
  assert.doesNotMatch(dry, /"/);
});

test('undo restores only from 0431 audit rows and only lots still unloaded', () => {
  const reason = mig.match(/'(#533: stale load pick[^']+)'/)[1];
  assert.ok(undo.includes(`a.reason_note = '${reason}'`));
  assert.match(undo, /WHERE l\.id = u\.lot_id AND l\.load_id IS NULL/);
  assert.match(undo, /'load\.correction\.undo'/);
});

test('empty CI database skips, a rerun is a no-op, anything else stays strict', () => {
  const skip = mig.indexOf("'0431: none of the 9 lots are here, skipping'");
  const done = mig.indexOf("'0431: already applied, nothing to do'");
  const strict = mig.indexOf("'0431: precondition failed: a lot no longer carries the reviewed old load'");
  assert.ok(skip > 0 && done > skip && strict > done, 'skip, then already-applied, then the strict precondition');
  assert.ok(mig.indexOf('FOR UPDATE OF l') < skip, 'rows are locked before any check');
  assert.match(mig, /AND l\.load_id IS NULL[\s\S]*?'load\.correction'[\s\S]*?\) = 9 THEN/);
  assert.equal((mig.match(/\bRETURN;/g) ?? []).length, 2);
});

test('footprint guard: exempt header waives only the omission (load_id change, nothing removed)', () => {
  assert.match(mig.split('\n')[0], /^-- footprint-exempt: .{10,}/);
  const { errors, exempt } = lintMigration(mig);
  assert.deepEqual(errors, []);
  assert.equal(exempt?.waived.length, 1);
});
