#!/usr/bin/env node
// =============================================================================
// scripts/square-bidfta-crossref.mjs
//
// READ-ONLY. Pages the entire account-wide Square customer directory and flags
// which customers also appear in an old BidFTA bidder export — WITHOUT the
// BidFTA plaintext ever leaving the operator's laptop/session. The BidFTA side
// is passed in as a file of one-way SHA-256(16 hex) key hashes
// (scripts/.bidfta-keys.txt): one hash per normalized email, and one per
// 'p:'+10-digit-phone. This script hashes each Square customer's email/phone
// the same way and tests membership. Matches print as TSV to stdout for the
// caller to read back and exact-verify locally.
//
// Square: GET /v2/customers (Customers API) — account-wide, NOT location
// scoped (Square customer records aren't tagged to a location; city/state come
// from the customer's address when present). No writes of any kind.
//
// Env: SQUARE_ACCESS_TOKEN (required), SQUARE_API_BASE, SQUARE_VERSION.
// Usage: node scripts/square-bidfta-crossref.mjs [path-to-keys]
// =============================================================================

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const API_BASE = process.env.SQUARE_API_BASE ?? 'https://connect.squareup.com';
const VERSION = process.env.SQUARE_VERSION ?? '2026-05-20';
const TOKEN = process.env.SQUARE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('FATAL: SQUARE_ACCESS_TOKEN is not set');
  process.exit(1);
}

const keysPath = process.argv[2] || 'scripts/.bidfta-keys.txt';
const keys = new Set(
  readFileSync(keysPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean),
);
console.error(`Loaded ${keys.size} BidFTA key hashes from ${keysPath}`);

const h = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function normPhone(v) {
  if (!v) return '';
  let d = String(v).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : '';
}

async function squareGet(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Square-Version': VERSION,
          'Content-Type': 'application/json',
        },
      });
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      console.error(`FATAL: Square ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      process.exit(1);
    }
    return text ? JSON.parse(text) : {};
  }
  console.error('FATAL: Square request failed after retries');
  process.exit(1);
}

// Optional: resolve location names so the report can note them even though the
// customer directory isn't location-scoped.
const locs = await squareGet('/v2/locations');
const locNames = (locs.locations ?? [])
  .map((l) => `${l.name} (${l.id})`)
  .join('; ');
console.error(`Account has ${(locs.locations ?? []).length} Square location(s): ${locNames}`);

let cursor = null;
let scanned = 0;
let withEmail = 0;
let withPhone = 0;
let matches = 0;
const seenMatch = new Set();

console.log('MATCH\tname\temail\tphone\tcity\tstate\tcreated\tvia\tcustomer_id');
do {
  const qp = new URLSearchParams({ limit: '100', sort_field: 'CREATED_AT', sort_order: 'ASC' });
  if (cursor) qp.set('cursor', cursor);
  const page = await squareGet(`/v2/customers?${qp.toString()}`);
  const customers = page.customers ?? [];
  for (const c of customers) {
    scanned++;
    const email = (c.email_address ?? '').trim().toLowerCase();
    const phone = normPhone(c.phone_number);
    if (email) withEmail++;
    if (phone) withPhone++;
    const viaEmail = email && keys.has(h(email));
    const viaPhone = phone && keys.has(h('p:' + phone));
    if (!viaEmail && !viaPhone) continue;
    if (seenMatch.has(c.id)) continue;
    seenMatch.add(c.id);
    matches++;
    const via = [viaEmail ? 'email' : '', viaPhone ? 'phone' : ''].filter(Boolean).join('+');
    const name = `${c.given_name ?? ''} ${c.family_name ?? ''}`.trim();
    const city = c.address?.locality ?? '';
    const state = c.address?.administrative_district_level_1 ?? '';
    const created = (c.created_at ?? '').slice(0, 10);
    const cell = (s) => String(s ?? '').replace(/[\t\n\r]/g, ' ');
    console.log(
      `MATCH\t${cell(name)}\t${cell(email)}\t${cell(phone)}\t${cell(city)}\t${cell(state)}\t${cell(created)}\t${via}\t${c.id}`,
    );
  }
  cursor = page.cursor ?? null;
  if (scanned % 1000 === 0) console.error(`…scanned ${scanned}, matches ${matches}`);
} while (cursor);

console.error('=== SUMMARY ===');
console.log(
  `SUMMARY\tscanned=${scanned}\twith_email=${withEmail}\twith_phone=${withPhone}\tmatches=${matches}`,
);
