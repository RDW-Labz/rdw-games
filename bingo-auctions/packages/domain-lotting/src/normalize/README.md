# normalize/

Canonical normalization functions for every ingestion path on the platform.

**One rule, one place.** CSV imports, the scraper, OpenRouter responses, mobile
photo capture, and competitor data all route through these modules. No other
file in the monorepo may define its own `parseCents`, `normalizeUpc`,
`isSafeImageUrl`, etc.

## Module map

| File | Exports | Notes |
|---|---|---|
| `upc.ts` | `normalizeUpc`, `normalizeAsin`, `isFakeUpc`, `isFakeAsin` | Digits-only; 8/12/13/14-digit length gate; bogus-pattern rejection |
| `money.ts` | `parseCents`, `centsToDollars`, `safeParseFloat` | Integer cents everywhere |
| `text.ts` | `normalizeBrand`, `normalizeModel`, `normalizeTitle`, `normalizeHeader` | Sentinel stripping; header normalizer for CSV auto-detect |
| `images.ts` | `ALLOWED_IMAGE_HOSTS`, `isSafeImageUrl`, `filterSafeImageUrls` | Security boundary M2 — allowlist enforced here and in SQL |
| `condition.ts` | `normalizeCondition`, `PlatformCondition` | Maps free-form → `appears_new \| open_box \| good \| as_is` |
| `category.ts` | `resolveCategoryAlias`, `resolveSingleCategory` | Wraps `resolve_category_ids_batch` RPC (migration 0033) |
| `identification.ts` | `normalizeIdentification`, `normalizePriceData` | AI output → typed structs; uses all atomic helpers |
| `stats.ts` | `mostCommon`, `median`, `average` | Price aggregation across eBay / OpenRouter results |
| `brand.ts` | `extractBrand`, `normalizeBrandFromInput`, `__test__BRAND_DICTIONARY_INVARIANTS` | Dictionary + heuristic brand extraction; ~350 alias entries across 20+ category groups |

## Bogus-identifier rejection

`normalizeUpc` and `normalizeAsin` both pass through an additional gate after
the format check: `isFakeUpc(digits)` and `isFakeAsin(asin)` respectively.
Any code that matches a known placeholder pattern is treated identically to
unparseable garbage — the caller receives `null`. This prevents scraper
placeholder values (e.g. MAC.BID emitting `'000000000000'` when no barcode
is on file) from polluting `product_lookups` and causing false-positive
barcode-scan matches.

Rejected patterns:

| Pattern | Example |
|---|---|
| All same digit | `000000000000`, `999999999999` |
| Sequential ascending (mod-10 wrap) | `012345678901`, `890123456789` |
| Sequential descending | `987654321098` |
| Repeated sub-pattern (period 2/3/4) | `121212121212`, `123412341234` |
| Explicit blocklist | `888888888888`, `000000000017` |
| ASIN: all-same suffix | `B000000000`, `BAAAAAAAAA` |
| ASIN: period-2 full string | `BABABABABA` |
| ASIN: sequential digit suffix | `B012345678` |

SQL mirrors live in `0044_normalize_quality.sql` as `is_fake_upc(text)` and
`is_fake_asin(text)`. The updated `normalize_upc(text)` and
`lookup_product_by_code(text)` SQL functions also use them.

### One-time cleanup

After applying migration 0044, run the cleanup script to remove any
already-stored bogus rows:

```bash
# Dry-run first (always safe):
NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  node scripts/cleanup-bogus-catalog.js

# Then commit:
node scripts/cleanup-bogus-catalog.js --commit
```

The script NULLs `upc` on affected `competitor_lots` rows (so the lot record
is preserved), and deletes affected `product_lookups` rows (catalog entries
that were keyed on a bogus UPC have no valid identity to preserve).

After cleanup, the `upc-fake-zeros-rejected` and `asin-fake-zeros` smoke tests
in `scripts/smoke-test-lookups.js` should pass against the live deployment.

## DB mirrors

`packages/db/migrations/0038_normalize_helpers.sql` contains SQL equivalents
of the four pure-data functions:

- `normalize_upc(text)` ↔ `normalizeUpc` (updated in 0044 to call `is_fake_upc`)
- `normalize_brand(text)` ↔ `normalizeBrand`
- `parse_dollars_to_cents(text)` ↔ `parseCents`
- `is_safe_image_url(text)` ↔ `isSafeImageUrl`

`packages/db/migrations/0044_normalize_quality.sql` adds:

- `is_fake_upc(text)` ↔ `isFakeUpc`
- `is_fake_asin(text)` ↔ `isFakeAsin`

Keep the SQL and TS allowlists in sync when adding a new CDN host or new
bogus-pattern blocklist entry.

`packages/db/migrations/0040_extract_brand.sql` contains SQL equivalents of the brand extraction functions:

- `extract_brand(text)` ↔ `extractBrand` — uses the `brand_aliases` seed table
- `enrich_brands_batch(table, batch_size)` — backfill RPC for bulk-updating brand IS NULL rows

When adding new entries to `BRAND_DICTIONARY` in `brand.ts`, add the same aliases to the `brand_aliases` INSERT in `0040_extract_brand.sql` and run `enrich_brands_batch` again to pick up previously-null rows.

## Brand Extraction

`brand.ts` provides dictionary-based brand inference from free-text product titles. No LLM calls — cost is O(1) per row regardless of scale.

### API

```ts
import { extractBrand, normalizeBrandFromInput } from '@auction-platform/domain-lotting';

// Infer brand from a product title (scraper / manifest / AI output).
extractBrand('DEWALT 20V Cordless Drill Kit')           // → 'DeWalt'
extractBrand('Instant Pot Duo 7-in-1 Pressure Cooker') // → 'Instant Pot'
extractBrand('Roomba i3+ Self-Emptying Robot Vacuum')  // → 'iRobot'
extractBrand('Organic applesauce 24 oz')               // → null  (word-boundary guard)
extractBrand(null)                                     // → null

// Canonicalize a brand string from a scraper field (may be wrong-case, etc.).
normalizeBrandFromInput('BLACK & DECKER')   // → 'Black+Decker'
normalizeBrandFromInput('dewalt')           // → 'DeWalt'
normalizeBrandFromInput('N/A')             // → null  (sentinel strip)
normalizeBrandFromInput('Acme Tools')      // → 'Acme Tools'  (not in dict, passthrough)
```

### How it works

1. **Dictionary lookup** — ~350 lowercase aliases across 20+ category groups.
   Each alias is compiled at module load into a `\b…\b` word-boundary `RegExp`
   (case-insensitive). Aliases are sorted by length descending so multi-word
   names like `"Black & Decker"` always beat shorter aliases like `"Black"`.

2. **Heuristic fallback** — when no dictionary entry matches, a regex checks
   whether the title starts with a `ProperCase` token followed by a
   model-number-shaped second token (`E-310`, `885`, `DCD771C2`). If the first
   token is not in a denylist of common English words, it is returned as the
   brand. This catches brands not yet in the dictionary (e.g. `"Fiskars"`).

3. **Returns null on ambiguity** — the heuristic never fires on single-word
   titles or when the second token is all-lowercase, minimising false positives.

### Wire-in points

Every ingestion path calls `extractBrand` automatically — no per-path changes needed:

| Path | How brand is set |
|---|---|
| Scraper → `upsert_competitor_lots_batch` | SQL: `COALESCE(normalize_brand(payload_brand), extract_brand(title))` in migration 0041 |
| CSV import → `commitImport` | TS: `brand = brandRaw ?? extractBrand(title)` in `actions.ts` |
| AI identification → `normalizeIdentification` | TS: falls back to `extractBrand(title)` when AI returns empty brand |
| Product lookup cache → `upsertLookup` | TS: `!fresh.brand && fresh.title ? extractBrand(title)` in `cache.ts` |
| Existing rows (backfill) | SQL: `enrich_brands_batch(table, batch_size)` RPC via `scripts/run-brand-backfill.js` |

### Brands needing human review

See the "Flags for review" note at the top of `brand.ts`. Key ambiguities:

- **"Apple"** — caught by `\bapple\b`; guards against "applesauce" correctly but
  titles like "Apple cider vinegar 16oz" will incorrectly match. Acceptable
  because the product catalog almost never has grocery items.
- **"Stanley"** — matches Stanley tools AND Stanley cups/thermoses. Both map to
  the same canonical (`Stanley`) so it's not wrong, just worth knowing.
- **"Echo"** — matches Echo lawn equipment AND Amazon Echo smart speakers.
  Both map to `Echo` — if you need to distinguish them, split by category.
- **"Delta"** — has the `"delta faucet"` alias ranked above plain `"delta"`
  to reduce false hits on "Delta Airlines" style titles.
- **"Pilot"** — stationery brand; could fire on aviation product titles.
- **"Champion"** — apparel brand; could fire on sports result text.
- **"Columbia"** — apparel; could match "Columbia University" in description text.

## Usage

```ts
import {
  parseCents,
  normalizeUpc,
  isSafeImageUrl,
  filterSafeImageUrls,
  normalizeBrand,
  normalizeCondition,
  resolveCategoryAlias,
} from '@auction-platform/domain-lotting';
```

Or import directly from the sub-module for tree-shaking:

```ts
import { parseCents } from '@auction-platform/domain-lotting/normalize/money';
```
