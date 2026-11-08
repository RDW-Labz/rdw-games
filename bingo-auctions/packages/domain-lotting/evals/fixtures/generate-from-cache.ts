// Bootstrap fixture files from the live product_lookups cache.
//
// We seed the cache as we run real lots through the platform. Once a few
// hundred high-confidence rows accumulate, we can use them as ground-truth
// for the eval suite — the cache is our best source of "what would a
// human label this as?" answers because it's been through retailer
// scraping + manual operator correction in the (operator)/lots flow.
//
// ----------------------------------------------------------------------------
// Usage
// ----------------------------------------------------------------------------
//
//   SUPABASE_URL=https://xxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
//   npx tsx packages/domain-lotting/evals/fixtures/generate-from-cache.ts \
//     --type=upc_lookups --limit=50
//
// Flags:
//   --type=<manifest_rows|photos|upc_lookups>   Required.
//   --limit=N                                   Default 50.
//   --min-confidence=<high|medium|low>          Default 'high'.
//   --output-dir=<path>                         Default this script's
//                                               sibling directory for the
//                                               given type.
//   --overwrite                                 Replace existing files with
//                                               the same fixture id (default
//                                               is to skip).
//   --dry-run                                   Print what would be written
//                                               without touching the disk.
//   --help                                      Print this and exit.
//
// We DON'T run this in CI — it hits the database. It's a developer tool
// for periodic fixture-pool refreshes.
//
// ----------------------------------------------------------------------------
// What it pulls
// ----------------------------------------------------------------------------
//
// SELECT upc, title, brand, model, category_id, msrp_cents, image_urls,
//        confidence, sources
//   FROM product_lookups
//  WHERE category_id IS NOT NULL
//    AND title IS NOT NULL
//    AND brand IS NOT NULL
//    AND confidence IN ('high', 'medium')         -- skip 'low' / 'none'
//    AND identity_refreshed_at > now() - interval '90 days'
//  ORDER BY identity_refreshed_at DESC
//  LIMIT N;
//
// We then JOIN against `categories` to resolve the category_id back to a
// slug (the fixture format stores slugs, not UUIDs — fixtures should be
// stable across DB resets).
//
// ----------------------------------------------------------------------------

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { GroundTruth, LabeledManifestRow, LabeledPhoto, LabeledUpcLookup } from '../types';
import type { Category } from '../../src/constants';
import { LEGACY_TO_TOP_SLUG } from '../metrics';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

type FixtureType = 'manifest_rows' | 'photos' | 'upc_lookups';

type Args = {
  type: FixtureType | null;
  limit: number;
  minConfidence: 'high' | 'medium' | 'low';
  outputDir: string | null;
  overwrite: boolean;
  dryRun: boolean;
  help: boolean;
};

const HELP = `evals/fixtures/generate-from-cache.ts

Pulls high-confidence rows from product_lookups and writes labeled fixture
files for the eval harness.

Usage:
  npx tsx packages/domain-lotting/evals/fixtures/generate-from-cache.ts \\
    --type=<manifest_rows|photos|upc_lookups> [--limit=N] \\
    [--min-confidence=high|medium|low] [--output-dir=PATH] \\
    [--overwrite] [--dry-run]

Required env:
  SUPABASE_URL                Project URL.
  SUPABASE_SERVICE_ROLE_KEY   Service-role key (RLS bypass — read only).

Examples:
  # Pull 50 UPC fixtures into the default directory.
  npx tsx ... --type=upc_lookups --limit=50

  # Preview manifest fixtures without writing.
  npx tsx ... --type=manifest_rows --limit=20 --dry-run
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    type: null,
    limit: 50,
    minConfidence: 'high',
    outputDir: null,
    overwrite: false,
    dryRun: false,
    help: false,
  };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--overwrite') args.overwrite = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--type=')) args.type = a.slice('--type='.length) as FixtureType;
    else if (a.startsWith('--limit=')) args.limit = Number.parseInt(a.slice('--limit='.length), 10);
    else if (a.startsWith('--min-confidence=')) {
      const v = a.slice('--min-confidence='.length);
      if (v === 'high' || v === 'medium' || v === 'low') args.minConfidence = v;
    } else if (a.startsWith('--output-dir=')) args.outputDir = a.slice('--output-dir='.length);
  }
  return args;
}

// ---------------------------------------------------------------------------
// DB row shape — narrow projection of product_lookups + categories.slug
// ---------------------------------------------------------------------------

type CacheRow = {
  upc: string;
  title: string | null;
  brand: string | null;
  model: string | null;
  msrp_cents: number | null;
  image_urls: string[] | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  sources: string[] | null;
  description: string | null;
  category_slug: string;
};

function confidenceAtLeast(row: CacheRow['confidence'], min: Args['minConfidence']): boolean {
  const order: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3 };
  return (order[row] ?? 0) >= (order[min] ?? 0);
}

// ---------------------------------------------------------------------------
// Slug → legacy enum mapping (inverse of LEGACY_TO_TOP_SLUG).
//
// We don't have a clean inverse because multiple Category values map to the
// same slug (e.g. 'Appliances' and 'Kitchen' both → kitchen-dining in the
// pre-0034 tree). Pick the most-specific Category for the slug we land on.
// ---------------------------------------------------------------------------

const SLUG_TO_LEGACY: Record<string, Category> = (() => {
  // Build a "canonical" inverse: if multiple legacy enums map to the same
  // top-slug, prefer the more-specific one (Appliances over Kitchen, etc).
  const overrides: Record<string, Category> = {
    'kitchen-dining': 'Kitchen',
    appliances: 'Appliances',
    'major-appliances': 'Appliances',
    'small-appliances': 'Appliances',
    bath: 'Furniture',
    'home-improvement': 'Tools & Hardware',
    'outdoor-garden': 'Home & Garden',
    electronics: 'Electronics',
    furniture: 'Furniture',
    apparel: 'Clothing',
    auto: 'Automotive',
    beauty: 'Health & Beauty',
    health: 'Health & Beauty',
    'toys-games': 'Toys & Games',
    'sports-fitness': 'Sporting Goods',
    'office-school': 'Office',
  };

  const out: Record<string, Category> = {};
  for (const [slug, override] of Object.entries(overrides)) {
    out[slug] = override;
  }
  // Fill in defaults from the LEGACY_TO_TOP_SLUG map so every leaf slug
  // has at least an 'Other' fallback.
  for (const cat of Object.keys(LEGACY_TO_TOP_SLUG) as Category[]) {
    const slug = LEGACY_TO_TOP_SLUG[cat];
    if (slug && !(slug in out)) out[slug] = cat;
  }
  return out;
})();

function legacyForSlug(slug: string): Category {
  return SLUG_TO_LEGACY[slug] ?? 'Other';
}

// ---------------------------------------------------------------------------
// Supabase fetch
// ---------------------------------------------------------------------------

async function fetchRows(
  client: SupabaseClient,
  args: Args,
): Promise<CacheRow[]> {
  // Two-step: pull cache rows, then resolve category_id → slug. We don't
  // assume a foreign-key relationship is configured for PostgREST joins
  // (it might not be in dev databases), so we do the join manually.
  const { data: lookups, error } = await client
    .from('product_lookups')
    .select(
      'upc, title, brand, model, category_id, msrp_cents, image_urls, confidence, sources, description, identity_refreshed_at',
    )
    .not('category_id', 'is', null)
    .not('title', 'is', null)
    .not('brand', 'is', null)
    .order('identity_refreshed_at', { ascending: false })
    .limit(args.limit * 4); // overfetch — confidence + dedupe filtering trims it down

  if (error) {
    throw new Error(`product_lookups fetch failed: ${error.message}`);
  }
  if (!lookups || lookups.length === 0) return [];

  // Resolve category_id → slug.
  const categoryIds = Array.from(
    new Set(
      (lookups as Array<{ category_id: string | null }>)
        .map((r) => r.category_id)
        .filter((v): v is string => typeof v === 'string'),
    ),
  );
  const { data: cats, error: catErr } = await client
    .from('categories')
    .select('id, slug')
    .in('id', categoryIds);
  if (catErr) {
    throw new Error(`categories fetch failed: ${catErr.message}`);
  }
  const idToSlug = new Map<string, string>();
  for (const c of (cats ?? []) as Array<{ id: string; slug: string }>) {
    idToSlug.set(c.id, c.slug);
  }

  const out: CacheRow[] = [];
  for (const r of lookups as Array<{
    upc: string;
    title: string | null;
    brand: string | null;
    model: string | null;
    category_id: string | null;
    msrp_cents: number | null;
    image_urls: string[] | null;
    confidence: 'high' | 'medium' | 'low' | 'none';
    sources: string[] | null;
    description: string | null;
  }>) {
    if (!r.category_id) continue;
    const slug = idToSlug.get(r.category_id);
    if (!slug) continue;
    if (!confidenceAtLeast(r.confidence, args.minConfidence)) continue;
    out.push({
      upc: r.upc,
      title: r.title,
      brand: r.brand,
      model: r.model,
      msrp_cents: r.msrp_cents,
      image_urls: r.image_urls ?? [],
      confidence: r.confidence,
      sources: r.sources ?? [],
      description: r.description,
      category_slug: slug,
    });
    if (out.length >= args.limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function safeFilenameSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function expectedFromRow(row: CacheRow): GroundTruth {
  return {
    title: row.title ?? '',
    brand: row.brand ?? '',
    model: row.model ?? '',
    category_slug: row.category_slug,
    category_legacy: legacyForSlug(row.category_slug),
    // We don't know condition from cache (fresh retail data). Leave empty.
    condition: '',
    msrp_cents: row.msrp_cents ?? 0,
  };
}

function buildUpcFixture(row: CacheRow, idx: number): LabeledUpcLookup {
  const isAsin = /^B0[A-Z0-9]{8,}$/i.test(row.upc);
  const isEan = !isAsin && row.upc.length === 13;
  const codeType: LabeledUpcLookup['code_type'] = isAsin ? 'asin' : isEan ? 'ean' : 'upc';
  return {
    id: `gen-upc-${String(idx).padStart(3, '0')}-${safeFilenameSlug(`${row.brand} ${row.model}`)}`,
    code: row.upc,
    code_type: codeType,
    expected: expectedFromRow(row),
    notes: `Generated from product_lookups (${row.confidence}-confidence cache row, sources: ${(row.sources ?? []).join(', ')}).`,
  };
}

function buildManifestFixture(row: CacheRow, idx: number): LabeledManifestRow {
  // We synthesize a "raw" retailer description from the cache title — in
  // practice you'd want to sample a real manifest CSV separately, but the
  // cache gives us a clean idealized version for sanity-check coverage.
  const desc = row.title ?? `${row.brand ?? ''} ${row.model ?? ''}`.trim();
  return {
    id: `gen-manifest-${String(idx).padStart(3, '0')}-${safeFilenameSlug(`${row.brand} ${row.model}`)}`,
    source: 'other',
    raw: {
      description: desc,
      retailer_category: row.category_slug,
      upc: row.upc,
      ...(row.model ? { model_number: row.model } : {}),
      quantity: 1,
      ...(row.msrp_cents ? { retail_price: row.msrp_cents / 100 } : {}),
    },
    expected: {
      ...expectedFromRow(row),
      condition: 'New/Sealed',
      expected_confidence:
        row.confidence === 'high' ? 'high' : row.confidence === 'medium' ? 'medium' : 'low',
    },
    notes: `Generated from product_lookups cache (${row.confidence}). Synthesized retailer description from cached title — replace with a real manifest row if you have one for this UPC.`,
  };
}

function buildPhotoFixture(row: CacheRow, idx: number): LabeledPhoto {
  const slug = safeFilenameSlug(`${row.brand} ${row.model}`);
  // Cache exposes image URLs but we don't download them — the cache may be
  // reading from retailer CDNs whose terms forbid redistribution. We write
  // the sidecar with a TODO image_path that the operator drops a real photo
  // into.
  const id = `gen-photo-${String(idx).padStart(3, '0')}-${slug}`;
  return {
    id,
    image_path: `${id}.jpg`,
    media_type: 'image/jpeg',
    photo_quality_label: 'clear',
    expected: {
      ...expectedFromRow(row),
      upc: row.upc,
      condition: 'New/Sealed',
      expected_confidence:
        row.confidence === 'high' ? 'high' : row.confidence === 'medium' ? 'medium' : 'low',
    },
    notes: `Generated from product_lookups cache. Image suggestions: ${(row.image_urls ?? [])
      .slice(0, 3)
      .join(' | ') || 'none in cache — capture a fresh photo and drop it next to this JSON'}.`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.type) {
    // eslint-disable-next-line no-console
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }
  if (!['manifest_rows', 'photos', 'upc_lookups'].includes(args.type)) {
    // eslint-disable-next-line no-console
    console.error(`[generate-from-cache] unknown --type=${args.type}`);
    process.exit(1);
  }

  const url = process.env['SUPABASE_URL'];
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!url || !key) {
    // eslint-disable-next-line no-console
    console.error(
      '[generate-from-cache] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.',
    );
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = args.outputDir ?? resolve(here, args.type);
  if (!args.dryRun && !existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const client = createClient(url, key, { auth: { persistSession: false } });
  // eslint-disable-next-line no-console
  console.log(`[generate-from-cache] fetching rows (type=${args.type}, limit=${args.limit}, min-confidence=${args.minConfidence})`);
  const rows = await fetchRows(client, args);
  // eslint-disable-next-line no-console
  console.log(`[generate-from-cache] ${rows.length} candidate rows`);

  let written = 0;
  let skipped = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const fixture =
      args.type === 'upc_lookups'
        ? buildUpcFixture(row, i + 1)
        : args.type === 'manifest_rows'
          ? buildManifestFixture(row, i + 1)
          : buildPhotoFixture(row, i + 1);

    const path = join(outDir, `${fixture.id}.json`);
    if (!args.overwrite && existsSync(path)) {
      skipped += 1;
      continue;
    }
    if (args.dryRun) {
      // eslint-disable-next-line no-console
      console.log(`[dry-run] would write ${path}`);
    } else {
      writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
    }
    written += 1;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[generate-from-cache] done — wrote ${written}, skipped ${skipped} (existing files; pass --overwrite to replace)`,
  );
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[generate-from-cache] failed:', err);
  process.exit(1);
});
