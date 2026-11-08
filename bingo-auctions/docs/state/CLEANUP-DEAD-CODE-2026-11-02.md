# Step 6 dead-code review — 2026-11-02

Base: `6fd214480b6367f8f91b5767378b6062795eb8a3` (#643 merged). Step 5 had no standalone deployment. Step 6 needs explicit merge approval and one web deployment; cron Worker unchanged and must be skipped. Must be merged and deploying by 15:45 Central; otherwise hold until 09:00 the following day. Then verify /api/version and run post-deploy-check.yml. No automatic future action is scheduled.

## Changes and callers

- Removed only dead entries from OPERATOR_CONSOLE_PREFIXES: `/billing`, `/payouts`, `/customers`, `/manifests`, `/picker`, `/users`, `/operator`, `/transfers`, `/payments`, `/devices`. No matching pages exist after resolving route groups. Sensitive/MFA and public route lists, session refresh, cookies and real console prefixes remain unchanged. Anonymous requests to these dead paths now reach 404 rather than login; live account access is unchanged.
- Deleted unscheduled `apps/operator-web/src/app/api/cron/social-post/route.ts` (28 lines). No cron Worker schedule or executable workflow/script calls it. Two workflow comment references remain as historical/descriptive references only. Updated the schedule guard exception for the removed endpoint; retained the guard and all its checks.
- Retained `lib/social/runner.ts`: marketing/actions.ts calls it for dry-run and live manual posting. The runner includes ended-auction takedowns, so deleting the runner would break a real caller. This cleanup neither schedules nor invokes it; historical flags/row counts are not claimed as current production facts.
- Deleted the zero-byte field-mobile stray file whose name starts U+F001. No path/basename reader exists in tracked text; it is not TypeScript source.
- Field-mobile has no import/require/dynamic-reference to @auction-platform/domain-fulfillment. Removed only its workspace dependency via npm uninstall -w; package scope and the fulfillment package remain. Lock JSON comparison proves only the apps/field-mobile dependency edge changed, with zero package version changes.

## V2 console inventory — keep all

All 67 tracked v2 files remain unchanged, including screens, supporting components, fixtures and tests. Current page entry points import these views; they are not deletion candidates.

- `apps/operator-web/src/app/(operator)/auctions/[id]/builder/v2/AuctionBuilderV2.tsx`
- `apps/operator-web/src/app/(operator)/auctions/[id]/builder/v2/__tests__/auction-builder-v2.test.tsx`
- `apps/operator-web/src/app/(operator)/auctions/[id]/builder/v2/auction-builder-copy.tsx`
- `apps/operator-web/src/app/(operator)/auctions/[id]/v2/AuctionDetailLotSummary.tsx`
- `apps/operator-web/src/app/(operator)/auctions/[id]/v2/AuctionDetailV2.tsx`
- `apps/operator-web/src/app/(operator)/auctions/[id]/v2/AuctionPreviewQrCard.tsx`
- `apps/operator-web/src/app/(operator)/auctions/[id]/v2/__fixtures__/auction-detail-fixture.tsx`
- `apps/operator-web/src/app/(operator)/auctions/[id]/v2/__tests__/auction-detail-v2.test.tsx`
- `apps/operator-web/src/app/(operator)/auctions/[id]/v2/auction-detail-types.ts`
- `apps/operator-web/src/app/(operator)/auctions/[id]/v2/auction-preview-url.ts`
- `apps/operator-web/src/app/(operator)/auctions/v2/AuctionStatusPill.tsx`
- `apps/operator-web/src/app/(operator)/auctions/v2/AuctionsV2.tsx`
- `apps/operator-web/src/app/(operator)/auctions/v2/__fixtures__/auctions-list-fixture.ts`
- `apps/operator-web/src/app/(operator)/auctions/v2/__tests__/auctions-v2.test.tsx`
- `apps/operator-web/src/app/(operator)/auctions/v2/auction-date-label.ts`
- `apps/operator-web/src/app/(operator)/auctions/v2/auction-list-types.ts`
- `apps/operator-web/src/app/(operator)/dashboard/v2/DashboardV2.tsx`
- `apps/operator-web/src/app/(operator)/dashboard/v2/DecisionsWaiting.tsx`
- `apps/operator-web/src/app/(operator)/dashboard/v2/NeedsAttention.tsx`
- `apps/operator-web/src/app/(operator)/dashboard/v2/NextToClose.tsx`
- `apps/operator-web/src/app/(operator)/dashboard/v2/StatCards.tsx`
- `apps/operator-web/src/app/(operator)/dashboard/v2/WeekFinance.tsx`
- `apps/operator-web/src/app/(operator)/dashboard/v2/__fixtures__/dashboard-fixture.ts`
- `apps/operator-web/src/app/(operator)/dashboard/v2/__tests__/build-floor-stages.test.ts`
- `apps/operator-web/src/app/(operator)/dashboard/v2/__tests__/dashboard-v2.test.tsx`
- `apps/operator-web/src/app/(operator)/dashboard/v2/__tests__/floor-story.test.ts`
- `apps/operator-web/src/app/(operator)/dashboard/v2/build-floor-stages.ts`
- `apps/operator-web/src/app/(operator)/dashboard/v2/floor-story.ts`
- `apps/operator-web/src/app/(operator)/lots/[id]/v2/LotDetailFloorRail.tsx`
- `apps/operator-web/src/app/(operator)/lots/[id]/v2/LotDetailV2.tsx`
- `apps/operator-web/src/app/(operator)/lots/[id]/v2/__fixtures__/lot-detail-actions-fixture.tsx`
- `apps/operator-web/src/app/(operator)/lots/[id]/v2/__fixtures__/lot-detail-fixture.tsx`
- `apps/operator-web/src/app/(operator)/lots/[id]/v2/__tests__/lot-detail-v2-button-skin.test.tsx`
- `apps/operator-web/src/app/(operator)/lots/[id]/v2/__tests__/lot-detail-v2.test.tsx`
- `apps/operator-web/src/app/(operator)/lots/[id]/v2/lot-detail-types.ts`
- `apps/operator-web/src/app/(operator)/lotting/inventory/v2/InventoryThumb.tsx`
- `apps/operator-web/src/app/(operator)/lotting/inventory/v2/InventoryV2.tsx`
- `apps/operator-web/src/app/(operator)/lotting/inventory/v2/InventoryV2BulkActionBar.tsx`
- `apps/operator-web/src/app/(operator)/lotting/inventory/v2/InventoryV2List.tsx`
- `apps/operator-web/src/app/(operator)/lotting/inventory/v2/__fixtures__/inventory-fixture.tsx`
- `apps/operator-web/src/app/(operator)/lotting/inventory/v2/__tests__/inventory-v2-bulk.test.tsx`
- `apps/operator-web/src/app/(operator)/lotting/inventory/v2/__tests__/inventory-v2-button-skin.test.tsx`
- `apps/operator-web/src/app/(operator)/lotting/inventory/v2/__tests__/inventory-v2-refunded.test.tsx`
- `apps/operator-web/src/app/(operator)/lotting/inventory/v2/__tests__/inventory-v2-table.test.tsx`
- `apps/operator-web/src/app/(operator)/lotting/inventory/v2/__tests__/inventory-v2.test.tsx`
- `apps/operator-web/src/app/(operator)/lotting/inventory/v2/inventory-bulk-helpers.ts`
- `apps/operator-web/src/app/(operator)/lotting/inventory/v2/inventory-location.ts`
- `apps/operator-web/src/app/(operator)/lotting/inventory/v2/inventory-types.ts`
- `apps/operator-web/src/app/(operator)/pickups/v2/InvoicePaymentPill.tsx`
- `apps/operator-web/src/app/(operator)/pickups/v2/PickupV2Rows.tsx`
- `apps/operator-web/src/app/(operator)/pickups/v2/PickupsFloorRail.tsx`
- `apps/operator-web/src/app/(operator)/pickups/v2/PickupsV2.tsx`
- `apps/operator-web/src/app/(operator)/pickups/v2/__fixtures__/pickups-fixture.ts`
- `apps/operator-web/src/app/(operator)/pickups/v2/__tests__/pickups-v2-button-skin.test.tsx`
- `apps/operator-web/src/app/(operator)/pickups/v2/__tests__/pickups-v2.test.tsx`
- `apps/operator-web/src/app/(operator)/pickups/v2/map-pickup-row.ts`
- `apps/operator-web/src/app/(operator)/pickups/v2/pickup-types.ts`
- `apps/operator-web/src/app/(operator)/warehouses/[id]/v2/PickupHoursSlotPreviewV2.tsx`
- `apps/operator-web/src/app/(operator)/warehouses/[id]/v2/WarehouseFormPageV2.tsx`
- `apps/operator-web/src/app/(operator)/warehouses/[id]/v2/WarehouseHubV2.tsx`
- `apps/operator-web/src/app/(operator)/warehouses/[id]/v2/__fixtures__/warehouse-hub-fixture.ts`
- `apps/operator-web/src/app/(operator)/warehouses/[id]/v2/__tests__/warehouse-hub-v2.test.tsx`
- `apps/operator-web/src/app/(operator)/warehouses/v2/WarehousesV2.tsx`
- `apps/operator-web/src/app/(operator)/warehouses/v2/__fixtures__/warehouses-fixture.ts`
- `apps/operator-web/src/app/(operator)/warehouses/v2/__tests__/warehouses-v2.test.tsx`
- `apps/operator-web/src/app/(operator)/warehouses/v2/warehouse-labels.ts`
- `apps/operator-web/src/app/(operator)/warehouses/v2/warehouse-types.ts`

## Verification / rollback

- Local typecheck, lint, workspace unit/DB tests run sequentially; final results and remote CI/E2E belong in the PR table. Preflight/source/schedule guards and whitespace check required. No migrations, production scripts, DB writes, OTA or local app builds.
- Revert eventual squash SHA on braden/revert-cleanup-6; draft PR and wait for explicit merge. Redeploy needed if shipped. Roll back the failing live website deployment first, require post-deploy-check green, then investigate. Record the actual last-green deployment/version immediately before shipping; unrelated owner deployments may have advanced production.
- No migration, legal, native/EAS/store identity, E2E file, Worker configuration, cron schedule or payment/referral/bidding/checkout/pickup implementation changes. Existing owner-authorized E2E and automatic CI smoke builds stay unchanged.
