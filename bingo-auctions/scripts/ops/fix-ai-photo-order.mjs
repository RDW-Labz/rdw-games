#!/usr/bin/env node
// Put staff photos back in front on lots where AI enrichment prepended stock
// images (owner 2026-10-30). Same write as the console's "save photo order"
// (lots.photo_urls under the staff session), signed in as YOURSELF: console
// email + password typed here (hidden, never stored or printed), public
// Supabase URL + anon key only.
//
// Usage:
//   node scripts/ops/fix-ai-photo-order.mjs                 # list only (default)
//   node scripts/ops/fix-ai-photo-order.mjs --go            # remove the AI images in front
//   node scripts/ops/fix-ai-photo-order.mjs --go --move-after   # keep them, behind staff photos
//   add --only live,scheduled to limit by lot status
//   node scripts/ops/fix-ai-photo-order.mjs --undo --go   # put the old photo lists back
//
// Owner 2026-10-30: never touch past lots (won, relisted, disposed, unsold,
// ...) — their photos are the record of what the buyer saw. Only the statuses
// in ALLOWED_STATUSES are changed, checked again on the live row before each
// write. Images are only detached from the listing (lots.photo_urls); no
// storage file is deleted, and the old lists in the targets file make it
// reversible with --undo.
// Env (public): BINGO_SUPABASE_URL, BINGO_SUPABASE_ANON_KEY
//
// Order: live, scheduled, won, then the rest. Each lot is written only if its
// photos are still exactly the listed old order; anything else is skipped.

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

export function isStaffPhoto(url) {
  return typeof url === 'string' && url.includes('/storage/v1/object/public/lot-photos/') && !url.includes('/rehost/');
}

/** Leading non-staff photos (what enrichment prepended) and the new order. */
export function planFor(photos, mode = 'remove') {
  const list = Array.isArray(photos) ? photos : [];
  const firstStaff = list.findIndex(isStaffPhoto);
  if (firstStaff <= 0) return null; // no staff photo, or staff already first
  const ai = list.slice(0, firstStaff);
  const rest = list.slice(firstStaff);
  return { ai, next: mode === 'move-after' ? [...rest, ...ai] : rest };
}

export const sameOrder = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

async function http(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${json?.msg ?? json?.message ?? json?.error_description ?? json?.error ?? res.statusText}`);
  return json;
}
function ask(rl, q) { return new Promise((r) => rl.question(q, (a) => r(a.trim()))); }
function askHidden(q) {
  return new Promise((resolve) => {
    const stdin = process.stdin; process.stdout.write(q); let buf = '';
    const onData = (ch) => {
      for (const c of ch.toString('utf8')) {
        if (c === '\n' || c === '\r' || c === '\u0004') { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stdout.write('\n'); return resolve(buf); }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (c === '\u007f') { buf = buf.slice(0, -1); continue; }
        buf += c;
      }
    };
    stdin.setRawMode(true); stdin.resume(); stdin.on('data', onData);
  });
}
export const ALLOWED_STATUSES = new Set(['live', 'scheduled', 'pending_intake', 'in_inventory']);
export const allowedTarget = (status) => ALLOWED_STATUSES.has(status);
const pgArray = (arr) => `{${arr.map((u) => `"${String(u).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;

async function main() {
  const go = process.argv.includes('--go');
  const mode = process.argv.includes('--move-after') ? 'move-after' : 'remove';
  const onlyArg = process.argv.find((a, i, all) => all[i - 1] === '--only');
  const undo = process.argv.includes('--undo');
  const only = onlyArg ? new Set(onlyArg.split(',')) : null;
  let targets = JSON.parse(readFileSync(new URL('./fix-ai-photo-order.targets.json', import.meta.url), 'utf8'));
  targets = targets.filter((t) => allowedTarget(t.status));
  if (only) targets = targets.filter((t) => only.has(t.status));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const base = (process.env.BINGO_SUPABASE_URL || (await ask(rl, 'Supabase URL (public): '))).replace(/\/+$/, '');
  const anon = process.env.BINGO_SUPABASE_ANON_KEY || (await ask(rl, 'Supabase anon key (public): '));
  const email = await ask(rl, 'Your console email: ');
  rl.close();
  const password = await askHidden('Your console password (hidden): ');
  const tok = (await http(`${base}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }))?.access_token;
  if (!tok) throw new Error('sign-in returned no session');
  const H = { apikey: anon, Authorization: `Bearer ${tok}` };
  const readLot = async (id) => (await http(`${base}/rest/v1/lots?select=id,lot_code,status,photo_urls&id=eq.${id}`, { headers: H }))?.[0] ?? null;

  try {
    const plan = [];
    console.log(`\nMode: ${mode === 'remove' ? 'REMOVE the AI images in front' : 'MOVE the AI images behind the staff photos'}\n`);
    for (const t of targets) {
      const cur = await readLot(t.id);
      if (!cur) { console.log(`${t.lot_code.padEnd(12)} not visible to this login — skipped`); continue; }
      if (!allowedTarget(cur.status)) { console.log(`${t.lot_code.padEnd(12)} now ${cur.status} (past lot) — never touched`); continue; }
      if (undo) {
        const done = planFor(t.old_photo_urls, mode);
        if (!done || !sameOrder(cur.photo_urls, done.next)) { console.log(`${t.lot_code.padEnd(12)} not in the changed state — skipped`); continue; }
        console.log(`${t.lot_code.padEnd(12)} ${cur.status.padEnd(14)} restore ${cur.photo_urls.length} -> ${t.old_photo_urls.length} photos`);
        plan.push({ ...t, from: cur.photo_urls, next: t.old_photo_urls });
        continue;
      }
      if (!sameOrder(cur.photo_urls, t.old_photo_urls)) { console.log(`${t.lot_code.padEnd(12)} photos changed since the list — skipped`); continue; }
      const p = planFor(cur.photo_urls, mode);
      if (!p) { console.log(`${t.lot_code.padEnd(12)} staff photo already first — skipped`); continue; }
      const staffN = cur.photo_urls.filter(isStaffPhoto).length;
      console.log(`${t.lot_code.padEnd(12)} ${cur.status.padEnd(14)} AI in front: ${p.ai.length}  staff: ${staffN}  ${cur.photo_urls.length} -> ${p.next.length} photos`);
      plan.push({ ...t, from: t.old_photo_urls, next: p.next });
    }
    console.log(`\n${plan.length} of ${targets.length} lots to change.`);
    if (!go) { console.log('List only (no --go). Nothing changed.'); return; }

    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    const word = undo ? 'UNDO PHOTOS' : 'FIX PHOTOS';
    const typed = await ask(rl2, `Type ${word} ${plan.length} to change them: `);
    rl2.close();
    if (typed !== `${word} ${plan.length}`) { console.error('Did not match. Nothing changed.'); process.exit(1); }

    let bad = 0;
    for (const p of plan) {
      const cur = await readLot(p.id);
      if (!cur || !allowedTarget(cur.status)) { console.log(`SKIP ${p.lot_code}: now ${cur?.status ?? 'missing'} (past lot)`); continue; }
      if (!sameOrder(cur.photo_urls, p.from)) { console.log(`SKIP ${p.lot_code}: photos changed just now`); continue; }
      const old = pgArray(p.from);
      const url = `${base}/rest/v1/lots?id=eq.${p.id}&status=in.(${[...ALLOWED_STATUSES].join(',')})&photo_urls=cs.${encodeURIComponent(old)}&photo_urls=cd.${encodeURIComponent(old)}`;
      const out = await http(url, { method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ photo_urls: p.next }) });
      const after = await readLot(p.id);
      const good = Array.isArray(out) && out.length === 1 && after && sameOrder(after.photo_urls, p.next);
      if (!good) bad++;
      console.log(`${good ? 'VERIFIED' : 'MISMATCH'} ${p.lot_code} (${p.status})`);
    }
    console.log(bad ? `\n${bad} problem(s). Tell Claude/Braden before anything else.` : `\nAll changed lots verified.`);
    process.exit(bad ? 1 : 0);
  } finally {
    try { await fetch(`${base}/auth/v1/logout`, { method: 'POST', headers: H }); } catch { /* best effort */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
