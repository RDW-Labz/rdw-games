// 0447: builder_collected_lot_ids(). File-shape checks; the behaviour proof
// (ghost relist copies hidden, scanned-back item kept, clean lot kept, other
// operator / no session empty, rollback) runs on the Docker prod copy:
// scripts/prod-rig/0447-rig/run.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MIG = new URL('../../packages/db/migrations/0447_builder_collected_lots.sql', import.meta.url).pathname;
const ROLLBACK = new URL('../prod-rig/0447_ROLLBACK_builder_collected_lots.sql', import.meta.url).pathname;
const code = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

test('0447 file shape', () => {
  const body = code(readFileSync(MIG, 'utf8'));
  assert.match(body, /CREATE OR REPLACE FUNCTION public\.builder_collected_lot_ids\(p_warehouse_id uuid DEFAULT NULL\)/);
  assert.match(body, /STABLE/);
  assert.match(body, /current_operator_id\(\)/);
  assert.match(body, /collected_item_gone_lots\(\)/, 'same rule as the 0356 guard (0357 predicate)');
  assert.match(body, /relisted_from_lot_id/);
  assert.match(body, /REVOKE ALL ON FUNCTION public\.builder_collected_lot_ids\(uuid\) FROM anon;/);
  assert.doesNotMatch(body.replace(/\$function\$[\s\S]*?\$function\$/g, ''), /\b(UPDATE|DELETE|INSERT|ALTER TABLE)\b/i, 'function only');
  assert.doesNotMatch(body, /\bDO\s+\$/i);
});

test('0447 rollback drops only the function', () => {
  const rb = code(readFileSync(ROLLBACK, 'utf8'));
  assert.match(rb, /DROP FUNCTION IF EXISTS public\.builder_collected_lot_ids\(uuid\);/);
  assert.doesNotMatch(rb, /\b(UPDATE|DELETE|INSERT)\b/i);
});
