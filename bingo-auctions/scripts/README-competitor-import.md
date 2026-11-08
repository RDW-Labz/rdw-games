# Competitor Lots Import

Streams competitor auction data from a SQLite scrape file into `competitor_lots`
on Supabase Postgres. Built for the initial MAC.BID load (~295k rows) and
designed to scale to 1M+ rows for future BidFTA, Nellis, and ShopGoodwill pulls.

---

## Prerequisites

```
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...         # service-role key (bypasses RLS)
SUPABASE_ACCESS_TOKEN=sbp_...            # Personal Access Token (--apply-indexes only)
SUPABASE_PROJECT_REF=<ref>               # --apply-indexes only
```

Set these in `.env.migrations.local` (gitignored) at the repo root.

---

## Workflow

### 1. Apply schema migrations

Migrations must be applied in order. 0039 depends on the `competitor_lots` table
created by 0037.

```
node scripts/apply-migrations.js
```

Expected:
```
  • 0037_competitor_lots.sql
  • 0038_normalize_helpers.sql
  • 0039_competitor_lots_batch_upsert.sql
```

### 2. Dry-run — review the report before touching Postgres

```
node scripts/import-competitor-lots.js
```

Flags default to:
- `--db=C:/Users/jmacl/Downloads/lots.db`
- `--source-filter=macbid`
- `--batch=5000`

Output: `scripts/.import-reports/competitor-lots-<timestamp>.md`

Review the report for:
- Field fill rates (brand is 0% for MAC.BID — expected, no top-level field)
- Image URL hosts that are NOT on the allowlist (`media.mac.bid`, `s3.amazonaws.com`)
- Cents-conversion sanity check (MSRP avg ~$98.60, range $2.97–$5995)
- Distinct `condition` values: `DAMAGED`, `LIKE NEW`, `OPEN BOX`, `Used`, `New`, `Not Specified`
- Estimated batch count (~38 batches of 5000 for 187k macbid rows)

### 3. Commit mode — write to Postgres

```
node scripts/import-competitor-lots.js --commit
```

Progress output:
```
[ 37/38] 185,000 / 187,480 rows...
```

Final output:
```
  Inserted: 187,480
  Updated:  0
  Elapsed:  142.3s
  Throughput: 1317 rows/sec
```

Re-running is idempotent:
```
  Inserted: 0
  Updated:  187,480    ← bid amounts / last_seen_at touched; stable fields unchanged
  Elapsed:  ...
```

### 4. Apply post-load indexes

Run **after** the bulk load completes. Creating indexes on a populated table is
significantly faster than maintaining them during bulk insert.

```
$env:SUPABASE_PROJECT_REF = "npwseclcxcatjhgjrtwe"   # required — no default, see below
node scripts/import-competitor-lots.js --apply-indexes
```

This step runs DDL through the Supabase Management API, which addresses the
project by ref. There is deliberately no default ref: this repo was forked from
ClovrBid, and a guessed ref alters another company's production database. The
script exits 1 with remediation text if `SUPABASE_PROJECT_REF` is unset.

Indexes applied (all `CREATE INDEX IF NOT EXISTS` — idempotent):

| Index | Purpose |
|-------|---------|
| `competitor_lots_source_seen_idx` | Incremental scrape refresh (`source, last_seen_at DESC`) |
| `competitor_lots_title_trgm_idx` | Fuzzy title search via `pg_trgm` GIN; partial (active + sold lots only) |
| `competitor_lots_brand_idx` | Brand analytics; partial (excludes NULL brands) |
| `competitor_lots_sold_comps_idx` | Price comp queries by `closes_at`; partial (closed + final_bid present) |
| `competitor_lots_category_idx` | Category joins; partial (excludes NULL category_id) |
| `competitor_lots_upc_idx` | UPC → `product_lookups` enrichment joins; partial (excludes NULL) |

### 5. Verify with a sample query

```sql
-- Row counts by source
SELECT source, COUNT(*) FROM competitor_lots GROUP BY source;

-- MAC.BID MSRP distribution
SELECT
  percentile_cont(0.5) WITHIN GROUP (ORDER BY msrp_cents) AS median_msrp_cents,
  MIN(msrp_cents), MAX(msrp_cents), AVG(msrp_cents)
FROM competitor_lots
WHERE source = 'macbid' AND msrp_cents IS NOT NULL;

-- Category breakdown
SELECT category_raw, COUNT(*) AS cnt
FROM competitor_lots
WHERE source = 'macbid'
GROUP BY category_raw
ORDER BY cnt DESC
LIMIT 20;

-- Confirm idempotency: re-run and check updated_at spread
SELECT MIN(updated_at), MAX(updated_at), COUNT(*)
FROM competitor_lots
WHERE source = 'macbid';
```

---

## Optional flags

| Flag | Default | Description |
|------|---------|-------------|
| `--db=<path>` | `C:/Users/jmacl/Downloads/lots.db` | SQLite source file |
| `--source-filter=<name>` | `macbid` | Only import rows from this source |
| `--batch=<N>` | `5000` | Rows per Supabase RPC call (competitor_lots) |
| `--lookups-batch=<N>` | `500` | Rows per product_lookups upsert batch |
| `--limit=<N>` | (none) | Stop after N rows (smoke testing) |
| `--commit` | false | Write to Postgres; default is dry-run |
| `--no-populate-lookups` | false | Skip product_lookups population (see below) |
| `--resolve-categories` | false | After import, call `resolve_category_ids_batch` RPC |
| `--reapply-only` | false | Force UPDATE on all rows (re-processes already-imported data) |
| `--apply-indexes` | false | Run post-load `CREATE INDEX` statements and exit |

### Smoke test (first 100 rows, dry-run)

```
node scripts/import-competitor-lots.js --limit=100
```

### Import a different source (e.g. Nellis)

```
node scripts/import-competitor-lots.js --source-filter=nellis --commit
```

---

## Upsert RPC (`upsert_competitor_lots_batch`)

Migration `0039_competitor_lots_batch_upsert.sql` adds a Postgres function that
accepts a JSONB array of row objects and returns `{ inserted: N, updated: M }`.

- Conflict target: `(source, source_id)`
- On conflict, updates: `current_bid_cents`, `final_bid_cents`, `bid_count`,
  `discount_pct`, `last_seen_at`, `raw_json`, `updated_at`
- Stable fields never overwritten: `title`, `msrp_cents`, `first_seen_at`,
  `url`, `image_urls`, `brand`, `condition`
- Insert vs update detection: `xmax = 0` trick (well-known Postgres idiom)
- Permissions: `REVOKE from PUBLIC`, `GRANT to service_role`

If `0039` has not been applied, the importer falls back to a direct
`supabase.from('competitor_lots').upsert(...)` call automatically.

---

## Known limitations

### Image URLs

MAC.BID serves product images from `media.mac.bid` and `s3.amazonaws.com`.
**Neither host is currently on the platform's `ALLOWED_IMAGE_HOSTS` allowlist.**
All MAC.BID `image_urls` will be stored as `{}` until these hosts are approved.

To add them, update both:
1. `packages/domain-lotting/src/lookup/merge.ts` → `ALLOWED_IMAGE_HOSTS` Set
2. `packages/db/migrations/0038_normalize_helpers.sql` → `is_safe_image_url()` CASE list

### UPC extraction

MAC.BID's SQLite schema does not have a top-level `upc` column. UPCs are
embedded in `raw_json.upc`. The importer extracts them via `normalizeUpc(raw_json.upc)`.
For the initial scrape, all rows appear to have this field populated.

### `brand` column is empty for MAC.BID

MAC.BID's API does not return a brand field — the `brand` column in SQLite is
always NULL. Brand inference from title (first capitalized word) is available
in `packages/domain-lotting/src/text/` but is intentionally **not applied here**
to keep raw data fidelity. A separate enrichment pass can populate this.

---

## product_lookups population (--populate-lookups)

When `--commit` is set, the importer **also** upserts into `product_lookups` for
every lot that has an extractable identifier. This is **ON by default** — pass
`--no-populate-lookups` to suppress it.

### Identifier extraction logic

For each MAC.BID lot, the importer reads `raw_json.upc`. This field contains:

- A real UPC (8/12/13/14 digit string) in ~15% of rows.
- An ASIN (10 uppercase alphanumeric, e.g. `B0DK7R7KWV`) in ~85% of rows.
  MAC.BID's scraper stores ASINs in the `upc` field. The importer detects
  this and routes them to the `asin` column instead.

### Primary key assignment

`product_lookups.upc` is the primary key. Assignment priority:

| Situation | PK value used |
|-----------|--------------|
| Real UPC present | The normalized UPC digits |
| ASIN only | `asin:<ASIN>` e.g. `asin:B0DK7R7KWV` |
| FNSKU only | `fnsku:<FNSKU>` |
| LPN only | `lpn:<LPN>` |
| No identifier | Row skipped |

The `asin:`/`fnsku:` prefix encoding is explicitly a short-term approach. The
lookup RPC (`lookup_product_by_code`) resolves queries against the `asin`,
`fnsku`, `lpn` columns directly — it does **not** query by the synthetic PK
prefix. So `lookupByCode('B0DK7R7KWV')` works correctly regardless of whether
the PK is `asin:B0DK7R7KWV` or a real UPC that also has `asin=B0DK7R7KWV`.

**v2 note:** The correct long-term schema is a UUID PK on `product_catalog`
with a `product_identifiers` join table (type, code, UNIQUE(type, code)).
This avoids the synthetic-key hack entirely. Tracked as "product_catalog_v2".

### Conflict resolution

On conflict (same UPC/synthetic key), the importer uses a COALESCE merge:
non-null existing values are never overwritten by null incoming values. This
means a row enriched by eBay Sonar (with prices, images, brand) won't be
downgraded by a competitor import that only has a title and MSRP.

### Expected output (MAC.BID 295k row import)

```
product_lookups upserted: ~295,000
Identifier breakdown:
  Real UPC:   ~44,000  (15%)
  ASIN only:  ~248,000  (84%)
  FNSKU only: 0
  LPN only:   0
  No ID:      ~3,000
```

---

## Adding new sources (BidFTA, Nellis, ShopGoodwill)

1. Scrape the new source into the same SQLite schema (`lots` table with the same columns).
2. Run with `--source-filter=<new_source>` to import only that source's rows.
3. The normalizer is source-agnostic; no code changes needed unless the source
   has a different `raw_json` schema for UPC extraction.
4. Nellis rows are already present in `lots.db` (108k rows). Import with:
   ```
   node scripts/import-competitor-lots.js --source-filter=nellis --commit
   ```
