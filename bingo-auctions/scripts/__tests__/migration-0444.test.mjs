// 0444: undo_invoice_line_forfeit(). File-shape checks need no database.
// The behaviour proof (every refusal, both success paths, audit row, rollback)
// runs on the Docker prod copy: scripts/prod-rig/0444-rig/run.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MIG = new URL('../../packages/db/migrations/0444_undo_invoice_line_forfeit.sql', import.meta.url).pathname;
const ROLLBACK = new URL('../prod-rig/0444_ROLLBACK_undo_invoice_line_forfeit.sql', import.meta.url).pathname;
const COPY = new URL('../../apps/operator-web/src/lib/undo-forfeit.ts', import.meta.url).pathname;
const SIG = 'public.undo_invoice_line_forfeit(uuid, uuid, text, text, text)';
const code = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

test('0444 file shape', () => {
  const sql = readFileSync(MIG, 'utf8');
  const body = code(sql);
  assert.match(sql, /^SET lock_timeout = '3s';$/m);
  assert.match(body, /CREATE OR REPLACE FUNCTION public\.undo_invoice_line_forfeit\(/);
  assert.match(body, /SECURITY DEFINER/);
  assert.match(body, /SET search_path TO 'public'/);
  assert.match(body, /role NOT IN \('admin', 'manager'\)/);
  assert.match(body, /length\(v_reason\) < 5/);
  assert.match(body, /length\(v_done_by\) < 2/);
  assert.match(body, /status <> 'canceled'/, 'relist lineage check');
  assert.match(body, /'invoice_line\.forfeit_undone'/);
  assert.ok(body.includes(`REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC;`));
  assert.ok(body.includes(`REVOKE ALL ON FUNCTION ${SIG} FROM anon;`));
  assert.ok(body.includes(`GRANT EXECUTE ON FUNCTION ${SIG} TO authenticated, service_role;`));
  assert.doesNotMatch(body.replace(/\$function\$[\s\S]*\$function\$/, ''), /\bDO\s+\$|\bEXECUTE\s+[^O]/i, 'no DO/EXECUTE outside the function (guard lint)');
  assert.doesNotMatch(body, /\b(refund|square)[a-z_]*\s*\(/i, 'moves no money');
});

test('every refusal code in 0444 has console copy', () => {
  const sql = code(readFileSync(MIG, 'utf8'));
  const copy = readFileSync(COPY, 'utf8');
  const codes = [...sql.matchAll(/'code', '([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(codes.length >= 10, `found ${codes.length} codes`);
  for (const c of new Set(codes)) assert.ok(copy.includes(`case '${c}':`), `no copy for ${c}`);
});

test('0444 rollback drops exactly the function', () => {
  const rb = code(readFileSync(ROLLBACK, 'utf8'));
  assert.match(rb, /DROP FUNCTION IF EXISTS public\.undo_invoice_line_forfeit\(uuid, uuid, text, text, text\);/);
  assert.doesNotMatch(rb, /\b(UPDATE|DELETE|INSERT|TRUNCATE)\b/i);
});
