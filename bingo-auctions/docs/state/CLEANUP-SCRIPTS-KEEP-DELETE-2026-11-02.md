# Scripts keep/delete audit — 2026-11-02

Base: `80117020b7a69a9edaead44755770b9d3963d282` (fresh origin/master after other authorized work merged). Inventory: **397 tracked files in 122 root entries**; owner estimate was 120 entries. Delete **52 files / 7,103 lines**. Keep **345 files**. Git history preserves deleted content.

No production script was executed. No install, dependency version, package/lockfile, workflow, app source, migration, native identity or E2E file changed. The only retained script-file edit is the owner-approved manifest-key test expectation, in a separate commit; its implementation is unchanged. This scripts/docs-only PR does not deploy.

## Search and caller proof

Before deleting, scanned all 2465 tracked UTF-8 text files at the base, including .github/, scripts/, apps/, packages/, every package.json, all remaining docs and root files. For every deleted target searched exact repo path, basename, and extensionless stem; the complete location-only results follow. Binary contents are excluded. Self-references in a deleted file are excluded. Newly added audit references are deliberately not included in the baseline search.

Equivalent repeatable grep for each target (also search its extensionless stem):

```zsh
git grep -n -F -e scripts/<name> -e <basename> -e <stem> 80117020b7a69a9edaead44755770b9d3963d282 -- .github scripts apps packages docs ':(glob)**/package.json' README.md CLAUDE.md WORKING_AGREEMENT.md RUNBOOK.md
```

Workflow/package/script references to deleted executable targets: **zero surviving readers/callers**. The four cross-references between removed tools are comments/docstrings, not calls. Reviewed workflow directory/glob inputs: protected CI/smoke/store-release/lottr-smoke/test-backend/mega-sim/stress-sim trees stay intact. The CI **/package-lock.json cache inputs stay intact, including the demo kit manifests. Current legal generation, migration runners, post-deploy checks, imports, reporting and store-release entry points remain.

Historical docs/state and the step 3 brand inventory retain old paths as historical evidence. Remaining code/migration comments are listed below; no frozen E2E/migration byte is edited. No deleted tool is needed to access existing CDN assets; assets, Worker routes and settings remain unchanged.

## Delete list and every baseline reference

### `scripts/backfill-catalog-images.js`

Obsolete one-off catalog/photo/category/brand queue backfill; not a current import or runtime entry point.

Lines removed: 385.
References: none outside the file.

### `scripts/backfill-image-enrichment-jobs.mjs`

Obsolete one-off catalog/photo/category/brand queue backfill; not a current import or runtime entry point.

Lines removed: 243.
- `docs/state/FEEDBACK-TRIAGE-2026-06-08.md:32` — path, basename, stem; retained documentation/history; no file read.
- `docs/state/QUICKLOT-EXECUTION-PLAN-2026-06-08.md:19` — path, basename, stem; retained documentation/history; no file read.

### `scripts/backfill-images-from-scrape.js`

Obsolete one-off catalog/photo/category/brand queue backfill; not a current import or runtime entry point.

Lines removed: 299.
References: none outside the file.

### `scripts/backfill-lot-categories.mjs`

Obsolete one-off catalog/photo/category/brand queue backfill; not a current import or runtime entry point.

Lines removed: 335.
- `docs/state/LIVE-TEST-FEEDBACK-STATUS-2026-06-04.md:24` — basename, stem; retained documentation/history; no file read.
- `docs/state/LIVE-TEST-FEEDBACK-STATUS-2026-06-04.md:61` — path, basename, stem; retained documentation/history; no file read.
- `packages/db/migrations/0178_fix_bulk_import_lots_category.sql:33` — path, basename, stem; immutable migration comment; no file read.
- `packages/db/migrations/0178_fix_bulk_import_lots_category.sql:301` — path, basename, stem; immutable SQL COMMENT metadata; no file read.
- `packages/db/migrations/0184_amazon_toplevel_category_aliases.sql:18` — path, basename, stem; immutable migration comment; no file read.

### `scripts/backfill-normalise-photo-url.mjs`

Obsolete one-off catalog/photo/category/brand queue backfill; not a current import or runtime entry point.

Lines removed: 153.
- `docs/state/PATCH-universal-web-scraper-and-enrichment-2026-05-30.md:242` — path, basename, stem; retained documentation/history; no file read.
- `scripts/backfill-lot-categories.mjs:44` — basename, stem; removed sibling comment/docstring.

### `scripts/bingo-clone-probe.mjs`

One-off clone/bootstrap or investigative probe; no production workflow/package/script caller.

Lines removed: 19.
References: none outside the file.

### `scripts/bingo-db.mjs`

One-off clone/bootstrap or investigative probe; no production workflow/package/script caller.

Lines removed: 11.
References: none outside the file.

### `scripts/bingo-investigate.mjs`

One-off clone/bootstrap or investigative probe; no production workflow/package/script caller.

Lines removed: 16.
References: none outside the file.

### `scripts/bulk-import-manifests.js`

Fixed historical import/correction operation; current import workflows and incident evidence remain.

Lines removed: 571.
References: none outside the file.

### `scripts/check-import-rows.js`

One-off clone/bootstrap or investigative probe; no production workflow/package/script caller.

Lines removed: 58.
References: none outside the file.

### `scripts/clone-bingo-auctions.mjs`

One-off clone/bootstrap or investigative probe; no production workflow/package/script caller.

Lines removed: 16.
References: none outside the file.

### `scripts/clone-bingo-core.mjs`

One-off clone/bootstrap or investigative probe; no production workflow/package/script caller.

Lines removed: 19.
References: none outside the file.

### `scripts/clone-bingo-lots.mjs`

One-off clone/bootstrap or investigative probe; no production workflow/package/script caller.

Lines removed: 20.
References: none outside the file.

### `scripts/cloudflare-cutover.sh`

Superseded launch asset/cutover tool; current Workers, routes, existing CDN assets and operational deploy workflow remain unchanged.

Lines removed: 190.
- `docs/AUCTION_ENGINE_DEPLOY.md:98` — path, basename, stem; retained documentation/history; no file read.
- `docs/CLOUDFLARE_CUTOVER.md:15` — path, basename, stem; retained documentation/history; no file read.
- `docs/CLOUDFLARE_OWNERSHIP_MIGRATION.md:214` — path, basename, stem; retained documentation/history; no file read.
- `docs/CLOUDFLARE_OWNERSHIP_MIGRATION.md:217` — path, basename, stem; retained documentation/history; no file read.
- `docs/CLOUDFLARE_STATE.md:120` — path, basename, stem; retained documentation/history; no file read.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:576` — path, basename, stem; retained documentation/history; no file read.

### `scripts/cloudflare-r2-cdn-bootstrap.sh`

Superseded launch asset/cutover tool; current Workers, routes, existing CDN assets and operational deploy workflow remain unchanged.

Lines removed: 209.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:580` — path, basename, stem; retained documentation/history; no file read.

### `scripts/correct-restored-lot-titles.mjs`

Fixed historical import/correction operation; current import workflows and incident evidence remain.

Lines removed: 87.
- `packages/db/migrations/0439_lock_backup_tables.sql:16` — path, basename, stem; immutable migration comment; no file read.

### `scripts/create-bingo-admin.mjs`

One-off clone/bootstrap or investigative probe; no production workflow/package/script caller.

Lines removed: 22.
References: none outside the file.

### `scripts/crop-v3-og.py`

Superseded launch asset/cutover tool; current Workers, routes, existing CDN assets and operational deploy workflow remain unchanged.

Lines removed: 58.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:593` — path, basename, stem; retained documentation/history; no file read.

### `scripts/debug-rpc.js`

One-off clone/bootstrap or investigative probe; no production workflow/package/script caller.

Lines removed: 37.
References: none outside the file.

### `scripts/demo-tools/capture-thumbnail.mjs`

Standalone demo recording/probe/seeding kit; not the protected existing E2E suites. Dependency manifests remain under the lockfile/CI-cache guard.

Lines removed: 1.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:597` — path, basename, stem; retained documentation/history; no file read.

### `scripts/demo-tools/debug-browse.mjs`

Standalone demo recording/probe/seeding kit; not the protected existing E2E suites. Dependency manifests remain under the lockfile/CI-cache guard.

Lines removed: 1.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:601` — path, basename, stem; retained documentation/history; no file read.

### `scripts/demo-tools/discover.mjs`

Standalone demo recording/probe/seeding kit; not the protected existing E2E suites. Dependency manifests remain under the lockfile/CI-cache guard.

Lines removed: 1.
- `.github/workflows/prod-cost-report.yml:25` — stem; generic stem-word collision; not a script reference.
- `apps/bidder-app/app/(tabs)/index.tsx:39` — stem; generic stem-word collision; not a script reference.
- `apps/bidder-app/app/(tabs)/index.tsx:1058` — stem; generic stem-word collision; not a script reference.
- `apps/bidder-app/app/(tabs)/my-bids.tsx:149` — stem; generic stem-word collision; not a script reference.
- `apps/bidder-app/app/invoice/[id].tsx:526` — stem; generic stem-word collision; not a script reference.
- `apps/bidder-app/app/lot/[id].tsx:80` — stem; generic stem-word collision; not a script reference.
- `apps/bidder-app/app/lot/[id].tsx:415` — stem; generic stem-word collision; not a script reference.
- `apps/bidder-app/app/lot/[id].tsx:418` — stem; generic stem-word collision; not a script reference.
- `apps/bidder-app/app/lot/[id].tsx:423` — stem; generic stem-word collision; not a script reference.
- `apps/bidder-app/app/pickup/[id].tsx:571` — stem; generic stem-word collision; not a script reference.
- `apps/bidder-app/app/profile/feedback.tsx:187` — stem; generic stem-word collision; not a script reference.
- `apps/bidder-app/lib/analytics.ts:93` — stem; generic stem-word collision; not a script reference.
- `apps/bidder-app/lib/discoverable-auctions.test.ts:1` — stem; generic stem-word collision; not a script reference.
- `apps/bidder-app/lib/discoverable-auctions.test.ts:11` — stem; generic stem-word collision; not a script reference.
- `apps/bidder-app/lib/discoverable-auctions.ts:5` — stem; generic stem-word collision; not a script reference.
- `apps/bidder-app/lib/discoverable-auctions.ts:24` — stem; generic stem-word collision; not a script reference.
- `apps/cron-trigger/src/index.ts:41` — stem; generic stem-word collision; not a script reference.
- `apps/field-mobile/app.config.ts:144` — stem; generic stem-word collision; not a script reference.
- `apps/field-mobile/features/location/CrossWarehouseWarning.tsx:14` — stem; generic stem-word collision; not a script reference.
- `apps/field-mobile/plugins/clovrbid-arkit.js:16` — stem; generic stem-word collision; not a script reference.
- `apps/field-mobile/plugins/clovrbid-arkit.js:18` — stem; generic stem-word collision; not a script reference.
- `apps/operator-web/e2e/setup/global-setup.ts:124` — stem; generic stem-word collision; not a script reference.
- `apps/operator-web/src/app/(operator)/auctions/new/actions.ts:97` — stem; generic stem-word collision; not a script reference.
- `apps/operator-web/src/app/(operator)/imports/new/page.tsx:50` — stem; generic stem-word collision; not a script reference.
- `apps/operator-web/src/app/(operator)/marketing/actions.ts:256` — stem; generic stem-word collision; not a script reference.
- `apps/operator-web/src/app/(operator)/settings/bidder-experience/BidderFeaturesForm.tsx:22` — stem; generic stem-word collision; not a script reference.
- `apps/operator-web/src/app/(operator)/settings/bidder-experience/page.tsx:38` — stem; generic stem-word collision; not a script reference.
- `apps/operator-web/src/app/(public)/_components/MobileNavControls.tsx:4` — stem; generic stem-word collision; not a script reference.
- `apps/operator-web/src/app/(public)/browse/page.tsx:7` — stem; generic stem-word collision; not a script reference.
- `apps/operator-web/src/app/(public)/browse/page.tsx:208` — stem; generic stem-word collision; not a script reference.
- `apps/operator-web/src/app/how-it-works/page.tsx:7` — stem; generic stem-word collision; not a script reference.
- `apps/operator-web/src/app/legal/[slug]/_content.generated.ts:356` — stem; generic stem-word collision; not a script reference.
- `apps/operator-web/src/app/legal/[slug]/_content.generated.ts:1208` — stem; generic stem-word collision; not a script reference.
- `apps/operator-web/src/app/profile/page.tsx:46` — stem; generic stem-word collision; not a script reference.
- `apps/operator-web/src/app/profile/page.tsx:49` — stem; generic stem-word collision; not a script reference.
- `apps/operator-web/src/lib/social/compose.ts:70` — stem; generic stem-word collision; not a script reference.
- `docs/ARCHITECTURE.md:103` — stem; generic stem-word collision; not a script reference.
- `docs/AUCTION_ENGINE_DEPLOY.md:164` — stem; generic stem-word collision; not a script reference.
- `docs/SESSION_HANDOFF.md:66` — stem; generic stem-word collision; not a script reference.
- `docs/audits/2026-09-21-restored-lot-title-audit.md:28` — stem; generic stem-word collision; not a script reference.
- `docs/audits/2026-09-24-poisoned-tracking-lookups.json:464` — stem; generic stem-word collision; not a script reference.
- `docs/competitive-pricing-analysis.md:55` — stem; generic stem-word collision; not a script reference.
- `docs/competitive-pricing-analysis.md:277` — stem; generic stem-word collision; not a script reference.
- `docs/competitive-pricing-analysis.md:278` — stem; generic stem-word collision; not a script reference.
- `docs/plans/PATCH-live-test-feedback-2026-06-03.md:58` — stem; generic stem-word collision; not a script reference.
- `docs/plans/PLAN-physical-footprint-migration-safeguard-2026-09-21.md:78` — stem; generic stem-word collision; not a script reference.
- `docs/plans/PLAN-physical-footprint-migration-safeguard-2026-09-21.md:79` — stem; generic stem-word collision; not a script reference.
- `docs/plans/PLAN-resource-usage-alerting-2026-09-21.md:35` — stem; generic stem-word collision; not a script reference.
- `docs/security/ROLE-MATRIX-PLAN-2026-06-13.md:4` — stem; generic stem-word collision; not a script reference.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:605` — path, basename, stem; retained documentation/history; no file read.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:788` — stem; generic stem-word collision; not a script reference.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:790` — stem; generic stem-word collision; not a script reference.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:791` — stem; generic stem-word collision; not a script reference.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:792` — stem; generic stem-word collision; not a script reference.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:793` — stem; generic stem-word collision; not a script reference.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:794` — stem; generic stem-word collision; not a script reference.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:795` — stem; generic stem-word collision; not a script reference.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:796` — stem; generic stem-word collision; not a script reference.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:797` — stem; generic stem-word collision; not a script reference.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:798` — stem; generic stem-word collision; not a script reference.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:799` — stem; generic stem-word collision; not a script reference.
- `docs/state/CRITICAL-BATCH-PLAN-2026-06-02.md:5` — stem; generic stem-word collision; not a script reference.
- `docs/state/CRITICAL-BATCH-PLAN-2026-06-02.md:17` — stem; generic stem-word collision; not a script reference.
- `docs/state/CRITICAL-BATCH-PLAN-2026-06-02.md:28` — stem; generic stem-word collision; not a script reference.
- `docs/state/CRITICAL-BATCH-PLAN-2026-06-02.md:33` — stem; generic stem-word collision; not a script reference.
- `docs/state/CRITICAL-BATCH-PLAN-2026-06-02.md:69` — stem; generic stem-word collision; not a script reference.
- `docs/state/FEEDBACK-TRIAGE-2026-06-11.md:94` — stem; generic stem-word collision; not a script reference.
- `docs/state/SESSION-HANDOFF-2026-06-02.md:1` — stem; generic stem-word collision; not a script reference.
- `docs/state/SESSION-HANDOFF-2026-06-02.md:3` — stem; generic stem-word collision; not a script reference.
- `docs/state/SESSION-HANDOFF-2026-07-01.md:41` — stem; generic stem-word collision; not a script reference.
- `docs/state/STACK.md:145` — stem; generic stem-word collision; not a script reference.
- `docs/state/STATUS.md:227` — stem; generic stem-word collision; not a script reference.
- `docs/state/documentation-state-2026-05-23.md:155` — stem; generic stem-word collision; not a script reference.
- `docs/state/git-state-2026-05-23.md:147` — stem; generic stem-word collision; not a script reference.
- `e2e/maestro/bidder-app/screenshots/01-home.yaml:8` — stem; generic stem-word collision; not a script reference.
- `legal/privacy.md:141` — stem; generic stem-word collision; not a script reference.
- `legal/prohibited-items.md:230` — stem; generic stem-word collision; not a script reference.
- `package-lock.json:2296` — stem; generic stem-word collision; not a script reference.
- `package-lock.json:2770` — stem; generic stem-word collision; not a script reference.
- `package-lock.json:2772` — stem; generic stem-word collision; not a script reference.
- `packages/db/migrations/0093_default_policy_align_dispute_window.sql:64` — stem; generic stem-word collision; not a script reference.
- `packages/db/migrations/0093_default_policy_align_dispute_window.sql:130` — stem; generic stem-word collision; not a script reference.
- `packages/db/migrations/0122_dispute_response_hours.sql:69` — stem; generic stem-word collision; not a script reference.
- `packages/db/migrations/0125_open_due_lots.sql:4` — stem; generic stem-word collision; not a script reference.
- `packages/db/migrations/0157_policy_infra_and_audit_log.sql:191` — stem; generic stem-word collision; not a script reference.
- `packages/db/migrations/0242_auctions_unlisted.sql:6` — stem; generic stem-word collision; not a script reference.
- `packages/db/migrations/0242_auctions_unlisted.sql:21` — stem; generic stem-word collision; not a script reference.
- `packages/db/migrations/0306_retire_phantom_relist_children.sql:139` — stem; generic stem-word collision; not a script reference.
- `packages/db/migrations/0307_retire_duplicate_relist_twins.sql:142` — stem; generic stem-word collision; not a script reference.
- `packages/db/migrations/0322_duplicate_lot_enters_inventory.sql:133` — stem; generic stem-word collision; not a script reference.
- `packages/db/vitest.config.ts:5` — stem; generic stem-word collision; not a script reference.
- `packages/domain-lotting/package.json:5` — stem; generic stem-word collision; not a script reference.
- `packages/domain-lotting/src/ai/pricing.ts:1` — stem; generic stem-word collision; not a script reference.
- `packages/domain-lotting/src/lookup/index.ts:333` — stem; generic stem-word collision; not a script reference.
- `packages/domain-lotting/src/normalize/upc.ts:80` — stem; generic stem-word collision; not a script reference.
- `packages/shared/src/features.ts:83` — stem; generic stem-word collision; not a script reference.
- `packages/shared/src/features.ts:158` — stem; generic stem-word collision; not a script reference.
- `packages/shared/src/features.ts:164` — stem; generic stem-word collision; not a script reference.
- `packages/shared/src/features.ts:170` — stem; generic stem-word collision; not a script reference.
- `packages/shared/src/features.ts:176` — stem; generic stem-word collision; not a script reference.
- `packages/shared/src/features.ts:182` — stem; generic stem-word collision; not a script reference.
- `packages/shared/src/features.ts:188` — stem; generic stem-word collision; not a script reference.
- `scripts/demo-tools/record-bidder-demo.mjs:1` — stem; generic stem-word collision; not a script reference.
- `scripts/lottr-smoke/fetch-pages-extract-images.mjs:20` — stem; generic stem-word collision; not a script reference.
- `scripts/push-asc-metadata.mjs:109` — stem; generic stem-word collision; not a script reference.

### `scripts/demo-tools/inspect-demo-bid.mjs`

Standalone demo recording/probe/seeding kit; not the protected existing E2E suites. Dependency manifests remain under the lockfile/CI-cache guard.

Lines removed: 1.
References: none outside the file.

### `scripts/demo-tools/probe-lots.mjs`

Standalone demo recording/probe/seeding kit; not the protected existing E2E suites. Dependency manifests remain under the lockfile/CI-cache guard.

Lines removed: 1.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:609` — path, basename, stem; retained documentation/history; no file read.

### `scripts/demo-tools/record-bidder-demo.mjs`

Standalone demo recording/probe/seeding kit; not the protected existing E2E suites. Dependency manifests remain under the lockfile/CI-cache guard.

Lines removed: 1.
- `apps/field-mobile/features/lotting/LottingModeContext.tsx:34` — basename, stem; retained source/JSX comment; no file read.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:613` — path, basename, stem; retained documentation/history; no file read.

### `scripts/demo-tools/seed-demo-auction.mjs`

Standalone demo recording/probe/seeding kit; not the protected existing E2E suites. Dependency manifests remain under the lockfile/CI-cache guard.

Lines removed: 1.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:617` — path, basename, stem; retained documentation/history; no file read.

### `scripts/demo-tools/watch-demo-auction.mjs`

Standalone demo recording/probe/seeding kit; not the protected existing E2E suites. Dependency manifests remain under the lockfile/CI-cache guard.

Lines removed: 1.
References: none outside the file.

### `scripts/diagnose-msrp.mjs`

One-off clone/bootstrap or investigative probe; no production workflow/package/script caller.

Lines removed: 376.
References: none outside the file.

### `scripts/diagnostic-lot-save.js`

One-off clone/bootstrap or investigative probe; no production workflow/package/script caller.

Lines removed: 389.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:625` — path, basename, stem; retained documentation/history; no file read.

### `scripts/enrich-brands.js`

Obsolete one-off catalog/photo/category/brand queue backfill; not a current import or runtime entry point.

Lines removed: 212.
References: none outside the file.

### `scripts/fix-multiline-strings.py`

Retired provider inspection/one-off editing tool, uncalled by current CI or application code.

Lines removed: 53.
References: none outside the file.

### `scripts/gen-brand-art.mjs`

Superseded launch asset/cutover tool; current Workers, routes, existing CDN assets and operational deploy workflow remain unchanged.

Lines removed: 378.
- `apps/bidder-app/app.config.ts:116` — path, basename, stem; retained source/JSX comment; no file read.
- `apps/operator-web/src/app/(public)/_components/HomeHero.tsx:40` — basename, stem; retained source/JSX comment; no file read.
- `apps/operator-web/src/app/(public)/_components/LotCard.tsx:373` — path, basename, stem; retained source/JSX comment; no file read.
- `apps/operator-web/src/app/(public)/page.tsx:441` — basename, stem; retained source/JSX comment; no file read.
- `apps/operator-web/src/app/(public)/page.tsx:603` — path, basename, stem; retained source/JSX comment; no file read.

### `scripts/generate-brand-assets.mjs`

Superseded launch asset/cutover tool; current Workers, routes, existing CDN assets and operational deploy workflow remain unchanged.

Lines removed: 382.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:633` — path, basename, stem; retained documentation/history; no file read.
- `scripts/gen-brand-art.mjs:5` — basename, stem; removed sibling comment/docstring.

### `scripts/generate-brand-icons.py`

Superseded launch asset/cutover tool; current Workers, routes, existing CDN assets and operational deploy workflow remain unchanged.

Lines removed: 52.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:637` — path, basename, stem; retained documentation/history; no file read.

### `scripts/generate-v3-app-promo-card.py`

Superseded launch asset/cutover tool; current Workers, routes, existing CDN assets and operational deploy workflow remain unchanged.

Lines removed: 135.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:641` — path, basename, stem; retained documentation/history; no file read.
- `docs/state/git-state-2026-05-23.md:44` — basename, stem; retained documentation/history; no file read.

### `scripts/generate-v3-app-promo.py`

Superseded launch asset/cutover tool; current Workers, routes, existing CDN assets and operational deploy workflow remain unchanged.

Lines removed: 50.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:641` — stem; generic stem-word collision; not a script reference.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:645` — path, basename, stem; retained documentation/history; no file read.
- `docs/state/git-state-2026-05-23.md:44` — stem; generic stem-word collision; not a script reference.

### `scripts/import-competitor-lots-direct.js`

Fixed historical import/correction operation; current import workflows and incident evidence remain.

Lines removed: 347.
- `scripts/backfill-images-from-scrape.js:7` — path, basename, stem; removed sibling comment/docstring.

### `scripts/inspect-bidder-card.js`

One-off clone/bootstrap or investigative probe; no production workflow/package/script caller.

Lines removed: 287.
References: none outside the file.

### `scripts/ollama-smoke.mjs`

Retired provider inspection/one-off editing tool, uncalled by current CI or application code.

Lines removed: 136.
References: none outside the file.

### `scripts/process-icon.mjs`

Superseded launch asset/cutover tool; current Workers, routes, existing CDN assets and operational deploy workflow remain unchanged.

Lines removed: 306.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:671` — path, basename, stem; retained documentation/history; no file read.

### `scripts/r2-cleanup-legacy-packs.sh`

Superseded launch asset/cutover tool; current Workers, routes, existing CDN assets and operational deploy workflow remain unchanged.

Lines removed: 141.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:690` — path, basename, stem; retained documentation/history; no file read.

### `scripts/r2-upload-dupfix-pack.sh`

Superseded launch asset/cutover tool; current Workers, routes, existing CDN assets and operational deploy workflow remain unchanged.

Lines removed: 74.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:699` — path, basename, stem; retained documentation/history; no file read.

### `scripts/r2-upload-missing-pack.sh`

Superseded launch asset/cutover tool; current Workers, routes, existing CDN assets and operational deploy workflow remain unchanged.

Lines removed: 87.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:704` — path, basename, stem; retained documentation/history; no file read.

### `scripts/r2-upload-v3-extra.sh`

Superseded launch asset/cutover tool; current Workers, routes, existing CDN assets and operational deploy workflow remain unchanged.

Lines removed: 74.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:709` — path, basename, stem; retained documentation/history; no file read.

### `scripts/r2-upload-v3-og.sh`

Superseded launch asset/cutover tool; current Workers, routes, existing CDN assets and operational deploy workflow remain unchanged.

Lines removed: 113.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:714` — path, basename, stem; retained documentation/history; no file read.
- `scripts/crop-v3-og.py:9` — path, basename, stem; removed sibling comment/docstring.

### `scripts/r2-upload-v3-pack.sh`

Superseded launch asset/cutover tool; current Workers, routes, existing CDN assets and operational deploy workflow remain unchanged.

Lines removed: 101.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:719` — path, basename, stem; retained documentation/history; no file read.

### `scripts/reapply-backfilled.js`

Obsolete one-off catalog/photo/category/brand queue backfill; not a current import or runtime entry point.

Lines removed: 38.
References: none outside the file.

### `scripts/repair-round5-photos.mjs`

Obsolete one-off catalog/photo/category/brand queue backfill; not a current import or runtime entry point.

Lines removed: 64.
References: none outside the file.

### `scripts/research-competitor-categories.py`

Fixed historical import/correction operation; current import workflows and incident evidence remain.

Lines removed: 93.
- `packages/domain-lotting/src/constants.ts:77` — basename, stem; retained source/JSX comment; no file read.

### `scripts/run-brand-backfill.js`

Obsolete one-off catalog/photo/category/brand queue backfill; not a current import or runtime entry point.

Lines removed: 220.
- `docs/state/HANDOFF-taxonomy-v2-2026-05-24.md:159` — path, basename, stem; retained documentation/history; no file read.
- `docs/state/HANDOFF-taxonomy-v2-2026-05-24.md:202` — path, basename, stem; retained documentation/history; no file read.
- `docs/state/HANDOFF-taxonomy-v2-2026-05-24.md:281` — path, basename, stem; retained documentation/history; no file read.
- `packages/domain-lotting/src/normalize/README.md:146` — path, basename, stem; retained documentation/history; no file read.

### `scripts/stripe-webhook-inspect.mjs`

Retired provider inspection/one-off editing tool, uncalled by current CI or application code.

Lines removed: 132.
- `docs/state/CLEANUP-BRAND-REMAINING-2026-11-02.md:751` — path, basename, stem; retained documentation/history; no file read.
- `docs/state/git-state-2026-05-23.md:84` — path, basename, stem; retained documentation/history; no file read.

### `scripts/warm-cache-from-inventory.js`

Obsolete one-off catalog/photo/category/brand queue backfill; not a current import or runtime entry point.

Lines removed: 107.
References: none outside the file.

## Keep list — every retained tracked file

- `scripts/README-competitor-import.md` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/SUBMISSION_PLAYBOOK.md` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/__tests__/0442-lots-identity-code-twin.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/bidder-zip-0434.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/build-deduped-manifest-import.test.mjs` — Owner-required keep: __tests__; only build-deduped-manifest-import.test.mjs has the separately authorized one-line expectation correction.
- `scripts/__tests__/daily-summary.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/fill-bidder-zip-0436.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/fix-ai-photo-order.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/function-grants-lint.test.cjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/import-d2l-manifest-empty-load.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/load-zip-reference.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0431.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0439.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0440.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0444.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0445.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0447.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0451.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0453.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0454.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0457.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0458.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0471.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0473.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0474.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0475.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-0476.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/migration-runner-compat.test.cjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/new-lot-migration-lint.test.cjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/update-pending-intake-lot-0441.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/__tests__/zip-reference-0438.test.mjs` — Owner-required keep: __tests__; byte-identical.
- `scripts/admin-set-password.mjs` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/apply-migrations.js` — Workflow/package/test caller or documented operational dependency; retained byte-identical.
- `scripts/asc-rename-apps.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/audit-lottr-activity.mjs` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/build-deduped-manifest-import.mjs` — Retained test/workflow/script dependency; preserves operational regression coverage.
- `scripts/check-function-grants.cjs` — Workflow/package/test caller or documented operational dependency; retained byte-identical.
- `scripts/check-new-lot-migrations.cjs` — Workflow/package/test caller or documented operational dependency; retained byte-identical.
- `scripts/check-notification-kinds.mjs` — Workflow/package/test caller or documented operational dependency; retained byte-identical.
- `scripts/ci/apply-migrations-scratch.sh` — Owner-required keep: ci; byte-identical.
- `scripts/ci/fixture-0366.sql` — Owner-required keep: ci; byte-identical.
- `scripts/ci/fixture-0476-prod-find-lot-by-scan.sql` — Owner-required keep: ci; byte-identical.
- `scripts/ci/record-ota-publish.sh` — Owner-required keep: ci; byte-identical.
- `scripts/clean-expo-ios-credentials.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/cleanup-bogus-catalog.js` — Existing smoke/reviewer fixture chain; preserves owner-frozen test behavior and manual test support.
- `scripts/clear-asc-submission-blockers.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/copy-catalog.mjs` — Workflow/package/test caller or documented operational dependency; retained byte-identical.
- `scripts/copy-manifests.mjs` — Workflow/package/test caller or documented operational dependency; retained byte-identical.
- `scripts/daily-summary.mjs` — Scheduled production reporting dependency; daily-summary workflow/tests require it.
- `scripts/daily-summary/lib.mjs` — Scheduled production reporting dependency; daily-summary workflow/tests require it.
- `scripts/data/restored-title-corrections-20260921.json` — Retained incident/import evidence and regression data; no historical identifiers edited.
- `scripts/data/stale-load-picks-20261020.json` — Retained incident/import evidence and regression data; no historical identifiers edited.
- `scripts/delete-stale-provisioning-profile.mjs` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/demo-tools/package-lock.json` — Retained dependency manifests under lockfile guard; CI hashes **/package-lock.json. Recording/probe scripts removed.
- `scripts/demo-tools/package.json` — Retained dependency manifests under lockfile guard; CI hashes **/package-lock.json. Recording/probe scripts removed.
- `scripts/deploy-cf.sh` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/diagnose-lineage-duplicates.sql` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/eas-local.sh` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/enable-associated-domains-capability.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/enable-play-api.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/fetch-testflight-crashlogs.mjs` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/fetch-testflight-feedback.mjs` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/gen-types.js` — Workflow/package/test caller or documented operational dependency; retained byte-identical.
- `scripts/generate-legal-content.mjs` — Workflow/package/test caller or documented operational dependency; retained byte-identical.
- `scripts/get-play-app-signing-sha.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/hosted-seed.sql` — Existing smoke/reviewer fixture chain; preserves owner-frozen test behavior and manual test support.
- `scripts/hosted-test-auctions.sql` — Existing smoke/reviewer fixture chain; preserves owner-frozen test behavior and manual test support.
- `scripts/import-competitor-lots.js` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/import-d2l-manifest.mjs` — Retained test/workflow/script dependency; preserves operational regression coverage.
- `scripts/inspect-app-id-capabilities.mjs` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/inspect-asc-review.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/inspect-operator-state.mjs` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/inspect-play-submission.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/inspect-tax-readiness.mjs` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/invalidate-stale-lookups.mjs` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/ipa-investigate.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/load-zip-reference.mjs` — Retained test/workflow/script dependency; preserves operational regression coverage.
- `scripts/lottr-smoke/.gitignore` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/README.md` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/end-to-end-pipeline.mjs` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fetch-pages-extract-images.mjs` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/_manifest.json` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/amazon-CLU-001046.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/amazon-CLU-001048.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/amazon-CLU-001051.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/amazon-CLU-001056.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/amazon-CLU-001061.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/brand_model-CLU-001045.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/brand_only-CLU-001055.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/brand_only-CLU-001058.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/brand_only-CLU-001060.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/brand_only-CLU-001063.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/brand_only-CLU-001067.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/no_id-CLU-001057.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/upc-CLU-001059.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/upc-CLU-001062.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/upc-CLU-001064.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/upc-CLU-001065.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/intake/upc-CLU-001066.jpeg` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/fixtures/manifest.example.json` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/models.json` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/prompt-ab.mjs` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/prompts/photo-identify.in-repo.txt` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/prompts/photo-identify.live.txt` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/prompts/photo-identify.minimal.txt` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/prompts/photo-identify.ocr-first.txt` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/prompts/photo-identify.search-aware.txt` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/prompts/photo-identify.simple.txt` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/prompts/photo-identify.v1.txt` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/prompts/photo-identify.v2-cut.txt` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/prompts/stock-images.relaxed.txt` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/prompts/stock-images.strict.txt` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/prompts/stock-images.url-finder.txt` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/prompts/url-finder.high-og.txt` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/pull-recent-intake.mjs` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/run-sonar.mjs` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/run.mjs` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/sonar-models.json` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/lottr-smoke/stock-images-ab.mjs` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/README.md` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/cleanup.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/index.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/lib/assert.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/lib/cost.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/lib/env.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/lib/fixtures.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/lib/reporter.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/lib/supa.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/lib/timer.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/personas/account_deleter.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/personas/ai_budget.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/personas/auctioneer.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/personas/bidders.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/personas/binsmith.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/personas/closer.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/personas/janitor.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/personas/lotter.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/personas/operator.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/personas/operator_policies.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/personas/photographer.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/personas/picker.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/personas/pricing_tiers.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/mega-sim/personas/racers.js` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/ops/fix-ai-photo-order.mjs` — Retained test/workflow/script dependency; preserves operational regression coverage.
- `scripts/ops/fix-ai-photo-order.targets.json` — Retained test/workflow/script dependency; preserves operational regression coverage.
- `scripts/post-deploy-check.mjs` — Workflow/package/test caller or documented operational dependency; retained byte-identical.
- `scripts/preflight-deps.mjs` — Workflow/package/test caller or documented operational dependency; retained byte-identical.
- `scripts/preflight-static.mjs` — Workflow/package/test caller or documented operational dependency; retained byte-identical.
- `scripts/prod-cost-report.mjs` — Workflow/package/test caller or documented operational dependency; retained byte-identical.
- `scripts/prod-rig/0382-dry-run.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0382-rig/README.md` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0382-rig/check.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0382-rig/seed.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0382_ROLLBACK_unstrand_closed_auction_drafts.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0387_ROLLBACK_import_rows_external_code_idx.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0394_ROLLBACK_relot_staff_only.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0406_ROLLBACK_warehouse_active_and_customer_info.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0407_ROLLBACK_public_warehouse_pickup_info.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0408_ROLLBACK_warehouse_timezones_central.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0409_ROLLBACK_public_offsite_sales.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0410_ROLLBACK_warehouse_notice_acks.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0411_ROLLBACK_crandall_warehouse.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0412_ROLLBACK_crandall_golive_copy.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0413_ROLLBACK_ota_publishes.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0416_ROLLBACK_duplicate_lot_worker_attribution.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0416_backfill_duplicate_lot_worker.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0417_ROLLBACK_money_daily_revenue.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0418_ROLLBACK_operator_reports_period_summary.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0419_ROLLBACK_lot_category_id_follows_category_edit.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0419_backfill_lot_category_id.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0420_ROLLBACK_worker_reports_unshelved.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0421_ROLLBACK_refunds_by_refund_date.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0422_ROLLBACK_money_daily_on_refund_ledger.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0423_ROLLBACK_bidder_directory_bidder_number.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0424_ROLLBACK_app_versions.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0426_ROLLBACK_missing_item_checks.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0428_ROLLBACK_lots_carry_load.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0429_ROLLBACK_load_summary.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0430_ROLLBACK_revoke_anon_load_functions.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0431-dry-run.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0431_ROLLBACK_correct_stale_load_picks.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0432-dry-run.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0432_ROLLBACK_archive_empty_loads.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0434_ROLLBACK_bidder_postal_code.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0435-rig/cases.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0435-rig/prodgrants.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0435-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0435-rig/seed.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0435-rig/seed_reset.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0435_ROLLBACK_bidders_column_grants.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0436_ROLLBACK_fill_bidder_postal_code_from_card.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0438_ROLLBACK_zip_reference.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0439_ROLLBACK_lock_backup_tables.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0440_ROLLBACK_tighten_public_grants.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0441_ROLLBACK_update_pending_intake_lot.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0442_ROLLBACK_lots_identity_code_twin.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0444-rig/cases.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0444-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0444-rig/seed.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0444_ROLLBACK_undo_invoice_line_forfeit.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0445-rig/cases.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0445-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0445-rig/seed.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0445_ROLLBACK_missing_item_found_follows_relist.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0447-rig/cases.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0447-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0447_ROLLBACK_builder_collected_lots.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0448_ROLLBACK_bidder_optional_profile.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0449_ROLLBACK_bidder_insights.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0451-rig/cases-after.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0451-rig/cases-before.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0451-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0451-rig/seed.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0451_ROLLBACK_sqft_bid_mode_unit_qty.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0452_ROLLBACK_missing_items_report_warehouse.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/build-base.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/cases-per-unit.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/conc-before.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/conc-fns.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/conc-lib.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/conc-pu.pgb` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/conc-std.pgb` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/conc-std2.pgb` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/dump-conc-state.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/gen-0453.py` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/header-0453-rollback.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/header-0453.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/helpers.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/http.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/postgrest-setup.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/postgrest.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/preflight-prod.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/replay.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/scenario-standard.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/seed.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/timing-pu.pgb` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/timing-std.pgb` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453-rig/timing-std3.pgb` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0453_ROLLBACK_sqft_place_bid_per_unit.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0454-rig/build-base.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0454-rig/cases-guards.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0454-rig/helpers.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0454-rig/preflight-prod.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0454-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0454-rig/scenario-standard.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0454-rig/seed.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0454-rig/timing.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0454_ROLLBACK_sqft_guards.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0457-rig/cases-after.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0457-rig/cases-before.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0457-rig/cases.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0457-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0457-rig/seed.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0457_ROLLBACK_member_pro.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0458-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0458_ROLLBACK_revoke_enqueue_notification.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0471-rig/auth-stub.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0471-rig/cases.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0471-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0471-rig/seed.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0471_ROLLBACK_lot_withdraw_and_undo.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0473-rig/cases.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0473-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0473-rig/seed.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0473_ROLLBACK_lot_warehouse_transfer.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0474-rig/cases.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0474-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0474-rig/seed.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0474_ROLLBACK_refund_override.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0475-rig/STATUS-SCREENS.md` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0475-rig/backfill-candidates.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0475-rig/cases.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0475-rig/money.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0475-rig/rls.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0475-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0475-rig/scenario-standard.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0475-rig/seed.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0475-rig/supabase176.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0475_ROLLBACK_refund_lot_status.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0476-rig/cases.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0476-rig/gen0476.py` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0476-rig/live-body-2026-10-28.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0476-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0476-rig/seed.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0476_ROLLBACK_scan_resolver_ignores_dead_sales.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0477-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0477_ROLLBACK_feedback_notify_and_reply.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0478-rig/run.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/0478_ROLLBACK_revoke_cron_writer_functions.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/PROPOSED_load_backfill.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/PROPOSED_load_backfill_ROLLBACK.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/README.md` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/close-check-after-0376.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/delete-lot-guard-scenario.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/finalize-scenario.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/missing-no-forfeit-scenario.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/oct7-preflight.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/oct7-verify-0382.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/oct7-verify-0387.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/pull-prod-functions.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/q.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/relot-double-tap-scenario.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/relot-staff-only-scenario.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/rig-stubs.sh` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/rollback-0386.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/rollback-0392.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/prod-rig/rollback-0393.sql` — Migration recovery/scratch verification chain and supporting SQL; includes dynamic file inputs and test-covered rollback paths. Not executed.
- `scripts/pull-asc-screenshots.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/push-asc-metadata.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/push-hosted-migrations.js` — Workflow/package/test caller or documented operational dependency; retained byte-identical.
- `scripts/push-play-assets.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/r2-purge-cache.sh` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/resize-screenshots.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/resubmit-asc-with-new-build.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/reverify-drain-heroes.mjs` — Workflow/package/test caller or documented operational dependency; retained byte-identical.
- `scripts/seed-app-reviewer-fixtures.mjs` — Existing smoke/reviewer fixture chain; preserves owner-frozen test behavior and manual test support.
- `scripts/seed-test-operator-b.js` — Existing smoke/reviewer fixture chain; preserves owner-frozen test behavior and manual test support.
- `scripts/smoke-test-e2e.js` — Existing smoke/reviewer fixture chain; preserves owner-frozen test behavior and manual test support.
- `scripts/smoke-test-lookups.js` — Existing smoke/reviewer fixture chain; preserves owner-frozen test behavior and manual test support.
- `scripts/smoke/cron-schedule-guard.mjs` — Owner-required keep: smoke; byte-identical.
- `scripts/smoke/prod-http-smoke.mjs` — Owner-required keep: smoke; byte-identical.
- `scripts/smoke/source-guards.mjs` — Owner-required keep: smoke; byte-identical.
- `scripts/square-bidfta-crossref.mjs` — Workflow/package/test caller or documented operational dependency; retained byte-identical.
- `scripts/store-release/asc_crashes.py` — Owner-required keep: store-release; byte-identical.
- `scripts/store-release/asc_release.py` — Owner-required keep: store-release; byte-identical.
- `scripts/store-release/asc_status.py` — Owner-required keep: store-release; byte-identical.
- `scripts/store-release/play_promote.py` — Owner-required keep: store-release; byte-identical.
- `scripts/store-release/play_status.py` — Owner-required keep: store-release; byte-identical.
- `scripts/store-release/version_guard.py` — Owner-required keep: store-release; byte-identical.
- `scripts/stress-sim/README.md` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/stress-sim/report-2026-07-04.json` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/stress-sim/run.mjs` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/stress-sim/shim.sql` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/submit-android-play-store.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/submit-ios-app-store.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/supabase-auth-config.mjs` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/swap-asc-build.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/test-backend/apply-schema.mjs` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/test-backend/seed.mjs` — Existing smoke/E2E/test harness, inputs or evidence; frozen for this phase.
- `scripts/traffic-by-hour.sql` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/upload-asc-screenshots.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/verify-pg-cron.mjs` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.
- `scripts/verify-play-api-only.mjs` — Reusable store-release, signing, submission or crash-recovery tool/documentation; protected identity contracts retained.
- `scripts/void-demo-invoice.mjs` — Reusable manual operations/import/diagnostic/recovery tool or its documentation; not a confirmed obsolete launch/backfill/clone artifact.

## Boundaries and open items

- Generic store/admin/auth/cache maintenance tools remain because they are reusable, not proven completed one-offs. Existing copy/import/hero workflows still call legacy tools, so those dependencies stay even where their names sound disposable.
- The standalone demo dependency manifest/lock stay under the owner lockfile guard and current CI cache reader; no versions changed. Removing those manifests can be reviewed separately.
- Migration recovery SQL and their scratch rigs stay together. This is not permission to run them, edit migrations, or query/write production.
- Existing E2E/smoke suites and their seeding helpers remain unchanged, including the already-disclosed production synthetic-user setup. Phase 2 tracks that boundary.
- This audit does not erase the previous brand inventory: it describes the step 3 commit, while this record describes the later scripts removal.
