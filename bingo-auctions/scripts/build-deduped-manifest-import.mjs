#!/usr/bin/env node
// build-deduped-manifest-import.mjs
//
// Vendor-agnostic manifest deduper. Reads one or more raw vendor manifests
// (.json arrays and/or .xlsx), removes duplicate rows by a vendor-specific
// identity key, optionally excludes rows whose return-tracking number is
// already present in a prod operator's `import_rows`, and writes a clean
// net-new .xlsx that PRESERVES the original column names + order so the
// operator-web ImportWizard (HEADER_PATTERNS auto-detect) maps it unchanged.
//
// Usage:
//   node scripts/build-deduped-manifest-import.mjs \
//     --inputs "C:/path/*.json" \
//     --output ./deduped.xlsx \
//     --vendor wayfair \
//     [--filter-against-prod <operatorId>]
//
// Flags:
//   --inputs <glob|path>        One or more glob/path values. Repeatable, OR
//                               pass several comma-separated. Matches .json + .xlsx.
//   --output <file>             Output .xlsx path (required).
//   --vendor <name>             wayfair | amazon | generic | auto (default: auto).
//                               `auto` sniffs the header set of the first file.
//   --filter-against-prod <id>  Operator UUID. Excludes input rows whose tracking
//                               number already exists in that operator's import_rows.
//                               Requires env SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
//                               (read from env ONLY — never hardcoded). If either is
//                               missing the filter is skipped with a clear warning.
//   --sheet <name>              Force a specific XLSX sheet name (default: largest).
//   -h, --help                  Show help.
//
// Identity keys (case-insensitive, trimmed):
//   wayfair: OrderID + ItemNumber + ReturnTrackingNumber
//   amazon:  ASIN + FNSKU + OrderID
//   generic: every populated identifier-ish field (sku/upc/asin/fnsku/lpn/
//            tracking/order/po), joined.
//
// Network: NONE unless --filter-against-prod is given. No secrets in source.
// Local-only tool — not deployed, not imported by app code. The OUTPUT file is
// hand-fed into apps/operator-web .../imports/new/ImportWizard.tsx.

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';

// ---------------------------------------------------------------------------
// Identity-field config
// ---------------------------------------------------------------------------

// Per-vendor ordered identity fields. Lookup is case-/whitespace-insensitive
// (we normalize both the row's header keys and these names before matching).
const VENDOR_KEY_FIELDS = {
  wayfair: ['OrderID', 'ItemNumber', 'ReturnTrackingNumber'],
  amazon: ['ASIN', 'FNSKU', 'OrderID'],
};

// Generic fallback: any populated identifier-ish field contributes to the key.
// Substrings are matched against the normalized header (so `Return Tracking
// Number`, `tracking_no`, `PO Number` all hit). Ordered for stable keys.
const GENERIC_KEY_HINTS = [
  'fnsku',
  'asin',
  'lpn',
  'upc',
  'sku',
  'tracking',
  'order',
  'po',
];

// Header signatures used to auto-detect a vendor when --vendor is omitted.
// A vendor wins if ALL of its required normalized headers are present.
const VENDOR_SIGNATURES = [
  { vendor: 'wayfair', requires: ['orderid', 'itemnumber', 'returntrackingnumber'] },
  { vendor: 'amazon', requires: ['asin', 'fnsku'] },
];

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

// Lowercase, strip zero-width chars, trim, collapse internal whitespace, and
// drop non-alphanumerics. Used so `Return Tracking Number`, `ReturnTrackingNumber`
// and `return_tracking_number` all normalize to the same token for matching.
function normalizeHeader(header) {
  if (header === null || header === undefined) return '';
  return String(header)
    .toLowerCase()
    .replace(/[​-‍﻿]/g, '')
    .replace(/[\s_\-./]+/g, '')
    .trim();
}

// Build { normalizedHeader -> originalKey } for one row object.
function buildHeaderMap(row) {
  const map = {};
  for (const k of Object.keys(row)) {
    const n = normalizeHeader(k);
    // First original key wins on collision (stable, deterministic).
    if (!(n in map)) map[n] = k;
  }
  return map;
}

// Trimmed string value for a normalized field name, or '' if absent/blank.
function valueFor(row, headerMap, normalizedName) {
  const origKey = headerMap[normalizedName];
  if (origKey === undefined) return '';
  const v = row[origKey];
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

// ---------------------------------------------------------------------------
// Identity key + dedup (pure — unit-tested)
// ---------------------------------------------------------------------------

// Build a stable, case-insensitive identity key for a row given a vendor.
// Returns '' when no identifier fields are populated (caller treats '' as
// "no key" and keeps the row rather than collapsing all blanks together).
export function buildIdentityKey(row, vendor, headerMap = buildHeaderMap(row)) {
  if (vendor === 'wayfair' || vendor === 'amazon') {
    const parts = VENDOR_KEY_FIELDS[vendor].map((f) =>
      valueFor(row, headerMap, normalizeHeader(f)).toLowerCase(),
    );
    return parts.some((p) => p !== '') ? parts.join('|') : '';
  }

  // generic / auto-without-match: collect every populated identifier-ish field.
  const parts = [];
  for (const normName of Object.keys(headerMap)) {
    if (!GENERIC_KEY_HINTS.some((h) => normName.includes(h))) continue;
    const v = valueFor(row, headerMap, normName).toLowerCase();
    if (v !== '') parts.push(`${normName}=${v}`);
  }
  return parts.length ? parts.sort().join('|') : '';
}

// Dedup an array of rows, keeping the FIRST occurrence of each identity key.
// Rows whose key is '' (no identifiers at all) are always kept — we never
// collapse distinct unidentifiable rows into one.
export function dedupeRows(rows, vendor) {
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const row of rows) {
    const key = buildIdentityKey(row, vendor);
    if (key !== '' && seen.has(key)) {
      dropped++;
      continue;
    }
    if (key !== '') seen.add(key);
    out.push(row);
  }
  return { rows: out, dropped };
}

// Decide a vendor from a normalized header set. Returns 'wayfair' | 'amazon'
// | 'generic'. `generic` when nothing matches.
export function detectVendor(normalizedHeaderSet) {
  for (const sig of VENDOR_SIGNATURES) {
    if (sig.requires.every((h) => normalizedHeaderSet.has(h))) return sig.vendor;
  }
  return 'generic';
}

// ---------------------------------------------------------------------------
// Input reading
// ---------------------------------------------------------------------------

// Convert a shell-style wildcard segment (* and ?) into an anchored RegExp.
// Only `*` (any run) and `?` (single char) are supported — enough for the
// documented `*.json` / `*.xlsx` usage. Matching is case-insensitive so
// Windows `*.XLSX` works too.
function wildcardToRegExp(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`, 'i');
}

// Expand a list of glob/path strings to a de-duplicated, sorted file list.
// Self-contained (no `node:fs/promises` glob — that export does not exist on
// the repo's pinned Node 20.10). Wildcards are honored in the FINAL path
// segment only (e.g. "C:/manifests/*.json"); the directory part is literal.
function expandInputs(patterns) {
  const found = new Set();
  for (const pat of patterns) {
    // A bare path with no wildcard is taken verbatim if it exists.
    if (!/[*?]/.test(pat)) {
      try {
        statSync(pat);
        found.add(resolve(pat));
      } catch {
        console.warn(`WARN  input path not found: ${pat}`);
      }
      continue;
    }
    // Wildcard in the basename: list the (literal) directory and match names.
    const dir = dirname(pat);
    const re = wildcardToRegExp(basename(pat));
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      console.warn(`WARN  cannot read directory for pattern: ${pat}`);
      continue;
    }
    let matched = 0;
    for (const ent of entries) {
      if (ent.isFile() && re.test(ent.name)) {
        found.add(resolve(join(dir, ent.name)));
        matched++;
      }
    }
    if (matched === 0) console.warn(`WARN  no files matched pattern: ${pat}`);
  }
  return [...found].sort();
}

// Pick the largest non-empty sheet (by parsed row count), or a forced name.
function pickSheet(workbook, preferredName) {
  if (preferredName && workbook.Sheets[preferredName]) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[preferredName], { defval: null });
    return { name: preferredName, rows };
  }
  let best = { name: null, rows: [] };
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: null });
    if (rows.length > best.rows.length) best = { name, rows };
  }
  return best;
}

// Read a single input file into an array of plain row objects. Supports a
// top-level JSON array (or { rows: [...] } / { data: [...] } wrappers) and
// .xlsx/.xls. Malformed/non-object rows are skipped with a warning.
function readInputFile(filePath, preferredSheet) {
  const lower = filePath.toLowerCase();
  let raw;

  if (lower.endsWith('.json')) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.warn(`WARN  skipping ${filePath}: invalid JSON (${e.message})`);
      return [];
    }
    if (Array.isArray(parsed)) raw = parsed;
    else if (parsed && Array.isArray(parsed.rows)) raw = parsed.rows;
    else if (parsed && Array.isArray(parsed.data)) raw = parsed.data;
    else {
      console.warn(`WARN  skipping ${filePath}: JSON is not an array (or {rows}/{data})`);
      return [];
    }
  } else if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    let wb;
    try {
      wb = XLSX.readFile(filePath, { cellDates: false });
    } catch (e) {
      console.warn(`WARN  skipping ${filePath}: cannot read workbook (${e.message})`);
      return [];
    }
    const { name, rows } = pickSheet(wb, preferredSheet);
    console.log(`  ${filePath} -> sheet="${name}" rows=${rows.length}`);
    raw = rows;
  } else {
    console.warn(`WARN  skipping ${filePath}: unsupported extension (need .json/.xlsx)`);
    return [];
  }

  // Defensive: keep only plain non-null objects (skip nulls, arrays, scalars).
  const clean = [];
  let bad = 0;
  for (const r of raw) {
    if (r && typeof r === 'object' && !Array.isArray(r)) clean.push(r);
    else bad++;
  }
  if (bad > 0) console.warn(`WARN  ${filePath}: skipped ${bad} malformed (non-object) row(s)`);
  return clean;
}

// ---------------------------------------------------------------------------
// Prod tracking-number filter (network ONLY when --filter-against-prod is set)
// ---------------------------------------------------------------------------

// Load every non-null import_rows.tracking_number for one operator into a Set
// of normalized (digits-stripped-lower) tokens. Paginates 1000 at a time.
async function loadProdTrackingNumbers(supabase, operatorId) {
  const set = new Set();
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('import_rows')
      .select('tracking_number')
      .eq('operator_id', operatorId)
      .not('tracking_number', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`import_rows query failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      const t = normalizeTracking(r.tracking_number);
      if (t) set.add(t);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return set;
}

// Normalize a tracking value for cross-source comparison: lowercase + trim.
// Tracking can be alphanumeric (carrier prefixes), so we do NOT strip letters.
function normalizeTracking(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().toLowerCase();
}

// Find the original header key in a row that holds the return tracking number.
// Prefers an exact vendor field, else any header containing "tracking".
function trackingValueOf(row, headerMap) {
  const direct = valueFor(row, headerMap, 'returntrackingnumber');
  if (direct) return normalizeTracking(direct);
  for (const normName of Object.keys(headerMap)) {
    if (normName.includes('tracking')) {
      const v = valueFor(row, headerMap, normName);
      if (v) return normalizeTracking(v);
    }
  }
  return '';
}

// Exclude rows whose tracking number is already in prodTrackingSet.
function filterAgainstProd(rows, prodTrackingSet) {
  const out = [];
  let dropped = 0;
  for (const row of rows) {
    const t = trackingValueOf(row, buildHeaderMap(row));
    if (t && prodTrackingSet.has(t)) {
      dropped++;
      continue;
    }
    out.push(row);
  }
  return { rows: out, dropped };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// Union of every row's original column names, in first-seen order. This is the
// header order the output XLSX will use so ImportWizard auto-detect still maps.
function collectHeaderOrder(rows) {
  const order = [];
  const seen = new Set();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
  }
  return order;
}

// Write rows to a single-sheet .xlsx preserving original headers + order.
function writeOutputXlsx(rows, headerOrder, outPath) {
  const sheet = XLSX.utils.json_to_sheet(rows, { header: headerOrder });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Manifest');
  XLSX.writeFile(wb, outPath);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  // Keep in sync with the top-of-file usage block.
  console.log(`build-deduped-manifest-import.mjs — vendor-agnostic manifest deduper

Usage:
  node scripts/build-deduped-manifest-import.mjs \\
    --inputs "C:/path/*.json" --output ./deduped.xlsx --vendor wayfair \\
    [--filter-against-prod <operatorId>]

Flags:
  --inputs <glob|path>        Repeatable; or comma-separated. Matches .json + .xlsx.
  --output <file>             Output .xlsx path (required).
  --vendor <name>             wayfair | amazon | generic | auto   (default: auto)
  --filter-against-prod <id>  Operator UUID. Excludes rows whose tracking already
                              exists in that operator's import_rows. Needs env
                              SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env only).
  --sheet <name>              Force an XLSX sheet name (default: largest sheet).
  -h, --help                  Show this help.

Identity keys (case-insensitive, trimmed):
  wayfair: OrderID + ItemNumber + ReturnTrackingNumber
  amazon:  ASIN + FNSKU + OrderID
  generic: every populated identifier-ish field (sku/upc/asin/fnsku/lpn/tracking/order/po)

Network calls happen ONLY with --filter-against-prod. No secrets are read from source.`);
}

// Minimal flag parser. --inputs is repeatable and also accepts comma lists.
function parseArgs(argv) {
  const opts = { inputs: [], output: null, vendor: 'auto', filterAgainstProd: null, sheet: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--inputs':
        for (const part of String(next() ?? '').split(',')) {
          const p = part.trim();
          if (p) opts.inputs.push(p);
        }
        break;
      case '--output':
        opts.output = next();
        break;
      case '--vendor':
        opts.vendor = String(next() ?? 'auto').toLowerCase();
        break;
      case '--filter-against-prod':
        opts.filterAgainstProd = next();
        break;
      case '--sheet':
        opts.sheet = next();
        break;
      default:
        console.warn(`WARN  ignoring unknown argument: ${a}`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.inputs.length === 0 || !opts.output) {
    console.error('ERROR  --inputs and --output are required. Use --help for usage.');
    process.exitCode = 1;
    return;
  }
  const validVendors = new Set(['wayfair', 'amazon', 'generic', 'auto']);
  if (!validVendors.has(opts.vendor)) {
    console.error(`ERROR  --vendor must be one of: ${[...validVendors].join(', ')}`);
    process.exitCode = 1;
    return;
  }

  // 1. Read all inputs.
  const files = expandInputs(opts.inputs);
  if (files.length === 0) {
    console.error(`ERROR  no files matched --inputs ${JSON.stringify(opts.inputs)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Reading ${files.length} input file(s):`);
  let allRows = [];
  for (const f of files) allRows = allRows.concat(readInputFile(f, opts.sheet));
  const inputCount = allRows.length;
  if (inputCount === 0) {
    console.error('ERROR  no usable rows found across inputs.');
    process.exitCode = 1;
    return;
  }

  // 2. Resolve vendor (explicit or auto-detected from first row's headers).
  let vendor = opts.vendor;
  let detected = null;
  if (vendor === 'auto') {
    const headerSet = new Set(Object.keys(buildHeaderMap(allRows[0])));
    detected = detectVendor(headerSet);
    vendor = detected;
  }

  // 3. Dedup on identity key (keep first).
  const { rows: dedupedRows, dropped: dedupDropped } = dedupeRows(allRows, vendor);

  // 4. Optional prod tracking filter.
  let afterProdRows = dedupedRows;
  let prodDropped = 0;
  let prodFilterApplied = false;
  if (opts.filterAgainstProd) {
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      console.warn(
        'WARN  --filter-against-prod requested but SUPABASE_URL and/or ' +
          'SUPABASE_SERVICE_ROLE_KEY are not set in the environment — SKIPPING prod filter. ' +
          '(Set both env vars to enable. They are never read from source.)',
      );
    } else {
      // Import lazily so no network/dep cost when the filter is not used.
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      console.log(`Loading prod tracking numbers for operator ${opts.filterAgainstProd}...`);
      const prodTracking = await loadProdTrackingNumbers(supabase, opts.filterAgainstProd);
      console.log(`  loaded ${prodTracking.size} existing tracking number(s)`);
      const res = filterAgainstProd(afterProdRows, prodTracking);
      afterProdRows = res.rows;
      prodDropped = res.dropped;
      prodFilterApplied = true;
    }
  }

  // 5. Write output preserving original headers + order.
  const headerOrder = collectHeaderOrder(afterProdRows);
  writeOutputXlsx(afterProdRows, headerOrder, opts.output);

  // 6. Stats.
  console.log('\n=== Stats ===');
  console.log(`  vendor:            ${vendor}${detected ? ' (auto-detected)' : ''}`);
  console.log(`  input rows:        ${inputCount}`);
  console.log(`  after dedup:       ${dedupedRows.length}  (removed ${dedupDropped} duplicate(s))`);
  if (prodFilterApplied) {
    console.log(`  after prod filter: ${afterProdRows.length}  (removed ${prodDropped} already-in-prod)`);
  } else {
    console.log(`  after prod filter: ${afterProdRows.length}  (filter not applied)`);
  }
  console.log(`  output rows:       ${afterProdRows.length}`);
  console.log(`  output columns:    ${headerOrder.length}`);
  console.log(`  wrote:             ${resolve(opts.output)}`);
}

// Only run main() when invoked directly (not when imported by the unit test).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error('fatal:', e?.stack || e);
    process.exitCode = 1;
  });
}
