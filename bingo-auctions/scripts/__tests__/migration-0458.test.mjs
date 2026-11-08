// 0458: enqueue_notification is server-only (audit #581 C-1). Shape check; the
// behaviour proof (anon/authenticated denied, definer callers still work,
// rollback restores) is scripts/prod-rig/0458-rig/run.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MIG = new URL('../../packages/db/migrations/0458_revoke_enqueue_notification.sql', import.meta.url).pathname;
const RB = new URL('../prod-rig/0458_ROLLBACK_revoke_enqueue_notification.sql', import.meta.url).pathname;
const code = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const SIG = 'public.enqueue_notification(notification_kind, uuid, jsonb, text)';

test('0458 revokes from PUBLIC, anon and authenticated and keeps service_role', () => {
  const b = code(readFileSync(MIG, 'utf8'));
  for (const r of ['PUBLIC', 'anon', 'authenticated']) assert.ok(b.includes(`REVOKE EXECUTE ON FUNCTION ${SIG} FROM ${r};`), r);
  assert.ok(b.includes(`GRANT EXECUTE ON FUNCTION ${SIG} TO service_role;`));
  assert.doesNotMatch(b, /\b(UPDATE|DELETE|INSERT|ALTER TABLE|DROP)\b/i);
});

test('0458 rollback restores anon and authenticated', () => {
  const b = code(readFileSync(RB, 'utf8'));
  assert.ok(b.includes(`GRANT EXECUTE ON FUNCTION ${SIG} TO anon;`));
  assert.ok(b.includes(`GRANT EXECUTE ON FUNCTION ${SIG} TO authenticated;`));
});
