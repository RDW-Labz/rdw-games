import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isStaffPhoto, planFor, sameOrder } from '../ops/fix-ai-photo-order.mjs';

const S = (n) => `https://x.supabase.co/storage/v1/object/public/lot-photos/op/LOT/${n}.jpg`;
const AI = (n) => `https://m.media-amazon.com/images/I/${n}.jpg`;
const RH = 'https://x.supabase.co/storage/v1/object/public/lot-photos/rehost/a.jpg';

test('staff photo = lot-photos outside /rehost/', () => {
  assert.equal(isStaffPhoto(S(1)), true);
  assert.equal(isStaffPhoto(RH), false);
  assert.equal(isStaffPhoto(AI(1)), false);
});

test('remove: leading AI images dropped, staff order kept', () => {
  assert.deepEqual(planFor([AI(1), AI(2), S(1), S(2)]), { ai: [AI(1), AI(2)], next: [S(1), S(2)] });
});

test('move-after: AI images go behind the staff photos', () => {
  assert.deepEqual(planFor([AI(1), S(1), S(2)], 'move-after').next, [S(1), S(2), AI(1)]);
});

test('nothing to do when staff already first or no staff photo', () => {
  assert.equal(planFor([S(1), AI(1)]), null);
  assert.equal(planFor([AI(1), RH]), null);
  assert.equal(planFor([]), null);
});

test('non-staff photos after the first staff photo are kept in place', () => {
  assert.deepEqual(planFor([AI(1), S(1), AI(9), S(2)]).next, [S(1), AI(9), S(2)]);
});

test('sameOrder is order-sensitive', () => {
  assert.equal(sameOrder([S(1), S(2)], [S(1), S(2)]), true);
  assert.equal(sameOrder([S(2), S(1)], [S(1), S(2)]), false);
});

test('targets file: live first, every lot has a staff photo behind AI ones', () => {
  const t = JSON.parse(readFileSync(new URL('../ops/fix-ai-photo-order.targets.json', import.meta.url)));
  assert.ok(t.length > 0);
  assert.equal(t[0].status, 'live');
  const rank = { live: 0, scheduled: 1, won: 2 };
  for (let i = 1; i < t.length; i++) assert.ok((rank[t[i - 1].status] ?? 3) <= (rank[t[i].status] ?? 3));
  for (const x of t) {
    const p = planFor(x.old_photo_urls);
    assert.ok(p && p.ai.length > 0 && p.next.some(isStaffPhoto), x.lot_code);
  }
});

test('past lots are never targets; only live, scheduled, pending intake, in inventory', async () => {
  const { allowedTarget } = await import('../ops/fix-ai-photo-order.mjs');
  for (const s of ['live', 'scheduled', 'pending_intake', 'in_inventory']) assert.equal(allowedTarget(s), true, s);
  for (const s of ['won', 'relisted', 'disposed', 'unsold', 'canceled', 'refunded', 'draft', undefined]) assert.equal(allowedTarget(s), false, String(s));
});

test('the targets file keeps every old photo list (undo), and no storage call exists', async () => {
  const { readFileSync } = await import('node:fs');
  const t = JSON.parse(readFileSync(new URL('../ops/fix-ai-photo-order.targets.json', import.meta.url)));
  for (const r of t) assert.ok(Array.isArray(r.old_photo_urls) && r.old_photo_urls.length > 0, r.lot_code);
  const src = readFileSync(new URL('../ops/fix-ai-photo-order.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /storage\/v1\/object\/(?!public\/lot-photos\/')|method:\s*'DELETE'|\.remove\(/);
});
