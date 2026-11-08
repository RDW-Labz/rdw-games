// Taxonomy-aware category scoring.
//
// We can't just compare slugs: "power-tools" vs "hand-tools" is closer than
// "power-tools" vs "lawn-care" (both are under home-improvement). The runtime
// AI output uses the LotTR-flavored CATEGORIES enum, not slugs, so we also
// need a mapping layer.
//
// Scoring:
//   1.0  exact slug match
//   0.5  same parent (sibling under the same top-level category)
//   0.0  miss
//
// Source of truth: packages/db/migrations/0018_categories.sql.
// We load + parse the seed INSERTs once at module load. If parsing breaks
// on a future migration edit, fall back to the hardcoded `FALLBACK_TAXONOMY`
// below — fixing the parser is a non-blocker for running an eval.
//
// TODO(human): if we ever split the taxonomy out of the SQL migration into
// a JSON file consumable by the app, point this at that JSON instead. The
// regex parser is intentionally a hack — half a page — because this is a
// scaffold and a real parser would be over-engineering.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, type Category } from '../../src/constants';

type Taxonomy = {
  /** slug -> parent slug ('' for top-level). */
  parents: Map<string, string>;
};

const FALLBACK_TAXONOMY: Taxonomy = {
  parents: new Map<string, string>([
    ['home-improvement', ''], ['outdoor-garden', ''], ['kitchen-dining', ''],
    ['bath', ''], ['electronics', ''], ['furniture', ''], ['apparel', ''],
    ['auto', ''], ['beauty', ''], ['health', ''], ['toys-games', ''],
    ['sports-fitness', ''], ['baby-kids', ''], ['pet-supplies', ''],
    ['office-school', ''], ['other-misc', ''],
    // a handful of leaves so the scaffold's tests can run without parsing SQL
    ['power-tools', 'home-improvement'],
    ['hand-tools', 'home-improvement'],
    ['hardware', 'home-improvement'],
    ['lighting', 'home-improvement'],
    ['vanities', 'bath'],
    ['faucets-fixtures', 'bath'],
    ['small-appliances', 'kitchen-dining'],
    ['major-appliances', 'kitchen-dining'],
    ['audio', 'electronics'],
    ['tvs', 'electronics'],
    ['computers', 'electronics'],
  ]),
};

let cached: Taxonomy | null = null;

function parseTaxonomyFromSql(sqlText: string): Taxonomy {
  const parents = new Map<string, string>();
  // Top-level inserts: ('slug', 'Name', 'icon', sort_order)  — no parent_id.
  const topRe = /\(\s*'([a-z0-9-]+)'\s*,\s*'[^']*'\s*,\s*'[^']*'\s*,\s*\d+\s*\)/g;
  for (const m of sqlText.matchAll(topRe)) {
    if (m[1]) parents.set(m[1], '');
  }
  // Child inserts: ('slug', 'Name', v_parent, sort_order)
  const childRe =
    /\(\s*'([a-z0-9-]+)'\s*,\s*'[^']*(?:''[^']*)*'\s*,\s*v_([a-z_]+)\s*,\s*\d+\s*\)/g;
  // v_<short> -> slug map (DECLARE block)
  const declareRe = /v_([a-z_]+)\s+UUID\s*:=\s*\(SELECT id FROM categories WHERE slug='([a-z0-9-]+)'\)/g;
  const varToSlug = new Map<string, string>();
  for (const m of sqlText.matchAll(declareRe)) {
    if (m[1] && m[2]) varToSlug.set(m[1], m[2]);
  }
  for (const m of sqlText.matchAll(childRe)) {
    const slug = m[1];
    const varName = m[2];
    if (!slug || !varName) continue;
    const parent = varToSlug.get(varName);
    if (parent) parents.set(slug, parent);
  }
  return { parents };
}

export function loadTaxonomy(): Taxonomy {
  if (cached) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const sqlPath = resolve(here, '../../../db/migrations/0018_categories.sql');
    const text = readFileSync(sqlPath, 'utf8');
    const parsed = parseTaxonomyFromSql(text);
    if (parsed.parents.size >= FALLBACK_TAXONOMY.parents.size) {
      cached = parsed;
      return cached;
    }
  } catch {
    // fall through
  }
  cached = FALLBACK_TAXONOMY;
  return cached;
}

/** Category-match score: 1.0 exact, 0.5 sibling, 0.0 miss. */
export function categoryMatchScore(
  actualSlug: string,
  expectedSlug: string,
): 0 | 0.5 | 1 {
  if (!actualSlug || !expectedSlug) return 0;
  if (actualSlug === expectedSlug) return 1;
  const tax = loadTaxonomy();
  const pa = tax.parents.get(actualSlug);
  const pe = tax.parents.get(expectedSlug);
  if (pa === undefined || pe === undefined) return 0;
  // Same parent (and parent is non-empty, i.e. both are leaves under the
  // same top-level category) → sibling match.
  if (pa && pe && pa === pe) return 0.5;
  // One is the parent of the other → also sibling-grade partial credit.
  if (pa === expectedSlug || pe === actualSlug) return 0.5;
  return 0;
}

/**
 * The runtime AI output uses the LotTR-flavored CATEGORIES enum (e.g.
 * 'Tools & Hardware'), not platform slugs. Coarse mapping for eval purposes.
 * The platform's category_aliases table is the real source of truth at
 * runtime — this map is only good enough for "did the model land in the
 * right top-level bucket?" scoring.
 */
const LEGACY_TO_TOP_SLUG: Record<Category, string> = {
  Electronics: 'electronics',
  Appliances: 'kitchen-dining',
  Furniture: 'furniture',
  'Tools & Hardware': 'home-improvement',
  'Home & Garden': 'outdoor-garden',
  'Toys & Games': 'toys-games',
  'Sporting Goods': 'sports-fitness',
  Kitchen: 'kitchen-dining',
  Clothing: 'apparel',
  'Health & Beauty': 'beauty',
  Automotive: 'auto',
  Office: 'office-school',
  Collectibles: 'other-misc',
  Other: 'other-misc',
};

/** Score the legacy enum output against an expected slug. */
export function legacyCategoryScore(
  actualLegacy: string,
  expectedSlug: string,
): 0 | 0.5 | 1 {
  const top = LEGACY_TO_TOP_SLUG[actualLegacy as Category];
  if (!top) return 0;
  return categoryMatchScore(top, expectedSlug);
}

// Make the legacy map inspectable from outside without re-defining it.
export { LEGACY_TO_TOP_SLUG };
// Silence "unused import" if a downstream consumer doesn't reference CATEGORIES
// directly — we imported it for the satisfies-style typing in LEGACY_TO_TOP_SLUG.
export const _CATEGORY_KEYS = CATEGORIES;
