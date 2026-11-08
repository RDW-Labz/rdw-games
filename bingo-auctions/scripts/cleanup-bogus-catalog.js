#!/usr/bin/env node
// ============================================================================
// scripts/cleanup-bogus-catalog.js
//
// One-shot cleanup for bogus-identifier rows in product_lookups (and
// optionally competitor_lots / lots) that slipped through the pre-0044
// normalizer. After this script runs, apply migration 0044 so future writes
// are rejected at normalization time.
//
// Default mode (no flags): DRY RUN — prints row counts + a sample of what
// would be deleted. Nothing is written to the database.
//
// Usage:
//   # Dry run (default) — safe to run any time:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/cleanup-bogus-catalog.js
//
//   # Commit the deletions:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/cleanup-bogus-catalog.js --commit
//
//   # Restrict to a specific table only:
//   node scripts/cleanup-bogus-catalog.js --only=product_lookups
//   node scripts/cleanup-bogus-catalog.js --only=competitor_lots
//
//   # Increase sample size for review:
//   node scripts/cleanup-bogus-catalog.js --sample=50
//
// Environment:
//   NEXT_PUBLIC_SUPABASE_URL       — required
//   SUPABASE_SERVICE_ROLE_KEY      — required (bypasses RLS)
//
// What counts as "bogus":
//   This script applies the same pattern rules as isFakeUpc() in
//   packages/domain-lotting/src/normalize/upc.ts:
//     1. All same digit      — '000000000000', '999999999999'
//     2. Sequential asc/desc — '012345678901', '987654321098'
//     3. Repeated sub-pattern — '121212121212', '123412341234'
//     4. Explicit blocklist  — known placeholder values
//
//   For product_lookups: matches on the `upc` column (the primary key).
//     Rows with a synthetic PK like 'asin:B000000000' are also handled —
//     the ASIN component is extracted and checked with isFakeAsin().
//
//   For competitor_lots: matches on the `upc` column (nullable).
//     A bogus upc on a competitor_lot is NULLed out (not deleted) —
//     the lot itself is still valid data, just without an identifier.
//
// Run-once:
//   After migration 0044 is applied, the normalizer rejects these patterns
//   at write time. This script only needs to run once to clean up the
//   existing poisoned rows. It is safe to run multiple times (idempotent
//   in dry-run mode; in --commit mode, second run finds 0 rows).
// ============================================================================

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Env loader ────────────────────────────────────────────────────────────────

function loadEnv() {
  const candidates = [
    path.join(__dirname, '..', '.env.migrations.local'),
    path.join(__dirname, '..', '.env.local'),
    path.join(__dirname, '..', 'apps', 'operator-web', '.env.local'),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
    break;
  }
}

loadEnv();

// ── CLI flags ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function flagBool(name) { return argv.includes(`--${name}`); }
function flagVal(name) {
  for (const a of argv) {
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return null;
}

const COMMIT      = flagBool('commit');
const ONLY_TABLE  = flagVal('only');   // 'product_lookups' | 'competitor_lots' | null
const SAMPLE_SIZE = parseInt(flagVal('sample') ?? '20', 10);

// ── Supabase client ───────────────────────────────────────────────────────────

function makeClient() {
  const { createClient } = require('@supabase/supabase-js');
  const ws = require('ws');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws },
  });
}

// ── Bogus-pattern detection (mirrors normalize/upc.ts) ────────────────────────
//
// TODO: consolidate — this duplicates the canonical logic in
// packages/domain-lotting/src/normalize/upc.ts. The script can't require
// that TS module directly because it hasn't been compiled. Once the platform
// has a build step or tsx is available in CI, replace with:
//   const { isFakeUpc, isFakeAsin } = require('path/to/compiled/upc.js');

const FAKE_UPC_BLOCKLIST = new Set([
  '123456789012',
  '012345678905',
  '888888888888',
  '123456789013',
  '000000000017',
]);

/**
 * Returns true if a digits-only string of valid UPC length matches a bogus
 * placeholder pattern. Same logic as isFakeUpc() in normalize/upc.ts.
 */
function isFakeUpc(digits) {
  // P1: All same digit
  if (/^(.)\1+$/.test(digits)) return true;

  // P2 & P3: Sequential ascending or descending (mod-10 aware)
  const diffs = digits.split('').slice(1).map((ch, i) => {
    let d = parseInt(ch, 10) - parseInt(digits[i], 10);
    if (d === 9)  d = -1;
    if (d === -9) d = 1;
    return d;
  });
  if (diffs.every((d) => d === 1) || diffs.every((d) => d === -1)) return true;

  // P4: Repeated short sub-pattern (period 2, 3, 4)
  const len = digits.length;
  for (const period of [2, 3, 4]) {
    if (len % period !== 0) continue;
    const chunk = digits.slice(0, period);
    if (digits === chunk.repeat(len / period)) return true;
  }

  // P5: Explicit blocklist
  if (FAKE_UPC_BLOCKLIST.has(digits)) return true;

  return false;
}

const FAKE_ASIN_BLOCKLIST = new Set(['B000000000', 'B012345678', 'B0TEST00001']);

/**
 * Returns true if a 10-char uppercase ASIN matches a bogus pattern.
 * Same logic as isFakeAsin() in normalize/upc.ts.
 */
function isFakeAsin(asin) {
  const suffix = asin.slice(1);

  // P1: Suffix all same char
  if (/^(.)\1+$/.test(suffix)) return true;

  // P2: Full string period-2 or period-5 repeat
  for (const period of [2, 5]) {
    if (10 % period !== 0) continue;
    const chunk = asin.slice(0, period);
    if (asin === chunk.repeat(10 / period)) return true;
  }

  // P3: All-digit suffix sequential
  if (/^\d{9}$/.test(suffix)) {
    const diffs = suffix.split('').slice(1).map((ch, i) => {
      let d = parseInt(ch, 10) - parseInt(suffix[i], 10);
      if (d === 9)  d = -1;
      if (d === -9) d = 1;
      return d;
    });
    if (diffs.every((d) => d === 1) || diffs.every((d) => d === -1)) return true;
  }

  // P4: Explicit blocklist
  if (FAKE_ASIN_BLOCKLIST.has(asin)) return true;

  return false;
}

/**
 * Classify a product_lookups.upc value (which may be a real UPC or a
 * synthetic 'asin:<ASIN>' / 'fnsku:<FNSKU>' key) as bogus or not.
 * Returns true if the value should be deleted.
 */
function isBogusPkValue(upc) {
  if (!upc) return false;

  // Synthetic ASIN key
  if (upc.startsWith('asin:')) {
    const asin = upc.slice(5);
    return /^[A-Z0-9]{10}$/.test(asin) && isFakeAsin(asin);
  }

  // Synthetic FNSKU / LPN keys — no fake detection for these yet
  if (upc.startsWith('fnsku:') || upc.startsWith('lpn:')) return false;

  // Real UPC: digit-only, valid length
  const digits = upc.replace(/[^\d]/g, '');
  if ([8, 12, 13, 14].includes(digits.length) && digits === upc) {
    return isFakeUpc(digits);
  }

  return false;
}

// ── Scan + collect bogus rows from Postgres ───────────────────────────────────

/**
 * Page through a table's UPC column and collect all rows where the UPC
 * value is bogus. Returns an array of the bogus UPC values found.
 *
 * We fetch in pages rather than using a DB-side function because 0044
 * may not be applied yet when this script runs.
 */
async function collectBogusUpcValues(sb, tableName, upcColumn, pageSize = 1000) {
  const bogusValues = [];
  let offset = 0;

  while (true) {
    const { data, error } = await sb
      .from(tableName)
      .select(upcColumn)
      .not(upcColumn, 'is', null)
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error(`  [${tableName}] fetch error at offset ${offset}: ${error.message}`);
      break;
    }

    if (!data || data.length === 0) break;

    for (const row of data) {
      const val = row[upcColumn];
      if (val && isBogusPkValue(val)) bogusValues.push(val);
    }

    if (data.length < pageSize) break;
    offset += pageSize;
    process.stdout.write(`\r  [${tableName}] scanned ${offset} rows...`);
  }

  if (offset > 0) process.stdout.write('\r' + ' '.repeat(60) + '\r');
  return bogusValues;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log(`=== cleanup-bogus-catalog.js ===`);
  console.log(`Mode: ${COMMIT ? 'COMMIT (writes to DB)' : 'DRY RUN (read-only)'}`);
  if (ONLY_TABLE) console.log(`Table filter: ${ONLY_TABLE}`);
  console.log('');

  const sb = makeClient();

  // ── 1. product_lookups ────────────────────────────────────────────────────
  if (!ONLY_TABLE || ONLY_TABLE === 'product_lookups') {
    console.log('[product_lookups] Scanning for bogus upc values...');
    const bogusUpcValues = await collectBogusUpcValues(sb, 'product_lookups', 'upc');

    console.log(`  Found ${bogusUpcValues.length} bogus rows in product_lookups`);

    if (bogusUpcValues.length > 0) {
      // Sample for review
      const sample = bogusUpcValues.slice(0, SAMPLE_SIZE);
      console.log(`  Sample (up to ${SAMPLE_SIZE}):`);
      for (const val of sample) {
        console.log(`    upc = '${val}'`);
      }

      if (COMMIT) {
        console.log('  Deleting...');
        // Delete in chunks of 200 to avoid hitting URL-length limits on the filter.
        let deleted = 0;
        for (let i = 0; i < bogusUpcValues.length; i += 200) {
          const chunk = bogusUpcValues.slice(i, i + 200);
          const { error } = await sb
            .from('product_lookups')
            .delete()
            .in('upc', chunk);
          if (error) {
            console.error(`  Delete chunk error: ${error.message}`);
          } else {
            deleted += chunk.length;
          }
        }
        console.log(`  Deleted ${deleted} rows from product_lookups`);
      } else {
        console.log('  (dry run — pass --commit to delete)');
      }
    }
    console.log('');
  }

  // ── 2. competitor_lots ────────────────────────────────────────────────────
  // For competitor_lots we NULL out the upc column rather than delete the row.
  // The lot itself is valid — it just shouldn't have a fake UPC attached.
  if (!ONLY_TABLE || ONLY_TABLE === 'competitor_lots') {
    console.log('[competitor_lots] Scanning for bogus upc values...');

    const bogusLotUpcs = [];
    let offset = 0;
    const PAGE = 1000;

    while (true) {
      const { data, error } = await sb
        .from('competitor_lots')
        .select('source,source_id,upc,title')
        .not('upc', 'is', null)
        .range(offset, offset + PAGE - 1);

      if (error) {
        console.error(`  [competitor_lots] fetch error: ${error.message}`);
        break;
      }
      if (!data || data.length === 0) break;

      for (const row of data) {
        if (row.upc && isBogusPkValue(row.upc)) {
          bogusLotUpcs.push({ source: row.source, source_id: row.source_id, upc: row.upc, title: row.title });
        }
      }

      if (data.length < PAGE) break;
      offset += PAGE;
      process.stdout.write(`\r  [competitor_lots] scanned ${offset} rows...`);
    }
    if (offset > 0) process.stdout.write('\r' + ' '.repeat(60) + '\r');

    console.log(`  Found ${bogusLotUpcs.length} rows with bogus upc in competitor_lots`);

    if (bogusLotUpcs.length > 0) {
      const sample = bogusLotUpcs.slice(0, SAMPLE_SIZE);
      console.log(`  Sample (up to ${SAMPLE_SIZE}):`);
      for (const r of sample) {
        const titlePreview = r.title ? r.title.slice(0, 70) : '(no title)';
        console.log(`    ${r.source}/${r.source_id}  upc='${r.upc}'  title='${titlePreview}'`);
      }

      if (COMMIT) {
        console.log('  NULLing out bogus upc values (not deleting the lot rows)...');
        let nulled = 0;
        // Group by upc value to minimise round-trips (one update per distinct bogus upc).
        const byUpc = {};
        for (const r of bogusLotUpcs) {
          if (!byUpc[r.upc]) byUpc[r.upc] = [];
          byUpc[r.upc].push(r.source_id);
        }
        for (const [upc, sourceIds] of Object.entries(byUpc)) {
          // Chunk source_ids to avoid filter limits.
          for (let i = 0; i < sourceIds.length; i += 200) {
            const chunk = sourceIds.slice(i, i + 200);
            const { error } = await sb
              .from('competitor_lots')
              .update({ upc: null })
              .eq('upc', upc)
              .in('source_id', chunk);
            if (error) {
              console.error(`  NULL-update error for upc='${upc}': ${error.message}`);
            } else {
              nulled += chunk.length;
            }
          }
        }
        console.log(`  Nulled upc on ${nulled} competitor_lots rows`);
      } else {
        console.log('  (dry run — pass --commit to null out upc values)');
      }
    }
    console.log('');
  }

  console.log('Done.');
  if (!COMMIT) {
    console.log('Re-run with --commit to apply changes.');
  } else {
    console.log('Next step: apply migration 0044_normalize_quality.sql so future writes reject these patterns.');
  }
}

main().catch((e) => {
  console.error('FATAL:', e.message || e);
  process.exit(1);
});
