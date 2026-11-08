// 0445: Missing Items "Found" follows a relist. File-shape checks only; the
// behaviour proof (prod error reproduced before, fixed after, rollback) runs on
// the Docker prod copy: scripts/prod-rig/0445-rig/run.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MIG = new URL('../../packages/db/migrations/0445_missing_item_found_follows_relist.sql', import.meta.url).pathname;
const ROLLBACK = new URL('../prod-rig/0445_ROLLBACK_missing_item_found_follows_relist.sql', import.meta.url).pathname;
const code = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

test('0445 file shape', () => {
  const sql = readFileSync(MIG, 'utf8');
  const body = code(sql);
  assert.match(sql, /^SET lock_timeout = '3s';$/m);
  assert.match(body, /CREATE OR REPLACE FUNCTION public\.missing_item_found_since\(p_lot_id uuid, p_since timestamptz\)/);
  assert.match(body, /CREATE OR REPLACE FUNCTION public\.missing_item_found\(/);
  assert.match(body, /WITH RECURSIVE fam AS/);
  assert.match(body, /c\.relisted_from_lot_id = f\.id/);
  assert.match(body, /'relist_removed_as_' \|\| v_target\.removal_kind/);
  assert.match(body, /REVOKE EXECUTE ON FUNCTION public\.missing_item_found_since\(uuid, timestamptz\) FROM anon, authenticated;/);
  assert.match(body, /GRANT EXECUTE ON FUNCTION public\.missing_item_found\(uuid, uuid, text\) TO authenticated;/);
  assert.doesNotMatch(body, /\bDO\s+\$/i, 'no DO blocks (guard lint)');
  assert.doesNotMatch(body.replace(/\$function\$[\s\S]*?\$function\$/g, ''), /\b(UPDATE|DELETE|INSERT|TRUNCATE|ALTER TABLE)\b/i, 'functions only');
});

test('0445 rollback restores the 0426 bodies', () => {
  const rb = code(readFileSync(ROLLBACK, 'utf8'));
  assert.match(rb, /CREATE OR REPLACE FUNCTION public\.missing_item_found_since/);
  assert.match(rb, /CREATE OR REPLACE FUNCTION public\.missing_item_found\(/);
  assert.doesNotMatch(rb, /WITH RECURSIVE fam|relist_removed_as_/);
});
