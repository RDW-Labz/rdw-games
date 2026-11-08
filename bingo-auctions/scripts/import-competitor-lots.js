#!/usr/bin/env node
// ============================================================================
// scripts/import-competitor-lots.js
//
// Streams competitor auction lots from a SQLite scrape file into Supabase's
// `competitor_lots` Postgres table. Designed to scale to 1M+ rows for future
// scrapes (BidFTA, Nellis, ShopGoodwill, additional MAC.BID pulls).
//
// Imports normalizer functions from the canonical module at
//   packages/domain-lotting/src/normalize/
// with scattered-helper fallbacks when the module hasn't been built yet.
//
// Usage:
//   node scripts/import-competitor-lots.js [flags]
//
//   --db=<path>             default: C:/Users/jmacl/Downloads/lots.db
//   --source-filter=<name>  default: macbid  (skip rows with other sources)
//   --batch=<N>             default: 5000
//   --limit=<N>             optional: stop after N rows (smoke testing)
//   --commit                actually write to Postgres (default: dry-run)
//   --resolve-categories    call resolve_category_ids_batch RPC to populate category_id
//   --reapply-only          force UPDATE even on rows already present
//   --apply-indexes         run the post-load CREATE INDEX statements and exit
//
// Default mode (no --commit): streams and normalizes but writes a markdown
//   report to scripts/.import-reports/competitor-lots-<timestamp>.md instead
//   of touching Postgres.
//
// Idempotency:
//   Re-running with the same SQLite file and --commit produces 0 net inserts
//   (all rows conflict on (source, source_id)).  The RPC only updates the
//   live fields: current_bid_cents, final_bid_cents, bid_count, discount_pct,
//   last_seen_at, raw_json, updated_at.  When source data hasn't changed, the
//   UPDATE SET is a no-op at the Postgres tuple level (same values → xmax
//   incremented but no actual page write).
//
// ============================================================================

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Env loading ───────────────────────────────────────────────────────────────
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the first
// .env file found.

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
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
    break; // use first found file
  }
}

loadEnv();

// ── CLI flag parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flagVal(name) {
  for (const a of args) {
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return null;
}

function flagBool(name) {
  return args.includes(`--${name}`);
}

const DB_PATH        = flagVal('db')              || 'C:/Users/jmacl/Downloads/lots.db';
const SOURCE_FILTER  = flagVal('source-filter')   || 'macbid';
const BATCH_SIZE     = parseInt(flagVal('batch')  || '5000', 10);
const ROW_LIMIT      = flagVal('limit') ? parseInt(flagVal('limit'), 10) : null;
const COMMIT         = flagBool('commit');
const RESOLVE_CATS   = flagBool('resolve-categories');
const REAPPLY_ONLY   = flagBool('reapply-only');
const APPLY_INDEXES  = flagBool('apply-indexes');
// --populate-lookups: also upsert product_lookups rows when an identifier
// (UPC, ASIN, FNSKU, LPN) is extractable from raw_json. Defaults to ON when
// --commit is set. Pass --no-populate-lookups to suppress.
const NO_POPULATE_LOOKUPS = flagBool('no-populate-lookups');
const POPULATE_LOOKUPS    = COMMIT && !NO_POPULATE_LOOKUPS;
// Batch size for product_lookups upserts (smaller than competitor_lots batch
// since rows are richer and we want to keep upsert payloads manageable).
const LOOKUPS_BATCH_SIZE  = parseInt(flagVal('lookups-batch') || '500', 10);

// ── Normalizer bootstrap ──────────────────────────────────────────────────────
// SF-10 (2026-05-24 audit): load from the canonical TS module only.
// If the package is not built, fail fast with a clear error — do NOT fall back
// to inline copies that drift from the real implementation and cause silent
// data quality regressions at scale.
// Build first: pnpm --filter domain-lotting build

let parseCents, normalizeUpc, normalizeAsin, normalizeBrand, normalizeModel, isSafeImageUrl;

try {
  // The normalize/ package exports compiled JS into dist/ when built.
  const normalizePath = path.join(__dirname, '..', 'packages', 'domain-lotting', 'src', 'normalize');
  const moneyMod = require(path.join(normalizePath, 'money'));
  const upcMod   = require(path.join(normalizePath, 'upc'));
  const textMod  = require(path.join(normalizePath, 'text'));
  const mergeMod = require(path.join(normalizePath, '..', 'lookup', 'merge'));

  parseCents      = moneyMod.parseCents;
  normalizeUpc    = upcMod.normalizeUpc;
  normalizeAsin   = upcMod.normalizeAsin;
  normalizeBrand  = textMod.normalizeBrand;
  normalizeModel  = textMod.normalizeModel;
  isSafeImageUrl  = mergeMod.isSafeImageUrl;
  console.log('[normalizer] loaded from packages/domain-lotting/src/normalize/');
} catch (err) {
  console.error('[normalizer] FATAL: failed to load packages/domain-lotting/src/normalize/');
  console.error('[normalizer] Error:', err instanceof Error ? err.message : String(err));
  console.error('[normalizer] Build the package first: pnpm --filter domain-lotting build');
  process.exit(1);

  // DEAD CODE — preserved below for reference only. Remove after
  // feature/competitor-schema merges and build artifacts are confirmed present.
  /* eslint-disable no-unreachable */
  console.log('[normalizer] canonical module not found — using inline fallbacks');

  parseCents = function parseCents(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'number') {
      return Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 100) : null;
    }
    const cleaned = String(raw).replace(/[$,\s]/g, '');
    if (cleaned === '' || cleaned === '-') return null;
    const n = Number(cleaned);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100);
  };

  // ── Inline bogus-pattern helpers ──────────────────────────────────────────
  // TODO: consolidate — duplicates isFakeUpc / isFakeAsin from
  // packages/domain-lotting/src/normalize/upc.ts. Remove these fallbacks once
  // the canonical TS module is compiled and can be required directly.
  const _FAKE_UPC_BLOCKLIST_FALLBACK = new Set([
    '123456789012', '012345678905', '888888888888',
    '123456789013', '000000000017',
  ]);
  function _isFakeUpcFallback(digits) {
    if (/^(.)\1+$/.test(digits)) return true;
    const diffs = digits.split('').slice(1).map((ch, i) => {
      let d = parseInt(ch, 10) - parseInt(digits[i], 10);
      if (d === 9) d = -1; if (d === -9) d = 1; return d;
    });
    if (diffs.every((d) => d === 1) || diffs.every((d) => d === -1)) return true;
    const len = digits.length;
    for (const period of [2, 3, 4]) {
      if (len % period !== 0) continue;
      if (digits === digits.slice(0, period).repeat(len / period)) return true;
    }
    return _FAKE_UPC_BLOCKLIST_FALLBACK.has(digits);
  }
  const _FAKE_ASIN_BLOCKLIST_FALLBACK = new Set(['B000000000', 'B012345678', 'B0TEST00001']);
  function _isFakeAsinFallback(asin) {
    const suffix = asin.slice(1);
    if (/^(.)\1+$/.test(suffix)) return true;
    for (const period of [2, 5]) {
      if (10 % period !== 0) continue;
      if (asin === asin.slice(0, period).repeat(10 / period)) return true;
    }
    if (/^\d{9}$/.test(suffix)) {
      const diffs = suffix.split('').slice(1).map((ch, i) => {
        let d = parseInt(ch, 10) - parseInt(suffix[i], 10);
        if (d === 9) d = -1; if (d === -9) d = 1; return d;
      });
      if (diffs.every((d) => d === 1) || diffs.every((d) => d === -1)) return true;
    }
    return _FAKE_ASIN_BLOCKLIST_FALLBACK.has(asin);
  }

  normalizeUpc = function normalizeUpc(raw) {
    if (raw == null) return null;
    const digits = String(raw).replace(/[^\d]/g, '');
    if (![8, 12, 13, 14].includes(digits.length)) return null;
    if (_isFakeUpcFallback(digits)) return null;
    return digits;
  };

  const EMPTY_SENTINELS = new Set([
    '', 'null', 'n/a', 'na', 'none', 'unknown', '-', '--', 'n.a.', 'n.a',
    'not available', 'not applicable',
  ]);

  normalizeBrand = function normalizeBrand(raw) {
    if (raw == null) return null;
    const t = String(raw).trim();
    if (EMPTY_SENTINELS.has(t.toLowerCase())) return null;
    return t || null;
  };

  normalizeModel = function normalizeModel(raw) {
    return normalizeBrand(raw);
  };

  normalizeAsin = function normalizeAsin(raw) {
    if (raw == null) return null;
    const s = String(raw).trim().toUpperCase();
    // Standard Amazon ASIN: exactly 10 uppercase alphanumeric chars.
    if (!/^[A-Z0-9]{10}$/.test(s)) return null;
    if (_isFakeAsinFallback(s)) return null;
    return s;
  };

  // Keep in sync with packages/domain-lotting/src/normalize/images.ts
  // ALLOWED_IMAGE_HOSTS. The importer falls back to this inline copy when
  // the canonical TS module can't be loaded from the importer's Node
  // context. Added 2026-05-13: macbid CDN was already canonical but
  // missing here; firebase is added for nellis scrape coverage.
  const ALLOWED_IMAGE_HOSTS = new Set([
    'i.ebayimg.com', 'thumbs.ebaystatic.com', 'pics.ebaystatic.com',
    'i.pinimg.com',
    'm.media-amazon.com', 'images-na.ssl-images-amazon.com',
    'images-eu.ssl-images-amazon.com', 'images-fe.ssl-images-amazon.com',
    'ecx.images-amazon.com',
    'images.thdstatic.com',
    'mobileimages.lowes.com', 'images.lowes.com',
    'i5.walmartimages.com', 'i1.walmartimages.com', 'i2.walmartimages.com',
    'i3.walmartimages.com', 'i4.walmartimages.com',
    'target.scene7.com',
    'pisces.bbystatic.com',
    'mobilecontent.costco.com',
    'static.bhphotovideo.com',
    'c1.neweggimages.com',
    // Competitor auction CDNs (scraped via competitor_lots — read-only
    // reference data).
    'media.mac.bid',
    'cdn.bidfta.com',
    'images.nellisauction.com',
    // Nellis stores most product thumbs in Firebase Storage.
    'firebasestorage.googleapis.com',
    // BidWizOps Supabase Storage + Open Food Facts.
    'xgsujdzicnjenhqihovk.supabase.co',
    'images.openfoodfacts.org',
  ]);

  isSafeImageUrl = function isSafeImageUrl(url) {
    if (typeof url !== 'string') return false;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') return false;
      return ALLOWED_IMAGE_HOSTS.has(u.hostname.toLowerCase());
    } catch {
      return false;
    }
  };
  /* eslint-enable no-unreachable */
}

// ── product_lookups population ────────────────────────────────────────────────
//
// When --populate-lookups is active (default: ON with --commit), each
// competitor lot row is inspected for identifiers. If at least one valid
// identifier is found, a product_lookups row is upserted.
//
// KEY DESIGN: UPC is the product_lookups PRIMARY KEY. For rows where we have
// a real UPC (8/12/13/14 digits) we use it. For rows where the identifier is
// an ASIN, FNSKU, or LPN only, we synthesize a prefixed PK: 'asin:<ASIN>'.
//
// KNOWN LIMITATION: The synthetic-key approach is a short-term hack. The
// correct long-term model is a UUID PK on product_catalog with a separate
// product_identifiers join table (type, code, UNIQUE(type,code)). The synthetic
// key works for now because it's unique within product_lookups and the
// lookup_product_by_code RPC resolves ASIN/FNSKU/LPN through their dedicated
// columns (not through the upc PK value). Flag: "product_catalog_v2".
//
// For MAC.BID data specifically: raw_json.upc is populated for ~100% of rows
// but MOST of those values are actually ASINs (B0xxxx format), not real UPCs.
// The extractor detects this: if the value matches the ASIN pattern, it is
// stored in the asin column (and the synthetic key 'asin:<ASIN>' becomes the PK).
// If the value is purely numeric with a valid UPC length, it's a real UPC.
//
// Conflict resolution: on conflict (upc key) we do a COALESCE merge — never
// overwrite a non-null column with null. This way multiple import passes
// accumulate identifiers rather than clobbering each other.

/**
 * Extract normalized identifiers from a competitor lot's raw_json.
 * Returns { upc, asin, fnsku, lpn } — each null if not present / invalid.
 */
function extractIdentifiers(rawJsonObj, lotTitle) {
  if (!rawJsonObj) return { upc: null, asin: null, fnsku: null, lpn: null };

  // MAC.BID stores what it calls "upc" in raw_json, but many are actually ASINs.
  const rawUpcField = rawJsonObj.upc != null ? String(rawJsonObj.upc).trim() : null;

  let upc  = null;
  let asin = null;

  if (rawUpcField) {
    // Try as real UPC first (digit-only, valid lengths).
    const asUpc = normalizeUpc(rawUpcField);
    if (asUpc) {
      upc = asUpc;
    } else {
      // Try as ASIN (normalizeAsin returns null if not 10 uppercase alphanum).
      const asAsin = normalizeAsin(rawUpcField);
      if (asAsin) asin = asAsin;
    }
  }

  // Also check dedicated asin/fnsku/lpn fields if present (future scraper formats).
  if (!asin && rawJsonObj.asin) {
    asin = normalizeAsin(rawJsonObj.asin);
  }

  const fnsku = rawJsonObj.fnsku
    ? (String(rawJsonObj.fnsku).trim().toUpperCase().match(/^X[0-9A-Z]{9}$/)
        ? String(rawJsonObj.fnsku).trim().toUpperCase()
        : null)
    : null;

  const lpn = rawJsonObj.lpn
    ? String(rawJsonObj.lpn).trim().toUpperCase() || null
    : null;

  return { upc, asin, fnsku, lpn };
}

/**
 * Build a product_lookups row from a normalized competitor lot and its
 * extracted identifiers. Returns null when no identifier is usable.
 *
 * The primary key (upc column) is assigned as:
 *   - The real UPC digits when a valid UPC is present.
 *   - 'asin:<ASIN>'  when only an ASIN is available.
 *   - 'fnsku:<FNSKU>' when only FNSKU.
 *   - 'lpn:<LPN>'    when only LPN.
 *   (Priority: UPC > ASIN > FNSKU > LPN)
 */
function buildLookupRow(normalized, identifiers) {
  const { upc, asin, fnsku, lpn } = identifiers;

  // At least one identifier must be present.
  let pkUpc = upc;
  if (!pkUpc) {
    if (asin)  pkUpc = `asin:${asin}`;
    else if (fnsku) pkUpc = `fnsku:${fnsku}`;
    else if (lpn)   pkUpc = `lpn:${lpn}`;
    else return null; // nothing to key on
  }

  const now = new Date().toISOString();

  return {
    upc:          pkUpc,
    title:        normalized.title || null,
    brand:        normalized.brand || null,
    model:        normalized.model || null,
    category_id:  null,                // resolved later by --resolve-categories
    category_raw: normalized.category_raw || null,
    image_urls:   normalized.image_urls || [],
    asin:         asin,
    fnsku:        fnsku,
    lpn:          lpn,
    mpn:          null,
    external_codes: [],
    msrp_cents:   normalized.msrp_cents || null,
    avg_asking_cents:    null,
    median_sold_cents:   null,
    start_bid_cents:     null,
    prices:       normalized.msrp_cents
      ? JSON.stringify([{
          retailer: 'competitor:' + normalized.source,
          cents: normalized.msrp_cents,
          url: normalized.url,
          fetched_at: now,
        }])
      : JSON.stringify([]),
    sold_comps:   JSON.stringify([]),
    description:  normalized.description || null,
    specs:        null,
    confidence:   normalized.title ? 'low' : 'none',
    sources:      JSON.stringify([`competitor:${normalized.source}`]),
    identity_refreshed_at: now,
    prices_refreshed_at:   normalized.msrp_cents ? now : null,
    created_at:   now,
    updated_at:   now,
  };
}

/**
 * Flush a batch of product_lookups rows to Supabase.
 * Uses a COALESCE-merge upsert so existing richer rows aren't overwritten
 * by thinner competitor-import rows.
 *
 * Conflict target: upc (the PK).
 * On conflict: update only columns where the incoming value IS NOT NULL /
 * IS NOT EMPTY and the existing column IS NULL / IS EMPTY. This preserves
 * eBay / Sonar data when a later competitor import re-processes the same UPC.
 */
async function flushLookupsBatch(supabase, rows, batchNum) {
  if (!rows.length) return { upserted: 0, errors: 0 };

  // Transform: prices/sold_comps/sources are JSONB in Postgres but we
  // pass them as JS objects (Supabase client serializes them).
  const pg_rows = rows.map((r) => ({
    ...r,
    prices:     typeof r.prices    === 'string' ? JSON.parse(r.prices)    : r.prices,
    sold_comps: typeof r.sold_comps === 'string' ? JSON.parse(r.sold_comps) : r.sold_comps,
    sources:    typeof r.sources   === 'string' ? JSON.parse(r.sources)   : r.sources,
  }));

  // Use RPC for the merge-on-conflict behaviour. Falls back to direct upsert
  // (ignoreDuplicates=false) which on conflict replaces — acceptable since
  // the RPC is preferred and the direct path is a safety net.
  try {
    const { error } = await supabase.rpc('upsert_product_lookups_batch', {
      p_rows: pg_rows,
    });
    if (error) {
      // RPC not yet applied (0044+) — fall back to direct upsert which uses
      // ON CONFLICT DO UPDATE with Supabase's default "last write wins".
      // That's acceptable for initial import where we're seeding from zero.
      if (/not found|does not exist|42883/i.test(error.message)) {
        return await flushLookupsBatchDirect(supabase, pg_rows);
      }
      console.error(`\n  [lookups batch ${batchNum}] RPC error: ${error.message}`);
      return { upserted: 0, errors: rows.length };
    }
    return { upserted: rows.length, errors: 0 };
  } catch (e) {
    console.error(`\n  [lookups batch ${batchNum}] error: ${e.message}`);
    return { upserted: 0, errors: rows.length };
  }
}

async function flushLookupsBatchDirect(supabase, rows) {
  const { error, count } = await supabase
    .from('product_lookups')
    .upsert(rows, {
      onConflict: 'upc',
      ignoreDuplicates: false,
      count: 'exact',
    });
  if (error) {
    console.error(`\n  [lookups direct upsert] error: ${error.message}`);
    return { upserted: 0, errors: rows.length };
  }
  return { upserted: count ?? rows.length, errors: 0 };
}

// ── Row normalization ─────────────────────────────────────────────────────────
//
// SQLite column → competitor_lots column mapping:
//
//   source          → source          (verbatim; filtered by SOURCE_FILTER)
//   source_id       → source_id       (verbatim TEXT)
//   title           → title           (NOT NULL; skip row if null/empty)
//   description     → description     (nullable)
//   stock_image_url → image_urls[0]   (if isSafeImageUrl passes)
//   images_json     → image_urls      (JSON parse; merged with stock_image_url)
//   msrp            → msrp_cents      (parseCents; SQLite REAL → integer cents)
//   current_bid     → current_bid_cents (parseCents)
//   bid_count       → bid_count       (integer)
//   condition       → condition       (verbatim)
//   brand           → brand           (normalizeBrand)
//   category        → category_raw    (verbatim)
//   location        → location        (verbatim)
//   state           → state           (verbatim)
//   closes_at       → closes_at       (ISO string or null on parse failure)
//   url             → url             (verbatim; NOT NULL — row skipped if missing)
//   discount_pct    → discount_pct    (REAL nullable)
//   raw_json        → raw_json        (JSON parse → object; null on failure)
//   first_seen_at   → first_seen_at   (ISO string)
//   last_seen_at    → last_seen_at    (ISO string)
//   (absent)        → upc             (extracted from raw_json.upc via normalizeUpc)
//   (absent)        → model           (not present in SQLite; null)
//   (absent)        → final_bid_cents (not present in scrape; null)
//   (absent)        → category_id     (null; set by --resolve-categories pass)

// Skip reasons — tracked for the report.
const SKIP_REASONS = {
  source_filtered: 0,
  null_title: 0,
  empty_title: 0,
  null_url: 0,
  malformed_closes_at: 0,
};

function safeParseTimestamp(raw) {
  if (raw == null) return null;
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function safeParseJson(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseImageUrls(stockImageUrl, imagesJson) {
  const urls = [];

  // images_json is a JSON array of URL strings. Malformed → [].
  let parsed = [];
  try {
    const v = JSON.parse(imagesJson || '[]');
    if (Array.isArray(v)) parsed = v;
  } catch {
    // malformed — default to empty
  }

  // Deduplicate: stock_image_url + images_json items.
  const seen = new Set();
  for (const u of [stockImageUrl, ...parsed]) {
    if (typeof u === 'string' && !seen.has(u)) {
      seen.add(u);
      if (isSafeImageUrl(u)) urls.push(u);
    }
  }

  return urls;
}

/**
 * Normalize one SQLite row into a competitor_lots payload.
 * Returns null if the row should be skipped (with reason logged).
 */
function normalizeRow(row) {
  // Source filter.
  if (SOURCE_FILTER && row.source !== SOURCE_FILTER) {
    SKIP_REASONS.source_filtered++;
    return null;
  }

  // Required: title.
  if (row.title == null) {
    SKIP_REASONS.null_title++;
    return null;
  }
  const title = String(row.title).trim().replace(/\s+/g, ' ');
  if (!title) {
    SKIP_REASONS.empty_title++;
    return null;
  }

  // Required: url.
  if (!row.url) {
    SKIP_REASONS.null_url++;
    return null;
  }

  // closes_at: best-effort ISO string. Never crash on malformed input.
  let closes_at = null;
  if (row.closes_at) {
    closes_at = safeParseTimestamp(row.closes_at);
    if (closes_at === null) {
      SKIP_REASONS.malformed_closes_at++;
      // Do NOT skip the row — just store NULL for closes_at.
    }
  }

  // raw_json: parse to object.
  const rawJsonObj = safeParseJson(row.raw_json);

  // UPC: not in the SQLite schema as a top-level column, but present in
  // raw_json.upc for MAC.BID rows. Use normalizeUpc on that value.
  const upcRaw = rawJsonObj ? rawJsonObj.upc : null;
  const upc = normalizeUpc(upcRaw);

  // image_urls: merge stock_image_url + images_json; filter through allowlist.
  const image_urls = parseImageUrls(row.stock_image_url, row.images_json);

  // Timing fields.
  const first_seen_at = safeParseTimestamp(row.first_seen_at) || new Date().toISOString();
  const last_seen_at  = safeParseTimestamp(row.last_seen_at)  || new Date().toISOString();

  return {
    source:             row.source,
    source_id:          String(row.source_id),
    title,
    description:        row.description ? String(row.description).trim() || null : null,
    brand:              normalizeBrand(row.brand),
    model:              null,          // not present in SQLite schema; reserved for enrichment
    upc,
    category_raw:       row.category ? String(row.category).trim() || null : null,
    category_id:        null,          // populated later by --resolve-categories
    msrp_cents:         parseCents(row.msrp),
    current_bid_cents:  parseCents(row.current_bid),
    final_bid_cents:    null,          // not scraped yet (requires closed-lot re-scrape)
    bid_count:          row.bid_count != null ? parseInt(row.bid_count, 10) || null : null,
    discount_pct:       row.discount_pct != null ? parseFloat(row.discount_pct) || null : null,
    condition:          row.condition ? String(row.condition).trim() || null : null,
    location:           row.location  ? String(row.location).trim()  || null : null,
    state:              row.state     ? String(row.state).trim()     || null : null,
    closes_at,
    url:                String(row.url),
    image_urls,
    raw_json:           rawJsonObj,
    first_seen_at,
    last_seen_at,
    created_at:         first_seen_at,
    updated_at:         last_seen_at,
  };
}

// ── Post-load indexes ──────────────────────────────────────────────────────────
// These are the CREATE INDEX commands from 0037_competitor_lots.sql,
// transcribed verbatim so --apply-indexes can run them independently.

const POST_LOAD_INDEXES = [
  {
    name: 'competitor_lots_source_seen_idx',
    sql: `CREATE INDEX IF NOT EXISTS competitor_lots_source_seen_idx
          ON competitor_lots (source, last_seen_at DESC)`,
    desc: 'source + recency — incremental scrape refresh queries',
  },
  {
    name: 'competitor_lots_title_trgm_idx',
    sql: `CREATE INDEX IF NOT EXISTS competitor_lots_title_trgm_idx
          ON competitor_lots USING GIN (title gin_trgm_ops)
          WHERE (NOT closed) OR (closed AND final_bid_cents IS NOT NULL)`,
    desc: 'GIN trigram on title — fuzzy keyword search (pg_trgm required)',
  },
  {
    name: 'competitor_lots_brand_idx',
    sql: `CREATE INDEX IF NOT EXISTS competitor_lots_brand_idx
          ON competitor_lots (brand)
          WHERE brand IS NOT NULL`,
    desc: 'brand partial index — excludes NULLs to keep index small',
  },
  {
    name: 'competitor_lots_sold_comps_idx',
    sql: `CREATE INDEX IF NOT EXISTS competitor_lots_sold_comps_idx
          ON competitor_lots (closes_at)
          WHERE closed = true AND final_bid_cents IS NOT NULL`,
    desc: 'sold comps — price comp queries by closes_at',
  },
  {
    name: 'competitor_lots_category_idx',
    sql: `CREATE INDEX IF NOT EXISTS competitor_lots_category_idx
          ON competitor_lots (category_id)
          WHERE category_id IS NOT NULL`,
    desc: 'category joins to categories table',
  },
  {
    name: 'competitor_lots_upc_idx',
    sql: `CREATE INDEX IF NOT EXISTS competitor_lots_upc_idx
          ON competitor_lots (upc)
          WHERE upc IS NOT NULL`,
    desc: 'UPC — joins to product_lookups for enrichment',
  },
];

// ── Supabase client ───────────────────────────────────────────────────────────

function makeSupabaseClient() {
  const { createClient } = require('@supabase/supabase-js');
  const ws = require('ws');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n' +
      'Set them in .env.migrations.local or apps/operator-web/.env.local'
    );
    process.exit(1);
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws },
  });
}

// ── Report writer ─────────────────────────────────────────────────────────────

function formatPct(n, total) {
  if (!total) return '0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

function writeReport({
  timestamp,
  dbPath,
  sourceFilter,
  totalSourceRows,
  totalMappable,
  skippedReasons,
  sampleRows,
  fieldStats,
  distinctConditions,
  imageHostStats,
  estimatedBatches,
  batchSize,
}) {
  const dir = path.join(__dirname, '.import-reports');
  fs.mkdirSync(dir, { recursive: true });
  const filename = path.join(dir, `competitor-lots-${timestamp}.md`);

  const lines = [];
  lines.push(`# Competitor Lots Import Dry-Run Report`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**SQLite source:** \`${dbPath}\``);
  lines.push(`**Source filter:** \`${sourceFilter}\``);
  lines.push(`**Mode:** dry-run (no Postgres writes)`);
  lines.push('');
  lines.push('## Idempotency guarantee');
  lines.push('');
  lines.push(
    'Re-running this script with `--commit` against the same SQLite file is safe. ' +
    'The upsert RPC (`upsert_competitor_lots_batch`) uses `ON CONFLICT (source, source_id) DO UPDATE` ' +
    'and only touches live fields: `current_bid_cents`, `final_bid_cents`, `bid_count`, ' +
    '`discount_pct`, `last_seen_at`, `raw_json`, `updated_at`. ' +
    'Stable fields (`title`, `msrp_cents`, `first_seen_at`, `url`, `image_urls`) are **not** ' +
    'overwritten on conflict. When the source data is identical, the UPDATE is a logical no-op at ' +
    'the Postgres tuple level (same values written → xmax increments but no page churn).'
  );
  lines.push('');
  lines.push('## Row counts');
  lines.push('');
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total rows in SQLite \`lots\` table | ${totalSourceRows.toLocaleString()} |`);
  lines.push(`| Rows matching source filter (\`${sourceFilter}\`) | ${totalMappable.toLocaleString()} |`);
  lines.push(`| Skipped: source filtered | ${(skippedReasons.source_filtered || 0).toLocaleString()} |`);
  lines.push(`| Skipped: null title | ${(skippedReasons.null_title || 0).toLocaleString()} |`);
  lines.push(`| Skipped: empty title | ${(skippedReasons.empty_title || 0).toLocaleString()} |`);
  lines.push(`| Skipped: null URL | ${(skippedReasons.null_url || 0).toLocaleString()} |`);
  lines.push(`| Rows with malformed closes_at (stored as NULL) | ${(skippedReasons.malformed_closes_at || 0).toLocaleString()} |`);
  lines.push(`| **Estimated DB writes** | **~${totalMappable.toLocaleString()} upserts** |`);
  lines.push(`| Estimated batches (batch size ${batchSize}) | ~${estimatedBatches} |`);
  lines.push('');
  lines.push('## Field fill rates (macbid rows)');
  lines.push('');
  lines.push('| Field | Filled | % |');
  lines.push('|-------|--------|---|');
  for (const [field, count] of Object.entries(fieldStats)) {
    lines.push(`| \`${field}\` | ${count.toLocaleString()} | ${formatPct(count, totalMappable)} |`);
  }
  lines.push('');
  lines.push('## Distinct `condition` values');
  lines.push('');
  lines.push('These are the raw condition strings from the scraper. The importer stores');
  lines.push('them verbatim in `competitor_lots.condition` for downstream normalization.');
  lines.push('');
  for (const c of distinctConditions) {
    lines.push(`- \`${c}\``);
  }
  lines.push('');
  lines.push('## Image URL host analysis');
  lines.push('');
  lines.push(
    '`isSafeImageUrl()` filters image URLs against `ALLOWED_IMAGE_HOSTS`. ' +
    'Hosts **not** on the allowlist are dropped — `image_urls` will be empty for rows whose ' +
    'images only come from blocked hosts.'
  );
  lines.push('');
  lines.push('| Hostname | Count in source | On allowlist? | Action |');
  lines.push('|----------|-----------------|---------------|--------|');
  for (const [host, { count, allowed }] of Object.entries(imageHostStats)) {
    const action = allowed
      ? 'stored'
      : '**dropped** — add to `ALLOWED_IMAGE_HOSTS` + `is_safe_image_url()` SQL if approved';
    lines.push(`| \`${host}\` | ${count.toLocaleString()} | ${allowed ? 'yes' : 'NO'} | ${action} |`);
  }
  lines.push('');
  lines.push('> **TODO:** `media.mac.bid` and `s3.amazonaws.com` account for the majority of');
  lines.push('> MAC.BID product images. Until they are added to `ALLOWED_IMAGE_HOSTS`, all');
  lines.push('> MAC.BID `image_urls` will be `{}`. Add them to both:');
  lines.push('> - `packages/domain-lotting/src/lookup/merge.ts` → `ALLOWED_IMAGE_HOSTS`');
  lines.push('> - `packages/db/migrations/0038_normalize_helpers.sql` → `is_safe_image_url()`');
  lines.push('');
  lines.push('## Cents-conversion sanity check');
  lines.push('');
  lines.push('Spot-checking the first 5 sample rows for obvious garbage in price fields:');
  lines.push('');
  lines.push('| source_id | msrp_cents | msrp_dollars | current_bid_cents |');
  lines.push('|-----------|------------|--------------|-------------------|');
  for (const r of sampleRows.slice(0, 5)) {
    const msrpDollars = r.msrp_cents != null ? `$${(r.msrp_cents / 100).toFixed(2)}` : 'NULL';
    lines.push(`| ${r.source_id} | ${r.msrp_cents ?? 'NULL'} | ${msrpDollars} | ${r.current_bid_cents ?? 'NULL'} |`);
  }
  lines.push('');
  lines.push('## Sample normalized rows (first 5 mappable)');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(sampleRows.slice(0, 5), null, 2));
  lines.push('```');
  lines.push('');

  fs.writeFileSync(filename, lines.join('\n'), 'utf8');
  return filename;
}

// ── --apply-indexes mode ──────────────────────────────────────────────────────

async function applyIndexes() {
  console.log('[apply-indexes] Running post-load CREATE INDEX statements...');
  const supabase = makeSupabaseClient();

  const PAT = process.env.SUPABASE_ACCESS_TOKEN;
  const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;

  if (!PAT) {
    console.error(
      '[apply-indexes] SUPABASE_ACCESS_TOKEN required for DDL.\n' +
      'Set it in .env.migrations.local or export it before running.'
    );
    process.exit(1);
  }

  // The ref used to default to the upstream project (this repo's upstream). A
  // PAT reaches both projects, so an unset ref ran CREATE INDEX against
  // another company's production database. This is DDL; it does not guess.
  if (!PROJECT_REF) {
    console.error(
      '[apply-indexes] SUPABASE_PROJECT_REF is not set.\n\n' +
      '  This step runs DDL through the Management API and will not guess\n' +
      '  which project to alter. Set the ref explicitly:\n\n' +
      '    $env:SUPABASE_PROJECT_REF = "npwseclcxcatjhgjrtwe"\n' +
      '    node scripts/import-competitor-lots.js --apply-indexes\n\n' +
      '  or add SUPABASE_PROJECT_REF to .env.migrations.local at the repo root.\n' +
      '  BinGo prod is npwseclcxcatjhgjrtwe — confirm the ref before applying.'
    );
    process.exit(1);
  }
  console.log(`[apply-indexes] target: project ${PROJECT_REF}`);

  const baseUrl = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;

  for (const idx of POST_LOAD_INDEXES) {
    process.stdout.write(`  CREATE INDEX ${idx.name} ... `);
    const t0 = Date.now();
    try {
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${PAT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: idx.sql }),
      });
      if (!res.ok) {
        const txt = await res.text();
        let msg;
        try { msg = JSON.parse(txt).message || txt; } catch { msg = txt; }
        console.log(`FAIL — ${msg}`);
      } else {
        console.log(`ok (${Date.now() - t0}ms) — ${idx.desc}`);
      }
    } catch (e) {
      console.log(`FAIL — ${e.message}`);
    }
  }

  console.log('[apply-indexes] done.');
  process.exit(0);
}

// ── --resolve-categories mode ─────────────────────────────────────────────────
// Calls the resolve_category_ids_batch RPC (if available from the schema
// agent) to populate category_id from category_raw values.

async function resolveCategories(supabase) {
  console.log('[resolve-categories] Resolving category IDs via RPC...');

  // Fetch distinct category_raw values that have no category_id yet.
  const { data: rawCats, error } = await supabase
    .from('competitor_lots')
    .select('category_raw')
    .is('category_id', null)
    .not('category_raw', 'is', null);

  if (error) {
    console.error('  Failed to fetch category_raw values:', error.message);
    return;
  }

  const unique = [...new Set((rawCats || []).map((r) => r.category_raw).filter(Boolean))];
  console.log(`  Found ${unique.length} distinct unresolved category_raw values`);

  if (!unique.length) return;

  // Call the resolve RPC if it exists.
  try {
    const { data: resolved, error: rpcErr } = await supabase.rpc(
      'resolve_category_ids_batch',
      { raw_values: unique }
    );
    if (rpcErr) throw new Error(rpcErr.message);

    // PERF-6 (2026-05-24 audit): group resolved rows by category_id so we issue
    // one UPDATE per distinct category rather than one per raw value. At 10k+
    // distinct category_raw strings this reduces serial DB trips from O(N) to
    // O(distinct category IDs) — typically 20-200 vs 10,000+.
    //
    // resolved: [{ raw, category_id }]
    const byCategoryId = /** @type {Map<string, string[]>} */ (new Map());
    for (const { raw, category_id } of resolved || []) {
      if (!category_id) continue;
      if (!byCategoryId.has(category_id)) byCategoryId.set(category_id, []);
      byCategoryId.get(category_id).push(raw);
    }

    let updated = 0;
    const updateErrors = [];
    for (const [category_id, rawValues] of byCategoryId) {
      const { error: upErr } = await supabase
        .from('competitor_lots')
        .update({ category_id })
        .in('category_raw', rawValues)
        .is('category_id', null);
      if (upErr) {
        updateErrors.push(`category_id=${category_id}: ${upErr.message}`);
      } else {
        updated += rawValues.length;
      }
    }
    for (const msg of updateErrors) {
      console.error(`  Update failed for ${msg}`);
    }
    console.log(`  Resolved ${updated}/${unique.length} category_raw values (${byCategoryId.size} batch UPDATE${byCategoryId.size === 1 ? '' : 's'})`);
  } catch (e) {
    console.error(`  resolve_category_ids_batch RPC not found or failed: ${e.message}`);
    console.error('  Apply migration 0033+ and ensure the category resolver RPC exists.');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (APPLY_INDEXES) {
    await applyIndexes();
    return;
  }

  // ── Open SQLite ───────────────────────────────────────────────────────────
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (_e) {
    console.error(
      'better-sqlite3 not installed.\n' +
      'Run: npm install better-sqlite3 --save-dev\n' +
      '(It should already be listed in the root package.json devDependencies.)'
    );
    process.exit(1);
  }

  const resolvedDbPath = path.resolve(DB_PATH);
  if (!fs.existsSync(resolvedDbPath)) {
    console.error(`SQLite file not found: ${resolvedDbPath}`);
    process.exit(1);
  }

  const db = new Database(resolvedDbPath, { readonly: true });
  console.log(`[sqlite] opened: ${resolvedDbPath}`);

  // Total row count.
  const totalSourceRows = db.prepare('SELECT COUNT(*) AS c FROM lots').get().c;
  console.log(`[sqlite] total rows in lots table: ${totalSourceRows.toLocaleString()}`);

  // Rows matching source filter.
  const filteredCount = db.prepare(
    'SELECT COUNT(*) AS c FROM lots WHERE source = ?'
  ).get(SOURCE_FILTER).c;
  console.log(`[sqlite] rows matching source=${SOURCE_FILTER}: ${filteredCount.toLocaleString()}`);

  const effectiveLimit = ROW_LIMIT || filteredCount;
  console.log(`[mode] ${COMMIT ? 'COMMIT (writing to Postgres)' : 'DRY-RUN (no writes)'}`);
  if (ROW_LIMIT) console.log(`[limit] processing first ${ROW_LIMIT} rows only`);

  // ── Collect stats and sample rows for the report ─────────────────────────
  // We always process ALL rows (up to --limit) through the normalizer to build
  // accurate field stats. The SMOKE-TEST note in the brief says "don't
  // actually run the import" — we honour that by limiting the Postgres writes
  // to --commit mode only. The normalizer pass here is cheap (pure JS, no I/O).
  const fieldStats = {
    brand: 0, category_raw: 0, msrp_cents: 0, current_bid_cents: 0,
    bid_count: 0, discount_pct: 0, upc: 0, description: 0,
    image_urls_nonempty: 0, closes_at: 0,
    // Multi-identifier stats (product_lookups population).
    identifier_real_upc: 0, identifier_asin: 0, identifier_fnsku: 0,
    identifier_lpn: 0, identifier_none: 0,
  };
  const imageHostCounts = {};
  const sampleRows = [];

  // Reset skip-reason counters (they may have been touched during module load
  // if we ran any test rows; safer to zero them before the main pass).
  for (const k of Object.keys(SKIP_REASONS)) SKIP_REASONS[k] = 0;

  // Prepare streaming statement.
  const stmt = db.prepare(`SELECT * FROM lots WHERE source = ? LIMIT ?`);

  let totalNormalized = 0;
  let processedCount = 0;
  const t0 = Date.now();

  // Batch accumulator for competitor_lots Postgres writes.
  let pgBatch = [];
  let totalInserted = 0;
  let totalUpdated = 0;
  let batchNum = 0;
  const totalBatches = Math.ceil(effectiveLimit / BATCH_SIZE);

  // Batch accumulator for product_lookups writes (--populate-lookups).
  let lookupsBatch = [];
  let totalLookupsUpserted = 0;
  let totalLookupsErrors = 0;
  let lookupsBatchNum = 0;
  // Identifier stats for logging.
  const identifierStats = { upc: 0, asin: 0, fnsku: 0, lpn: 0, none: 0 };

  let supabase;
  if (COMMIT) {
    supabase = makeSupabaseClient();
    if (POPULATE_LOOKUPS) {
      console.log('[product_lookups] populate-lookups enabled — will upsert catalog rows alongside competitor_lots');
    }
  }

  // ── Image host tracking (sample first 2000 rows for the report) ───────────
  const imgSampleStmt = db.prepare(
    `SELECT stock_image_url, images_json FROM lots WHERE source = ? LIMIT 2000`
  );
  for (const row of imgSampleStmt.iterate(SOURCE_FILTER)) {
    const allUrls = [];
    if (row.stock_image_url) allUrls.push(row.stock_image_url);
    try {
      const parsed = JSON.parse(row.images_json || '[]');
      if (Array.isArray(parsed)) allUrls.push(...parsed);
    } catch {/* ignore */}

    for (const u of allUrls) {
      if (typeof u !== 'string') continue;
      let host;
      try { host = new URL(u).hostname.toLowerCase(); } catch { host = 'INVALID'; }
      if (!imageHostCounts[host]) imageHostCounts[host] = { count: 0, allowed: isSafeImageUrl(u) };
      imageHostCounts[host].count++;
    }
  }

  // ── Main streaming pass ───────────────────────────────────────────────────
  for (const row of stmt.iterate(SOURCE_FILTER, effectiveLimit)) {
    processedCount++;

    const normalized = normalizeRow(row);
    if (!normalized) continue;

    totalNormalized++;

    // Update field stats.
    if (normalized.brand)              fieldStats.brand++;
    if (normalized.category_raw)       fieldStats.category_raw++;
    if (normalized.msrp_cents != null) fieldStats.msrp_cents++;
    if (normalized.current_bid_cents != null) fieldStats.current_bid_cents++;
    if (normalized.bid_count != null)  fieldStats.bid_count++;
    if (normalized.discount_pct != null) fieldStats.discount_pct++;
    if (normalized.upc)                fieldStats.upc++;
    if (normalized.description)        fieldStats.description++;
    if (normalized.image_urls.length)  fieldStats.image_urls_nonempty++;
    if (normalized.closes_at)          fieldStats.closes_at++;

    // Track multi-identifier stats (always, even in dry-run mode).
    {
      const rawJsonObj = normalized.raw_json;
      const { upc: idUpc, asin: idAsin, fnsku: idFnsku, lpn: idLpn } = extractIdentifiers(rawJsonObj, normalized.title);
      if (idUpc)        fieldStats.identifier_real_upc++;
      else if (idAsin)  fieldStats.identifier_asin++;
      else if (idFnsku) fieldStats.identifier_fnsku++;
      else if (idLpn)   fieldStats.identifier_lpn++;
      else              fieldStats.identifier_none++;
    }

    // Collect first 5 sample rows.
    if (sampleRows.length < 5) sampleRows.push(normalized);

    // In commit mode: accumulate into batch and flush.
    if (COMMIT) {
      pgBatch.push(normalized);

      if (pgBatch.length >= BATCH_SIZE) {
        batchNum++;
        const result = await flushBatch(supabase, pgBatch, batchNum, totalBatches, totalNormalized, effectiveLimit);
        totalInserted += result.inserted;
        totalUpdated  += result.updated;
        pgBatch = [];
      }

      // product_lookups population: extract identifiers from raw_json and
      // build a catalog row. We do this in parallel with competitor_lots writes
      // using a separate (smaller) batch accumulator.
      if (POPULATE_LOOKUPS) {
        const rawJsonObj = normalized.raw_json;
        const identifiers = extractIdentifiers(rawJsonObj, normalized.title);
        const { upc, asin, fnsku, lpn } = identifiers;

        // Track which identifier type is most common in this source.
        if (upc)       identifierStats.upc++;
        else if (asin) identifierStats.asin++;
        else if (fnsku) identifierStats.fnsku++;
        else if (lpn)  identifierStats.lpn++;
        else           identifierStats.none++;

        const lookupRow = buildLookupRow(normalized, identifiers);
        if (lookupRow) {
          lookupsBatch.push(lookupRow);

          if (lookupsBatch.length >= LOOKUPS_BATCH_SIZE) {
            lookupsBatchNum++;
            const lr = await flushLookupsBatch(supabase, lookupsBatch, lookupsBatchNum);
            totalLookupsUpserted += lr.upserted;
            totalLookupsErrors   += lr.errors;
            lookupsBatch = [];
          }
        }
      }
    }
  }

  // Flush final partial competitor_lots batch.
  if (COMMIT && pgBatch.length > 0) {
    batchNum++;
    const result = await flushBatch(supabase, pgBatch, batchNum, totalBatches, totalNormalized, effectiveLimit);
    totalInserted += result.inserted;
    totalUpdated  += result.updated;
    pgBatch = [];
  }

  // Flush final partial product_lookups batch.
  if (COMMIT && POPULATE_LOOKUPS && lookupsBatch.length > 0) {
    lookupsBatchNum++;
    const lr = await flushLookupsBatch(supabase, lookupsBatch, lookupsBatchNum);
    totalLookupsUpserted += lr.upserted;
    totalLookupsErrors   += lr.errors;
    lookupsBatch = [];
  }

  db.close();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const throughput = totalNormalized > 0 ? Math.round(totalNormalized / (parseFloat(elapsed) || 1)) : 0;

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n=== Summary ===');
  console.log(`  Source rows scanned:    ${processedCount.toLocaleString()}`);
  console.log(`  Normalized (mappable):  ${totalNormalized.toLocaleString()}`);
  console.log(`  Skipped reasons:`);
  for (const [k, v] of Object.entries(SKIP_REASONS)) {
    if (v > 0) console.log(`    ${k}: ${v}`);
  }
  if (COMMIT) {
    console.log(`  Inserted: ${totalInserted.toLocaleString()}`);
    console.log(`  Updated:  ${totalUpdated.toLocaleString()}`);
    if (POPULATE_LOOKUPS) {
      console.log(`  product_lookups upserted: ${totalLookupsUpserted.toLocaleString()}`);
      if (totalLookupsErrors > 0) {
        console.log(`  product_lookups errors:   ${totalLookupsErrors.toLocaleString()}`);
      }
      console.log('  Identifier breakdown:');
      console.log(`    Real UPC:  ${identifierStats.upc.toLocaleString()}`);
      console.log(`    ASIN only: ${identifierStats.asin.toLocaleString()}`);
      console.log(`    FNSKU only: ${identifierStats.fnsku.toLocaleString()}`);
      console.log(`    LPN only:  ${identifierStats.lpn.toLocaleString()}`);
      console.log(`    No ID:     ${identifierStats.none.toLocaleString()}`);
    }
  }
  console.log(`  Elapsed:  ${elapsed}s`);
  console.log(`  Throughput: ${throughput} rows/sec`);

  // Distinct conditions.
  const conditionStmt = new Database(resolvedDbPath, { readonly: true });
  const conditions = conditionStmt
    .prepare(`SELECT DISTINCT condition FROM lots WHERE source = ? ORDER BY condition`)
    .all(SOURCE_FILTER)
    .map((r) => r.condition)
    .filter(Boolean);
  conditionStmt.close();

  // ── Write dry-run report ──────────────────────────────────────────────────
  if (!COMMIT) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = writeReport({
      timestamp,
      dbPath: resolvedDbPath,
      sourceFilter: SOURCE_FILTER,
      totalSourceRows,
      totalMappable: totalNormalized,
      skippedReasons: { ...SKIP_REASONS },
      sampleRows,
      fieldStats,
      distinctConditions: conditions,
      imageHostStats: imageHostCounts,
      estimatedBatches: Math.ceil(totalNormalized / BATCH_SIZE),
      batchSize: BATCH_SIZE,
    });
    console.log(`\n[report] written: ${reportPath}`);
  }

  // ── Optional category resolution pass ────────────────────────────────────
  if (COMMIT && RESOLVE_CATS && supabase) {
    await resolveCategories(supabase);
  }

  if (COMMIT && totalInserted + totalUpdated > 0) {
    console.log('\n[done] Next step: run --apply-indexes when the bulk load is complete.');
  }
}

// ── Batch flusher ─────────────────────────────────────────────────────────────

async function flushBatch(supabase, rows, batchNum, totalBatches, totalSoFar, total) {
  process.stdout.write(
    `\r[${String(batchNum).padStart(3)}/${totalBatches}] ${totalSoFar.toLocaleString()} / ${total.toLocaleString()} rows...`
  );

  // Try the server-side RPC first (1 round-trip per batch).
  // Fall back to direct upsert if the RPC doesn't exist yet
  // (e.g., migration 0039 not yet applied).
  try {
    const { data, error } = await supabase.rpc('upsert_competitor_lots_batch', {
      p_rows: rows,
    });

    if (error) {
      // RPC not found → fall back to direct upsert.
      if (/not found|does not exist|42883/i.test(error.message)) {
        return await flushBatchDirect(supabase, rows);
      }
      throw new Error(error.message);
    }

    return {
      inserted: data?.inserted ?? 0,
      updated:  data?.updated  ?? 0,
    };
  } catch (e) {
    // Network / unexpected error. Log and continue so one bad batch
    // doesn't abort a 295k row import.
    console.error(`\n  [batch ${batchNum}] error: ${e.message}`);
    return { inserted: 0, updated: 0 };
  }
}

async function flushBatchDirect(supabase, rows) {
  // Direct upsert fallback: used when 0039 RPC not yet applied.
  // onConflict mergeToQuery is not available in the JS client, so we use the
  // standard upsert with ignoreDuplicates=false to get DO UPDATE behaviour.
  const { error, count } = await supabase
    .from('competitor_lots')
    .upsert(rows, {
      onConflict: 'source,source_id',
      ignoreDuplicates: false,
      count: 'exact',
    });

  if (error) {
    console.error(`\n  [direct upsert] error: ${error.message}`);
    return { inserted: 0, updated: 0 };
  }

  // Without RETURNING we can't distinguish insert vs update; report as inserted.
  return { inserted: count ?? rows.length, updated: 0 };
}

main().catch((e) => {
  console.error('fatal:', e.message || e);
  process.exit(1);
});
