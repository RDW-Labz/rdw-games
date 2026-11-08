// Seed an auction with 200 lots from the Lowes product manifest.
// Source: lowes.json (converted from a Lowes scraper xlsx).
//
// Talks to PostgREST directly via fetch — avoids supabase-js's realtime
// dependency on a native WebSocket (only present in Node ≥22).
//
// Run from repo root:
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=... \
//     npx tsx packages/db/seed/lowes-manifest.ts
//
// Stages close times so you see every heat tier in the bidder app:
//   urgent (<2m)   ×20 — red flash
//   closing (<30m) ×40 — orange
//   live <3h       ×60
//   live <48h      ×80

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_ROLE) {
  console.error('Set SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}
const OPERATOR_SLUG = process.env.SEED_OPERATOR_SLUG ?? 'cluer-pilot';

type ManifestRow = {
  title: string;
  category: string | null;
  sku: string | null;
  upc: string | null;
  photo_url: string;
  source_url: string | null;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest: ManifestRow[] = JSON.parse(
  readFileSync(join(__dirname, 'lowes.json'), 'utf8'),
);

const HEADERS: Record<string, string> = {
  apikey: SERVICE_ROLE,
  authorization: `Bearer ${SERVICE_ROLE}`,
  'content-type': 'application/json',
};

async function pgGet<T>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { ...HEADERS, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function pgInsert<T>(path: string, body: unknown, prefer = 'return=representation'): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...HEADERS, prefer, accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`INSERT ${path}: ${res.status} ${await res.text()}`);
  if (prefer.includes('return=minimal')) return undefined as T;
  return res.json() as Promise<T>;
}

async function main() {
  // Resolve operator + a warehouse.
  const ops = await pgGet<Array<{ id: string; business_name: string }>>(
    `operators?select=id,business_name&slug=eq.${OPERATOR_SLUG}`,
  );
  if (ops.length === 0) throw new Error(`operator ${OPERATOR_SLUG} not found`);
  const op = ops[0];

  const whs = await pgGet<Array<{ id: string; name: string }>>(
    `warehouses?select=id,name&operator_id=eq.${op.id}&limit=1`,
  );
  if (whs.length === 0) throw new Error('no warehouse for operator');
  const wh = whs[0];

  console.log(`→ operator ${op.business_name} · warehouse ${wh.name}`);

  // Create the auction. ends_at = the latest lot close.
  const now = Date.now();
  const endsAt = new Date(now + 49 * 60 * 60_000); // 49h from now
  const pickupStart = new Date(endsAt.getTime() + 60 * 60_000);
  const pickupEnd = new Date(endsAt.getTime() + 4 * 24 * 60 * 60_000);

  const [auction] = await pgInsert<Array<{ id: string }>>('auctions', {
    operator_id: op.id,
    warehouse_id: wh.id,
    title: 'Lowes Returns — Mixed Inventory',
    description:
      'Mixed liquidation lot from Lowes returns. Vanities, lawn equipment, hardware, paint, and more. All as-is.',
    status: 'live',
    starts_at: new Date(now - 60 * 60_000).toISOString(),
    ends_at: endsAt.toISOString(),
    soft_close_minutes: 3,
    pickup_starts_at: pickupStart.toISOString(),
    pickup_ends_at: pickupEnd.toISOString(),
    buyer_premium_bps: 1500,
  });
  console.log(`→ auction ${auction.id}`);

  // Pick 200 varied items (shuffle then slice).
  const sample = manifest
    .filter((r) => r.title.length > 4)
    .map((r) => ({ r, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map((x) => x.r)
    .slice(0, 200);

  // Build close-time tiers.
  const tiers: Array<{ count: number; minMs: number; maxMs: number }> = [
    { count: 20, minMs: 60_000, maxMs: 110_000 },
    { count: 40, minMs: 6 * 60_000, maxMs: 28 * 60_000 },
    { count: 60, minMs: 35 * 60_000, maxMs: 3 * 60 * 60_000 },
    { count: 80, minMs: 4 * 60 * 60_000, maxMs: 48 * 60 * 60_000 },
  ];

  const conditions = ['appears_new', 'open_box', 'good', 'good', 'good', 'as_is'] as const;

  const rows: Array<Record<string, unknown>> = [];
  let lotNumber = 1;
  let idx = 0;

  for (const tier of tiers) {
    for (let i = 0; i < tier.count; i++) {
      const m = sample[idx++];
      if (!m) break;
      const closeMs = tier.minMs + Math.random() * (tier.maxMs - tier.minMs);
      const closeAt = new Date(now + closeMs);
      const t = m.title.toUpperCase();
      let msrp = 5000 + Math.floor(Math.random() * 25_000);
      if (/VANITY/.test(t)) msrp = 30_000 + Math.floor(Math.random() * 40_000);
      else if (/MOWER|TILLER|TRACTOR|GENERATOR/.test(t)) msrp = 50_000 + Math.floor(Math.random() * 60_000);
      else if (/DRILL|SAW|GRINDER|TOOL/.test(t)) msrp = 8_000 + Math.floor(Math.random() * 25_000);
      else if (/LIGHT|BULB|CAP|HOOK|SCREW/.test(t)) msrp = 1_500 + Math.floor(Math.random() * 3_500);

      rows.push({
        operator_id: op.id,
        auction_id: auction.id,
        warehouse_id: wh.id,
        lot_number: lotNumber++,
        title: m.title,
        description: [m.category, m.sku, m.upc ? `UPC ${m.upc}` : null]
          .filter(Boolean)
          .join(' · '),
        category: m.category,
        condition: conditions[Math.floor(Math.random() * conditions.length)],
        msrp_cents: msrp,
        starting_bid_cents: 100,
        photo_urls: [m.photo_url],
        status: 'live',
        close_at: closeAt.toISOString(),
      });
    }
  }

  // Bulk insert in chunks.
  const CHUNK = 50;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await pgInsert('lots', chunk, 'return=minimal');
    inserted += chunk.length;
    process.stdout.write(`\r→ inserted ${inserted}/${rows.length}`);
  }
  console.log(`\n→ done: ${inserted} lots in auction ${auction.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
