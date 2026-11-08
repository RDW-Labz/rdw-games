# Plan — Universal web scraper + image-enrichment wiring — 2026-05-30

**Status: Part A IMPLEMENTED (PR open, owner review pending). Part B PLAN.**

Two related but independent fixes, drafted together because they share the
same SaaS principle (format-coupled, not vendor-coupled) and the same
delivery surface (operator-web).

Triggered by 2026-05-30 owner question: a Wayfair item found via Google
Shopping failed one-click import; "we are hardcoding just due to one style
of manifest." Both halves of this patch remove per-vendor branches.

---

## Empirical baseline (verified 2026-05-30)

### Wayfair manifest (`Wayfair_Returns_combined_full_flat_file - Michael Test.xlsx`)
- 16,686 rows. **Photo URLs already present on 9,942 rows (59%)** — Wayfair ships images. Image enrichment is a no-op for Wayfair manifests.
- Identifiers present: ProductSKU / SiteSKU / ManufactureSKU only. **No UPC, no ASIN, no FNSKU.** The 4 modules in `packages/image-enrichment` cannot enrich these rows.

### Amazon FBA returns manifest (`21184921.xlsx`)
- 22,162 rows. **Zero inline photo URLs.** All visual data must come from enrichment.
- **B00 ASIN populated on 21,742 / 22,162 rows (98.1%)** — near-universal Amazon image probe coverage.
- **UPC populated on 8,704 rows (39.3%)** — Open Food Facts coverage for grocery items (the manifest's category is `gl_grocery`).
- **FNSKU populated on 17,474 rows (78.8%)** — used at intake/scan time, not directly by enrichment.
- ISBN-shape GTINs on 405 rows (1.8%) — Open Library coverage.

**Conclusion:** image enrichment is high-leverage on Amazon-style manifests (no photos shipped, rich identifiers). Wayfair-style manifests (photos shipped, opaque vendor SKUs) get no benefit. Wiring enrichment universally — not vendor-conditionally — handles both correctly (enrichment runs when there's an identifier and no photo; otherwise no-ops).

---

## Part A — Universal web scraper (replaces per-source branches)

### Status: IMPLEMENTED — feat/universal-web-scraper, PR open

### What changed

`apps/operator-web/src/app/api/lottr/scrape-url/route.ts`:
- Deleted `extractAmazon`, `extractEbay`, `extractGoogle`
- Replaced with `extractProduct(html, url, isAmazon, warnings)` — 4-rung ladder:
  1. **JSON-LD Product** — `extractJsonLdBlocks` + `findProduct` (unchanged)
  2. **OpenGraph meta** — `og:title`, `og:image`, `og:price:amount` / `product:price:amount`, `og:description`, `product:brand`
  3. **schema.org itemprop meta** — `<meta itemprop="name">` etc. (older sites)
  4. **HTML fallback** — `<title>` + first `<img>` with non-trivial `src`
- Merge semantics: each rung fills only fields still null after earlier rungs
- ASIN extraction kept, now guarded by `isAmazon` flag (URL-pattern check, not vendor logic)
- Amazon-specific price/image/title DOM fallbacks kept inside `isAmazon` block
- Removed `ScrapeSource` type and per-source switch in `POST`
- Response field `source` renamed to `host` (informational hostname string)
- Host allowlist expanded to ~15 retailers (Amazon, eBay, Google, Wayfair, Target, Walmart, Home Depot, Lowes, Best Buy, Costco, Etsy, IKEA, Overstock, AliExpress, Alibaba) — owner to revise scope post-merge
- Unknown hosts return `unsupported_host` (not silently allowed — allowlist still active)
- Added response-size cap (2 MB) with streaming reader + abort
- Added content-type guard (reject non-HTML responses with 422)

`apps/operator-web/src/lib/safe-scrape-url.ts`:
- Verified: blocks all required SSRF vectors. Scheme guard (`protocol !== 'https:'`) implicitly rejects `data:`, `javascript:`, `file://`, `http://`. RFC1918 + loopback + link-local IPv4 all blocked. `localhost`, `0.0.0.0`, `::1` blocked.
- Not modified (already correct).

`apps/field-mobile/app/(staff)/lotting/web.tsx`:
- Updated copy: "Amazon, eBay, or Google Shopping" → "any retailer product page"
- Updated placeholder: `https://www.amazon.com/dp/B0…` → `https://… product page URL`
- Updated hint text: generic "any retailer" language
- Updated type annotation: `source: string` → `host: string` to match renamed response field
- OTA-able to preview channel only (no native rebuild needed)

New `apps/operator-web/src/app/api/lottr/scrape-url/__tests__/extract-product.test.ts`:
- 58 unit tests via Vitest
- 9 fixture files in `__tests__/fixtures/`
- Covers: Amazon (JSON-LD), Wayfair (JSON-LD), Target (JSON-LD array), Home Depot (JSON-LD), Lowes (JSON-LD), Walmart (OG-only), OG-only, schema-meta-only, HTML-fallback-only, JSON-LD+OG merge
- Merge semantics verified: JSON-LD title not overwritten by OG title
- Edge cases: empty HTML, ASIN only on Amazon URLs, additional_image_urls cap

New `apps/operator-web/vitest.config.ts` + `package.json` `test` script updated.

### Today (before this PR)
`apps/operator-web/src/app/api/lottr/scrape-url/route.ts` accepted only Amazon, eBay, and Google-Shopping single-product URLs (`detectSource` at L74-96). Every other host returned `unsupported_url`. Each source had its own extractor (`extractAmazon`, `extractEbay`, `extractGoogle`) — three near-identical functions that all started with JSON-LD Product extraction and added per-site DOM fallbacks.

### SSRF safety
- SSRF guard (`isSafeScrapeUrl`) runs first, always
- Host allowlist is a second layer (defense-in-depth). Owner will decide v2 scope.
- Response-size cap (2 MB) now enforced in the POST handler via streaming reader

---

## Part B — Image enrichment wiring (uses `packages/image-enrichment` from #133)

### Status: PLAN — separate PR, separate session

### Today
`packages/image-enrichment/` is merged + deployed (#133, sha `f213ae4`). It exposes:
- `amazon-asin-image.ts` — fetches public Amazon image URL pattern by ASIN.
- `open-food-facts-image.ts` — UPC → Open Food Facts API.
- `open-library-image.ts` — ISBN-shaped GTIN → Open Library covers.
- `music-brainz-image.ts` — MusicBrainz cover art (low priority — niche).

But **nothing calls it.** The package is built, tested, and idle. The import path (`apps/operator-web/src/app/(operator)/imports/actions.ts` `commitImport`) doesn't invoke it. Lot creation (`createDraftLotFromCandidate`) doesn't invoke it. So today's catalog gains zero enrichment.

### Universal wiring (background enrichment job)

Mirror the pattern from #126's `refund_jobs` queue + drain worker. New surfaces:

#### 1. New migration `0162_image_enrichment_jobs.sql`
```sql
CREATE TABLE image_enrichment_jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id     UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  target_table    TEXT NOT NULL CHECK (target_table IN ('import_rows', 'lots', 'product_lookups')),
  target_id       UUID NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'succeeded', 'failed', 'skipped')),
  attempts        INT NOT NULL DEFAULT 0,
  identifier_kind TEXT,
  identifier_value TEXT,
  resolved_image_url TEXT,
  error           TEXT,
  enqueued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  UNIQUE (target_table, target_id)
);
CREATE INDEX image_enrichment_jobs_pending_idx ON image_enrichment_jobs (status, enqueued_at) WHERE status IN ('pending', 'in_progress');
```

#### 2. Enqueue on import / lot create — **UNCONDITIONAL**

> **Design rule (owner-confirmed 2026-05-30):** never gate enqueue on
> vendor or on identifier presence. The job table is small, INSERTs are
> cheap, and the drain is where the "is this enrichable?" decision lives.
> This keeps the import path format-coupled, not vendor-coupled.

- **`commitImport`** (`apps/operator-web/src/app/(operator)/imports/actions.ts`):
  after inserting import_rows, INSERT one row into `image_enrichment_jobs`
  per import_row, unconditionally — `target_table='import_rows'`,
  `target_id=<row.id>`, `identifier_kind=NULL`, `identifier_value=NULL`,
  `status='pending'`. Seeding fires inside the existing transaction.
  No client wait. No `if (has_id)` branch.
- **`createDraftLotFromCandidate`** (or its wrapper): enqueue one job per
  newly-created lot with `target_table='lots'`. Same unconditional pattern.

Empirical justification for "no gating":
- Wayfair test file (9,063 rows): every row already has `photo_url` →
  drain step 1 short-circuits → all 9,063 jobs marked `skipped` in milliseconds.
  Zero wasted external API calls.
- Amazon FBA test file (22,162 rows): zero rows have `photo_url`, 98.1% have
  ASIN → drain proceeds to step 2 → ~21,742 enriched, ~420 skipped (no ID).
- Any future vendor: works the same. No code change needed when a new
  manifest format lands.

#### 3. Drain worker — mirror `refund_jobs`
- `apps/operator-web/src/lib/cron/image-enrichment-drain.ts` — pulls up to N
  pending jobs and, **per job, decides whether enrichment is even needed**:
  1. Read the target row (`import_rows` or `lots`). If `photo_url` is a real
     URL (`/^https?:\/\//.test(photo_url)`): mark `skipped` with reason
     `'already_has_photo'`. **No external API call.** This is the modern
     Wayfair path (newer manifest = real URL on every row).
     **IMPORTANT — placeholder rejection (older Wayfair 050826 finding):**
     do NOT treat the column as "has photo" just because it's non-null.
     Older Wayfair `2026-05-08` manifest had `Wayfair Site - Product
     Photos = "NA"` on **1,558 of 2,257 rows (69%)** — literal string
     `NA`, not a URL. Reject these values as no-photo and proceed to
     identifier detection: `NA`, `N/A`, `null`, `-`, `none`, `n/a`, empty
     string after `.trim()`. Treat as missing. Same defensive list for
     `lots.photo_urls[0]`.
  2. Detect identifier from row fields (`upc` / `asin` / `fnsku` / `lpn` /
     `external_code`) using `packages/image-enrichment/src/detect-identifier.ts`.
     If none detected: mark `skipped` with reason `'no_identifier'`. **No
     external API call.**
  3. Pick the right module by `identifier_kind` (ASIN -> `amazon-asin-image`,
     UPC -> `open-food-facts-image`, ISBN -> `open-library-image`), fetch the
     image URL.
  4. On success: UPDATE the target row's `photo_url` (or `lots.photo_urls`)
     AND mark job `succeeded` with `resolved_image_url` set.
  5. On 404 / not-found: mark `skipped` with reason `'upstream_not_found'`
     (so we don't retry forever).
  6. On HTTP / network error: increment `attempts`, mark `failed` after N
     attempts (default N=3).
- Persist `identifier_kind` and `identifier_value` on the job row when detected
  in step 2, so dashboards / debugging can answer "why did this job skip?"
- `apps/operator-web/src/app/api/cron/image-enrichment-drain/route.ts` — HTTP
  entry for the cron-trigger.
- `apps/cron-trigger/src/index.ts` — register the new cron.

#### 4. Identifier detection helper
- New `packages/image-enrichment/src/detect-identifier.ts` — given a row's `{ upc, asin, fnsku, lpn, external_code }`, returns `{ kind: 'asin' | 'upc' | 'isbn' | null, value: string }`. Format-coupled (same shape rules as `scan-extract/identifier-shapes.ts`).

#### 5. Importer header-pattern extension (for the Amazon-FBA-style files)
`apps/operator-web/src/app/(operator)/imports/new/ImportWizard.tsx` HEADER_PATTERNS already auto-maps `UPC`, `ASIN`, `FNSKU`, etc. for common header names. Add patterns for the spaced/dashed variants we see in the wild:
- `B00 Asin` -> `asin` (already matches `asin` substring, but verify).
- `Fn Sku` (with space) -> `fnsku`.
- `X-Z ASIN` (LPNO... values) -> `lpn`.

(Tiny addition — 1-2 regex tweaks in HEADER_PATTERNS.)

#### 6. Importer placeholder-normalisation (covers older Wayfair / any vendor)
Same `ImportWizard.tsx` row-mapping step (or its server-side counterpart in
`commitImport`): for every column the importer maps to `photo_url`, normalise
the value through `normalisePhotoUrl(raw): string | null`:
```ts
const PHOTO_PLACEHOLDERS = new Set(['', 'na', 'n/a', 'null', 'none', '-']);
export function normalisePhotoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (PHOTO_PLACEHOLDERS.has(trimmed.toLowerCase())) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}
```
Why this lives at insert time AND at drain step 1 (defense-in-depth):
- The 2,257-row older-Wayfair file would currently land `photo_url='NA'`
  on 1,558 rows. Without insert-time normalisation, those rows would be
  permanently mis-flagged "has photo" anywhere else in the app that reads
  `photo_url IS NOT NULL` (lot creation UI, public lot page, OG image
  tags, etc.). The fix at the importer covers ALL downstream readers.
- The drain-side check is the fallback for any historical rows already
  in the DB plus any future vendor placeholder we haven't anticipated.
- Co-locate `normalisePhotoUrl` in `packages/scan-extract/src/identifier-shapes.ts`?
  No — wrong package. Put it in
  `apps/operator-web/src/lib/imports/normalise-photo-url.ts` with unit
  tests covering: empty, whitespace, `NA`, `N/A`, `null`, `none`, `-`,
  uppercase / lowercase / mixed-case variants, valid `http://...` and
  `https://...`, and `ftp://...` (should reject).

Backfill SQL (one-off, run post-deploy):
```sql
UPDATE import_rows
   SET photo_url = NULL
 WHERE photo_url IS NOT NULL
   AND (TRIM(LOWER(photo_url)) = ANY(ARRAY['na','n/a','null','none','-',''])
        OR photo_url !~ '^https?://');
```
Operator-scoped; check row counts pre-commit. Expected on prod today:
~1,558 rows from the older Wayfair import.

### Files
- New: `packages/db/migrations/0162_image_enrichment_jobs.sql` (verify next-free at branch-cut; 0161 is the last claimed).
- New: `apps/operator-web/src/lib/cron/image-enrichment-drain.ts`.
- New: `apps/operator-web/src/app/api/cron/image-enrichment-drain/route.ts`.
- New: `packages/image-enrichment/src/detect-identifier.ts` + tests.
- New: `apps/operator-web/src/lib/imports/normalise-photo-url.ts` + tests
  (placeholder rejection — see Part B step 6).
- Edit: `apps/operator-web/src/app/(operator)/imports/actions.ts` — enqueue in commitImport + call `normalisePhotoUrl()` when mapping photo column.
- Edit: `apps/operator-web/src/app/(operator)/imports/new/ImportWizard.tsx` — HEADER_PATTERNS additions.
- Edit: `apps/cron-trigger/src/index.ts` — register new cron route.
- New (one-off): `scripts/backfill-normalise-photo-url.mjs` — flips existing `photo_url='NA'` (and friends) rows to NULL; operator-scoped + `--live` flag.

### What ships
- One PR, web-only, Cloudflare deploy. Migration via Management API. No mobile change.
- Backfill option (one-off SQL): after deploy, enqueue jobs for every existing
  `import_rows.id` that does not already have a corresponding
  `image_enrichment_jobs` row. Drain handles the "already has photo / no id"
  short-circuits per-row. Operator-scoped; recommend running per-operator
  rather than table-wide.

---

## Combined ship plan

| Order | Part | Effort | Ship surfaces | Status |
|---|---|---|---|---|
| 1 | **A — Universal scraper** | ~1 day | Cloudflare deploy + optional mobile OTA for copy update | PR open |
| 2 | **B — Enrichment wiring** | ~1-2 days | Cloudflare deploy + new migration (0162) + new cron route | PLAN |

A and B touch zero overlapping files — can ship **in parallel** as two PRs.

### Decisions for owner
1. **Part A — host allowlist:** current PR keeps ~15-host allowlist. Owner to confirm or expand to unrestricted (rely on SSRF guard alone) post-merge.
2. **Part B — enrichment storage:** write directly to `import_rows.photo_url` and `lots.photo_urls[0]`, or stage in a separate `enriched_photo_url` column for review first? Recommend direct write (operator can edit/replace at lotting time anyway).
3. **Part B — backfill scope:** enqueue jobs for the ~13,458 photo-less Amazon FBA rows from `21184921.xlsx` immediately after deploy, or wait for re-import? Recommend immediate one-off backfill.
4. **Browser rendering:** add Cloudflare Browser Rendering for Part A v2 only if specific retailers get blocked? Recommend yes (defer).

### Decisions resolved (no need to re-ask)
- **Universal enqueue (no gating):** owner confirmed 2026-05-30. Enqueue every
  row unconditionally; drain decides. No `if (has_identifier)`, no `if
  (vendor === 'amazon')`.
- **Primary target = Amazon-shape manifests.** Wayfair already ships photos
  and lacks probe-able IDs, so it naturally short-circuits at drain step 1
  (`already_has_photo`) with zero external API calls. No special-case code.
- **Title-search / image-search enrichment paths (was "Option C"):
  out of scope.** Don't build. The 4 existing modules (`amazon-asin-image`,
  `open-food-facts-image`, `open-library-image`, `music-brainz-image`) are
  sufficient for the use case. Revisit only if a real GTIN-less + photo-less
  manifest appears.

### Out of scope (acknowledged but not in this patch)
- `music-brainz-image.ts` enrichment — keep available but don't wire (niche; non-music returns won't have MBIDs).
- Vendor-specific photo CDN allowlisting beyond what's in `next.config.ts` (#133 already added the 4 enrichment hosts).
- Title-string or vendor-SKU based enrichment paths — see "Decisions resolved" above.
- Multi-image enrichment (we'll set the primary photo only; additional images can come from operator photo capture at lotting).
