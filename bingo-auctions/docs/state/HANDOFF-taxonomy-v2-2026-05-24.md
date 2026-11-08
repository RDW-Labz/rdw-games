# Handoff — Taxonomy v2 + BinGo manifest enrichment (2026-05-24)

**To:** the other coding session.
**From:** the session that did the taxonomy investigation + BinGo manifest enrichment.
**Status:** investigation + decisions locked; v2 enriched manifest written to `tmp/enrichment/`; no app code changed; no migrations added; no git commits made.

You have all APIs and headless access. This doc tells you what was decided, what's already on disk, and what to build next.

---

## 1. What this session actually did

| Output | Path | Type | Persisted? |
|---|---|---|---|
| v1 enrichment script (noisy) | `tmp/enrichment/enrich-bingo-manifest.js` | one-off node script | yes, untracked |
| v1 enriched CSV (noisy brands) | `tmp/enrichment/bingo-manifest-enriched-2026-05-24.csv` | 69 MB, 91,470 rows | yes, untracked |
| v1 summary | `tmp/enrichment/bingo-manifest-enriched-2026-05-24.summary.json` | metrics + samples | yes, untracked |
| **v2 enrichment script (clean)** | `tmp/enrichment/enrich-bingo-manifest-v2.js` | strict dictionary, no heuristic | yes, untracked |
| **v2 enriched CSV (production-quality)** | `tmp/enrichment/bingo-manifest-enriched-v2-2026-05-24.csv` | ~69 MB, 91,470 rows | yes, untracked |
| v2 summary | `tmp/enrichment/bingo-manifest-enriched-v2-2026-05-24.summary.json` | metrics + samples | yes, untracked |
| Memory (decisions, persists across sessions) | `~/.claude/projects/C--Users-jmacl/memory/project_auction_platform_taxonomy_v2.md` | markdown memory | yes |
| MEMORY.md index updated | `~/.claude/projects/C--Users-jmacl/memory/MEMORY.md` | pointer added | yes |
| **THIS handoff doc** | `docs/state/HANDOFF-taxonomy-v2-2026-05-24.md` | what you're reading | yes (under git) |

App code changed: **none.** Migrations added: **none.** PRs opened: **none.**

---

## 2. Source data inventory (verified)

### 2.1 Operator-facing scraped catalog at rest

`C:/Users/jmacl/Downloads/lots.db` — SQLite, 633 MB.

| Field | Type | Notes |
|---|---|---|
| `source` | TEXT | `macbid` (187,480 rows) or `nellis` (108,171 rows) |
| `source_id` | TEXT | competitor's lot id |
| `title`, `description`, `stock_image_url`, `images_json` | TEXT | populated 99%+ |
| `msrp` | REAL | populated 99.7% |
| `condition` | TEXT | `LIKE NEW`, `OPEN BOX`, `DAMAGED`, etc. |
| `brand`, `category` | TEXT | **mostly null** in scraped data — extraction not yet run |
| `raw_json` | TEXT | full scraper JSON; ASINs live in `raw_json.upc` (MAC.BID convention) or `raw_json.sku`/`raw_json.barcode` (Nellis) |
| `closes_at`, `first_seen_at`, `last_seen_at` | TEXT | ISO-8601 |

Single-day snapshot 2026-05-07. **Not yet imported to Postgres `competitor_lots` table** (`packages/db/migrations/0037_competitor_lots.sql` exists; loader is `scripts/import-competitor-lots.js` per `scripts/README-competitor-import.md`).

ASIN extractor logic in `tmp/enrichment/enrich-bingo-manifest-v2.js` Pass 1 — copy that approach when wiring the real importer; it found **103,462 unique ASINs** out of 295,651 rows.

### 2.2 BinGo Auctions manifest (operator #1)

`C:/Users/jmacl/Downloads/final bidfta_prod lotted_product 2026-05-23T2144.csv` — 250 MB, **501,898 rows** (header excluded).

Structure: one row PER IMAGE, denormalized. **91,470 unique Lot Codes** when collapsed. Average 5.49 image-rows per lot.

| Column index | Header (raw) | After collapse |
|---|---|---|
| 0 | Load Number | keep raw (Lex1, Lex2, RDWRG…, Wayfair, FTA, etc.) |
| 1 | Lot Code | primary key |
| 2 | Lotted End Datetime Date | **drop** (user request) |
| 3 | Title | 92.9% filled |
| 4 | Item Description | 92.9% filled |
| 5 | MSRP (USD) | 92.9% filled, decimal dollars |
| 6 | Category 1 | 92.9% filled — **Amazon-style taxonomy** |
| 7 | Category 2 | 92.9% filled |
| 8 | ASIN | **3.8% filled only** — `B0XXXXXXXX` |
| 9 | Identifier ID | drop (per user) |
| 10 | Identifier Value | drop |
| 11 | MPN (Part Number) | low fill |
| 12 | UPC | **0% filled** (138 rows total) |
| 13 | License Plate Number | keep |
| 14 | License Plate Created Date | drop |
| 15 | Master Location | keep (warehouse position, e.g., `RDB-Right-03-02`) |
| 16 | Auction Number | keep |
| 17 | Auction End Date | drop (per user — bid info not needed for putaway) |
| 18 | Pic URL | aggregate into JSON array per lot |

No `condition` column exists in this CSV — BinGo lots are hand-lotted by staff and conditions are tracked elsewhere. **Do NOT overwrite condition from scraped data** when this lands in `lots`.

### 2.3 Cat1 distribution (post-collapse, 91,470 lots)

```
Home & Kitchen              41,184    (45%)
Tools & Home Improvement     7,518     (8%)
Patio, Lawn & Garden         6,174     (7%)
Electronics                  3,916     (4%)
Automotive                   3,620     (4%)
Toys & Games                 3,458
Pet Supplies                 3,271
Clothing, Shoes & Jewelry    2,770
Arts, Crafts & Sewing        2,462
Beauty & Personal Care       2,421
Office Products              2,241
Sports & Outdoors            2,221
Baby Products                2,099
Appliances                   2,030
Health & Household           1,984
Cell Phones & Accessories    1,821
Industrial & Scientific      1,114
Musical Instruments            527
Grocery & Gourmet Food         470
Books                          153
```

Pure Amazon browse-node taxonomy. Validates D1 (adopt Amazon canonical tree).

---

## 3. Decisions locked (Michael, 2026-05-24)

| ID | Decision |
|---|---|
| **D1** | Adopt Amazon-style canonical tree (~20 top × ~120 leaf). Replaces current 16+50-leaf tree in migration 0018. |
| **D2** | 2 levels deep. |
| **D3** | Source/retailer/vendor is **NOT** a bidder-facing facet. Bidders see a "general shopping app." Stays internal. |
| **D4** | Collapse internal trees. DB `categories` = single source of truth. AI enum in `packages/domain-lotting/src/ai/constants.ts` is **generated** from the DB tree at build time. Delete `INVENTED_CATEGORY_REMAP`. |
| **D5** | Stay platform-curated taxonomy. No operator override. |
| **NEW** | Vendor model is finer than `source_retailer`. Operator-scoped `vendors` table. **Lex1 ≠ Lex2** in BinGo's load numbers — same Lexington warehouse code, different vendors (contracts shifted). |
| **NEW** | "BidFTA import" → "**Legacy import**". Profile lives at `packages/domain-lotting/src/import-profiles/legacy.ts`. |
| **NEW** | Scraped catalog purpose: **operator barcode-scan lookup only**, NOT bidder-facing. Goal: scan UPC/ASIN at putaway → return title, description, brand, model #, MSRP, images. |
| **NEW** | Field-mobile barcode scanner is **already live** (per Michael); no new build work needed there — just wire it to the new operator `product_catalog` table when that lands. |

Full memory at `~/.claude/projects/C--Users-jmacl/memory/project_auction_platform_taxonomy_v2.md`.

---

## 4. The plan (v2)

### W1 — Taxonomy v2 + Vendor model

| Change | Detail |
|---|---|
| Migration: replace categories tree | New migration (next number after `0018_categories.sql`). 20 top + ~120 leaf. Mirror Amazon's browse nodes (Home & Kitchen, Tools & Home Improvement, Patio Lawn & Garden, Electronics, Automotive, Toys & Games, Pet Supplies, Clothing Shoes & Jewelry, Arts Crafts & Sewing, Beauty & Personal Care, Office Products, Sports & Outdoors, Baby Products, Appliances, Health & Household, Cell Phones & Accessories, Industrial & Scientific, Musical Instruments, Grocery & Gourmet Food, Books). |
| `vendors` table | New migration. Schema: `id, operator_id, name, vendor_type (Liquidator / Returns / Direct / Auction-House / Other), contact, active_from, active_to, notes, created_at`. Operator-scoped via `operator_id` FK. |
| `lots.vendor_id` FK | Add column. Nullable while backfill runs. |
| `lots.supply_format` enum | Add: `single_item / pallet / truckload / building_materials / other`. |
| Backfill | Map old `category_id` → new via mapping table. Keep raw `lots.category` for forensics. |
| Regenerate AI enum from canonical tree | Build script reads `categories` table at build time, emits `Category` / `Subcategory` TS enums. Delete `INVENTED_CATEGORY_REMAP` from `packages/domain-lotting/src/normalize/identification.ts`. |
| Migrate `category_aliases` | Rewrite alias FKs to new category IDs. Keep all ~50 existing keyword rules + add manifest-source aliases. |

### W2 — Legacy import profile (replaces "BidFTA import")

| Change | Detail |
|---|---|
| Profile system | New file: `packages/domain-lotting/src/import-profiles/legacy.ts`. Plus stubs for `amazon-returns.ts`, `lowes.ts`, `walmart.ts`, `wayfair.ts` (build later). |
| Header signature → profile auto-detection | A header containing all of `Lot Code`, `MSRP (USD)`, `License Plate`, `Master Location`, `Pic URL` is unambiguously the legacy BidFTA-format export → use `legacy.ts`. |
| Legacy profile contract | Input: 19-col CSV (column indices in §2.2). Behavior: collapse rows-per-image → one row per Lot Code, aggregate images into `image_urls` JSONB, drop the 5 datetime/identifier columns, map Load Number → `vendor_id` (lookup against operator's `vendors` table; on miss, create unmapped vendor record and flag for operator review). |
| Keep condition | Hand-lotted by BinGo staff. If `condition` is supplied via operator UI overlay, use it; do not overwrite. Field doesn't exist in this CSV. |
| Honest error reporting | API returns `{ imported: N, skipped: M, rejections: [{rowNum, reason, ...}] }`. UI downloads rejection CSV. Closes the "58 imported, 2 skipped (no reason)" debt in `docs/auction-lot-audit-plan.md:42-46`. |
| Resolve parallel routes | `/lots/import` and `/lotting/manifest-pool` exist. Pick one, deprecate the other, or route both to the same backend pipeline. |

### W3 — Operator catalog (barcode-scan lookup) — NOT bidder-facing

| Change | Detail |
|---|---|
| `product_catalog` table | New migration. Schema: `id, asin, upc, mpn, title, description, brand, model_number, msrp_cents, images_json, category_id, source (macbid / nellis / amazon / etc.), source_lot_id, last_seen_at, created_at`. Indexed on `(asin)`, `(upc)`, `(mpn)`. Operator-readable, not bidder-readable. |
| Backfill from `lots.db` | Adapt `scripts/import-competitor-lots.js` to populate `product_catalog`. ASIN extraction logic in `tmp/enrichment/enrich-bingo-manifest-v2.js` Pass 1 is the reference implementation. Expected: ~103k catalog entries from current single-day snapshot. |
| Continuous scrape → catalog | `apps/cron-trigger` runs scheduled scrape (it already exists; verify schedule + extend coverage). |
| Brand backfill | Wire `extractBrand` + `normalizeBrandFromInput` from `packages/domain-lotting/src/normalize/brand.ts` into both the manifest import path AND the scraper insert path. Run `scripts/run-brand-backfill.js` over both `competitor_lots`/`product_catalog` and `lots` post-W1. |
| Lookup endpoint | `GET /api/catalog/lookup?asin=…&upc=…&mpn=…` → returns enriched product card. Used by field-mobile barcode scanner. Cache-friendly. |
| **Category-aware brand pass** | Defer this from W3 to W3.1: refine `extractBrand` so e.g. `Ring` only matches as brand when category in `Electronics`/`Smart Home`; `Apple` only matches in `Electronics`; `Echo`/`Champion`/`Shark`/`Pilot`/`Delta`/`Honda` all need similar guards. Real `brand.ts` has the same limitation today. Critical before 5MM-row scale. |

### W4 — Bidder browse v2 (no source chip)

| Change | Detail |
|---|---|
| Category chips | 20 top-level instead of 16; reorder by lot count. |
| Filters | Condition, Price range, Ending Soon, Operator (existing), image-quality indicator (3+ images). |
| **NO** source / vendor / retailer chip | Per D3. |
| Search | Typo tolerance + brand autocomplete (autocomplete source: `brands` derived view). |
| Lot card | Title, brand, condition badge, MSRP comparison, time-left, image-quality indicator. |
| Bidder app | `useCategories()` hook (`packages/domain-bidding/src/hooks/useCategories.ts`) already works generically — should pick up new tree without code change beyond image asset refresh. |

### W5 — Operator UX (3 items; dropped 1)

| Item | Detail |
|---|---|
| Lotting screen: category breakdown of current load | Pre-post, catches manifest mis-classification. |
| Smart import preview | First 50 rows post-normalization with brand / category / enrichment status. Operator overrides before commit. |
| Per-operator analytics | Which categories sell, which sit. |
| ~~Category-aware lot title suggestions~~ | **DROPPED** per user ("not the LotTR category thing"). |

### Sequencing

```
W1 (taxonomy + vendors)
  ├─► W2 (legacy import) ──► BinGo go-live (critical path)
  └─► W3 (catalog + scan API + brand backfill)
                          └─► W5 (operator UX)
                          └─► W4 (bidder browse v2)
```

---

## 5. BinGo go-live critical path

**1–2 week path. Steps in order:**

1. **DONE** — enriched manifest preview at `tmp/enrichment/bingo-manifest-enriched-v2-2026-05-24.csv`. Operator reviews + spot-checks.
2. **W1 partial** — add `vendors` table + `lots.vendor_id` + `lots.supply_format` columns. Defer the full Amazon-tree migration if time-critical; existing tree + `category_aliases` handles the manifest's Cat1 values with ~95% match.
3. **W2** — ship `legacy.ts` import profile + the row-collapse/image-aggregation pipeline. This is the only blocker for ingesting the 91k-lot CSV.
4. **Brand backfill** — run `scripts/run-brand-backfill.js` (via `enrich_brands_batch` RPC in migration 0040) over just BinGo's imported lots first.
5. **Live for BinGo.** W3 / W4 / W5 follow post-launch.

---

## 6. Enrichment results (v2 — clean) — what's already in the CSV

| Metric | Count | % of 91,470 lots |
|---|---|---|
| Lot collapsed from 501,898 row-per-image inputs | 91,470 | 100% |
| Brand extracted (strict dictionary, word-boundary) | 6,039 | 6.6% |
| Model detected (label-adjacent only) | 2,743 | 3.0% |
| ASIN matched to scraped catalog | 245 | 0.27% |
| Extra images added from scraped catalog | 245 | — |
| Title fill | 84,920 | 92.9% |
| Category 1 + 2 fill | 84,920 | 92.9% |
| ASIN fill (in source manifest) | 3,503 | 3.8% |
| UPC fill (in source manifest) | 126 | 0.1% |

**Top 20 extracted brands** (all real, no noise):
```
Ring 539  Samsung 527  Apple 446  Generation Lighting 246  Amazon 227
Honda 159  Kobalt 130  Moen 114  HP 113  Philips 105
PlayStation 97  Xbox 92  Nintendo 87  Shark 86  Craftsman 84
Ninja 83  Wrangler 82  DeWalt 72  3M 68  GE 66
```

Caveat: `Ring`, `Apple`, `Shark`, `Echo`, `Champion`, `Pilot`, `Delta`, `Honda` will occasionally match the common-noun usage of those words. Needs category-aware guard (W3.1) before catalog scales to 5MM rows. Same limitation exists in production `brand.ts` today.

**ASIN-enrichment samples** (proof the join works):
```
Lot PNK4430237 ASIN=B0D739PX62
  manifest title:  "Pressure Washer, Power Washer with 4 Quick Connect..."
  scraped title:   "LWQ Pressure Washer 3000 PSI" (macbid)

Lot PNK4430804 ASIN=B0BG3DQLDD
  manifest title:  "Thrustmaster TCA Captain Pack Xbox – Airbus Edition..."
  scraped title:   "Thrustmaster TCA Captain X Pack Airbus Flight Sim Controller" (macbid)

Lot TEA3725953 ASIN=B08CGJJJWK
  manifest title:  "Squishmallows Official Kellytoy Plush 16 Maui The Pineapple..."
  scraped title:   "Squishmallows Pineapple Plush Toy" (macbid)
```

**Output schema** of `bingo-manifest-enriched-v2-2026-05-24.csv`:
```
Lot Code, Load Number, Title, Brand (dict), Model (label),
Category 1, Category 2, MSRP, Description, Description (enriched),
MSRP Reference (scraped), ASIN, MPN, UPC, License Plate,
Master Location, Auction Number, Pic URL Count, Pic URLs JSON,
Enriched Images JSON, Enrichment Source
```

---

## 7. Files you should leave alone

These are session artifacts. Don't delete; don't move into `scripts/`; treat as scratchpad:

```
tmp/enrichment/enrich-bingo-manifest.js                          (v1 - obsolete, kept for diff)
tmp/enrichment/enrich-bingo-manifest-v2.js                       (v2 - reference impl)
tmp/enrichment/bingo-manifest-enriched-2026-05-24.csv            (v1 - obsolete)
tmp/enrichment/bingo-manifest-enriched-v2-2026-05-24.csv         ← use this
tmp/enrichment/bingo-manifest-enriched-2026-05-24.summary.json
tmp/enrichment/bingo-manifest-enriched-v2-2026-05-24.summary.json
```

If you ship the legacy import profile, you can either delete these post-launch or move the v2 script to `scripts/dev-tools/enrich-manifest-preview.js` as a reusable preview tool for future operators.

---

## 8. Reference: where existing pieces live in the repo

| What | Where | Notes |
|---|---|---|
| Current 16+50 category tree (to be replaced) | `packages/db/migrations/0018_categories.sql` | also has `category_aliases` table + ~50 seed keyword rules |
| Real brand dictionary (~200 entries × ~350 aliases) | `packages/domain-lotting/src/normalize/brand.ts` | this is what v2 enrichment ported |
| SQL-side brand functions | `packages/db/migrations/0038`, `0040_extract_brand.sql`, `0044` | DB mirror of brand.ts |
| Brand backfill RPC | `enrich_brands_batch(table, batch_size)` (migration 0040) | invoked by `scripts/run-brand-backfill.js` |
| AI category enum (22 top × 110 leaf — to be auto-generated) | `packages/domain-lotting/src/ai/constants.ts:27-256` | currently bridged to DB tree via `INVENTED_CATEGORY_REMAP` (kill after W1) |
| Existing `competitor_lots` Postgres table | `packages/db/migrations/0037_competitor_lots.sql` | adapt or extend for `product_catalog` (W3) |
| Scraped data loader (Postgres importer) | `scripts/import-competitor-lots.js` + `scripts/README-competitor-import.md` | reference for W3 backfill |
| Lots.db profiler (already exists) | `scripts/profile-lots.js` | sanity-check tool |
| Current import API | `apps/operator-web/src/app/api/lots/import/route.ts` → `bulk_import_lots` RPC | extend with profile system in W2 |
| Bidder categories hook | `packages/domain-bidding/src/hooks/useCategories.ts` | should pick up new tree without code change |
| CategoryGrid component | `apps/bidder-app/app/(tabs)/_components/CategoryGrid.tsx:35-60` | bidder browse — will need image refresh after W1 |
| Field-mobile barcode scanner | already live per Michael | wire to `/api/catalog/lookup` once W3 lands |
| Design debt: parallel import routes | `docs/auction-lot-audit-plan.md:42-46` | resolve in W2 |

---

## 9. One open scoping question (no answer yet — flag with Michael when ready)

Should the operator-facing **product catalog table** (`product_catalog` in W3) start as a continuously-updated scraped catalog (ongoing cron pulls from MAC.BID + Nellis + future sources), or should it start as a one-shot backfill from the current 633 MB `lots.db` snapshot with refresh later?

Implementation difference: the cron-trigger app already exists; the one-shot is faster to ship.

---

## 10. Memory pointer

If you want the full decision rationale, read:
- `~/.claude/projects/C--Users-jmacl/memory/project_auction_platform_taxonomy_v2.md` — the canonical decisions, including the Lex1 ≠ Lex2 vendor distinction and the scraped-catalog-purpose redefinition.
- `~/.claude/projects/C--Users-jmacl/memory/project_auction_platform.md` — repo facts (3 days old).
- `~/.claude/projects/C--Users-jmacl/memory/user_michael.md` — Michael's operating style.

Auto-loaded by Claude Code at session start via `MEMORY.md` index.
