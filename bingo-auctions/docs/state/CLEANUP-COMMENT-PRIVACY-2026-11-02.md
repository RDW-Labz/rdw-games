# App-comment privacy cleanup — 2026-11-02

Base: `8f3336b5638184e207444c8cdaf86e0cbf96fd5f` (#642 merged). This step changes comments only and has **no separate deploy**, by owner instruction. It ships with step 6’s approved deployment. Mobile source still waits for the next normal app release.

## Scope and proof

- Parsed 1,214 tracked TypeScript/JavaScript source files in apps/ and packages/; the baseline comment inventory contains 31,525 comment ranges. Reviewed email patterns, name-like phrases and incident/feedback context, then followed full names, first-name-only and paired-reporter attributions.
- Anonymized 42 comment locations across 26 files, including customer examples and unnecessary personal feedback attributions. Dates, incident counts and technical explanations remain. Exact identified-person sweeps now find zero remaining comment hits. This is source-review evidence, not a claim to recognize every possible person name automatically.
- All 26 edited source files print identically to the base after TypeScript strips comments: no executable statement, literal, type, JSX text, query, event, API call, location pin, validation, navigation or behavior changed.
- All migration, legal, E2E, workflow, lockfile, package identity, native module/plugin, app configuration and EAS files remain byte-identical. No install, linked folder, migration, production script, OTA, app release or production mutation was performed for cleanup.

## Changed comment locations (base line numbers; values omitted)

- `apps/bidder-app/app/(tabs)/index.tsx:944` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/bidder-app/app/profile/past-wins.tsx:365` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/checkout/pickup-verify.tsx:828` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/checkout/pickup-verify.tsx:1786` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/feedback.tsx:125` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/layout/lots/find.tsx:17` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/layout/lots/find.tsx:82` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/layout/lots/find.tsx:272` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/layout/lots/find.tsx:301` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/layout/lots/find.tsx:343` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/layout/lots/find.tsx:756` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/layout/lots/find.tsx:776` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/layout/lots/find.tsx:858` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/layout/lots/find.tsx:1041` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/lotting/manual.tsx:154` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/lotting/manual.tsx:723` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/lotting/photo.tsx:233` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/lotting/photo.tsx:235` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/lotting/quick.tsx:414` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/lotting/quick.tsx:666` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/lotting/quick.tsx:1444` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/lotting/quick.tsx:1552` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/lotting/quick.tsx:2926` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/app/(staff)/worklist/[id].tsx:545` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/features/lotting/PreStickeredScanner.tsx:86` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/features/lotting/useDraftPersistence.ts:4` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/features/lotting/useDraftPersistence.ts:22` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/lib/missing-mark.ts:1` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/field-mobile/lib/session-watchdog.ts:4` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/operator-web/src/app/(auth)/reset-password/page.tsx:4` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/operator-web/src/app/(operator)/feedback/SilentExits.tsx:6` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/operator-web/src/app/(operator)/invoices/page.tsx:59` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/operator-web/src/app/api/invoices/[id]/mark-paid/route.ts:127` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/operator-web/src/app/api/invoices/[id]/refund-items/route.ts:249` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/operator-web/src/app/api/square/webhook/route.ts:240` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/operator-web/src/app/profile/past-wins/page.tsx:284` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/operator-web/src/app/profile/pickup/page.tsx:25` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/operator-web/src/lib/charge-attempts.ts:5` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `apps/operator-web/src/lib/cron/auto-charge-drain.ts:659` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `packages/domain-bidding/src/components/PhotoCarousel.tsx:7` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `packages/domain-lotting/src/persistence.ts:457` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.
- `packages/supabase-client/src/session.ts:16` — generic customer/staff incident or feedback attribution replaces a personal identifier; technical explanation retained.

## Retained email-comment hits

These are technical/operational addresses or synthetic identities, not customer incident examples. Values are deliberately omitted.

- `apps/operator-web/e2e/fixtures/bidder-auth.ts:19` — Frozen existing E2E synthetic identity; no E2E file/config changes permitted.
- `apps/operator-web/e2e/setup/global-setup.ts:4` — Frozen existing E2E synthetic identity; no E2E file/config changes permitted.
- `apps/operator-web/playwright.config.ts:18` — Frozen existing E2E synthetic identity; no E2E file/config changes permitted.
- `apps/operator-web/playwright.config.ts:29` — Frozen existing E2E synthetic identity; no E2E file/config changes permitted.
- `apps/operator-web/src/app/(operator)/account/security/page.tsx:24` — Public support-contact instruction; not a customer address.
- `apps/operator-web/src/app/api/debug/alert-check/route.ts:21` — Internal operational alert example/history; not a customer address or changed delivery configuration.
- `apps/operator-web/src/lib/__tests__/tooling-domain-defaults.test.ts:18` — Synthetic identity documented by an existing negative-case regression test.
- `apps/operator-web/src/lib/ops-alert.ts:28` — Internal operational alert example/history; not a customer address or changed delivery configuration.

## Immutable migration findings — list only

**28 matching lines in 20 migration files**. Includes personal/reporting-name tokens and email literals; some are operational or synthetic examples. No names, email values or row identifiers are copied here. **No migration bytes changed**: their checksums live in the production ledger. This list is not permission to edit or replay them.

- `packages/db/migrations/0109_operator_invites_and_requests.sql:15` — email literal (includes synthetic/operational examples); unchanged.
- `packages/db/migrations/0181_demo_operator_visibility.sql:9` — email literal (includes synthetic/operational examples); unchanged.
- `packages/db/migrations/0181_demo_operator_visibility.sql:68` — email literal (includes synthetic/operational examples); unchanged.
- `packages/db/migrations/0205_operator_role_capabilities.sql:37` — email literal (includes synthetic/operational examples); unchanged.
- `packages/db/migrations/0253_fix_partial_refund_status_flip.sql:3` — personal-name token; unchanged.
- `packages/db/migrations/0261_invoice_build_after_auction_close.sql:3` — personal-name token; unchanged.
- `packages/db/migrations/0262_attach_orphaned_wins_as_comp.sql:10` — personal-name token; unchanged.
- `packages/db/migrations/0325_feedback_attachments.sql:5` — personal-name token; unchanged.
- `packages/db/migrations/0326_duplicate_lot_no_inherited_shelf.sql:3` — personal-name token; unchanged.
- `packages/db/migrations/0326_duplicate_lot_no_inherited_shelf.sql:26` — personal-name token; unchanged.
- `packages/db/migrations/0327_customer_feedback_from_the_web.sql:7` — email literal (includes synthetic/operational examples); unchanged.
- `packages/db/migrations/0328_lot_location_history.sql:3` — personal-name token; unchanged.
- `packages/db/migrations/0329_relist_child_enters_the_auction_scheduled.sql:3` — personal-name token; unchanged.
- `packages/db/migrations/0330_bigger_feedback_attachments.sql:4` — personal-name token; unchanged.
- `packages/db/migrations/0331_repair_refunds_clobbered_by_the_payment_webhook.sql:13` — email literal (includes synthetic/operational examples); unchanged.
- `packages/db/migrations/0332_charge_attempt_history_and_card_facts.sql:4` — personal-name token and email literal; unchanged.
- `packages/db/migrations/0332_charge_attempt_history_and_card_facts.sql:36` — personal-name token; unchanged.
- `packages/db/migrations/0332_charge_attempt_history_and_card_facts.sql:70` — personal-name token; unchanged.
- `packages/db/migrations/0338_who_lotted_this_box.sql:3` — personal-name token; unchanged.
- `packages/db/migrations/0344_disposed_lots_do_not_pin_auctions_open.sql:17` — personal-name token; unchanged.
- `packages/db/migrations/0346_worker_productivity_counts_in_the_database.sql:5` — personal-name token; unchanged.
- `packages/db/migrations/0346_worker_productivity_counts_in_the_database.sql:21` — personal-name token; unchanged.
- `packages/db/migrations/0346_worker_productivity_counts_in_the_database.sql:22` — personal-name token; unchanged.
- `packages/db/migrations/0346_worker_productivity_counts_in_the_database.sql:23` — personal-name token; unchanged.
- `packages/db/migrations/0346_worker_productivity_counts_in_the_database.sql:24` — personal-name token; unchanged.
- `packages/db/migrations/0348_productivity_counts_lotting_not_relisting.sql:43` — personal-name token; unchanged.
- `packages/db/migrations/0350_self_raise_can_only_raise.sql:7` — email literal (includes synthetic/operational examples); unchanged.
- `packages/db/migrations/0399_revert_handover_bed_brn4982227.sql:6` — email literal (includes synthetic/operational examples); unchanged.

## Verification and deployment

- Forced typecheck (12/12) and lint (11/11) passed on the final comment set. Preflight and source/schedule guards passed.
- Initial workspace unit/DB tests passed. A final concurrent run failed the untouched image-enrichment wall-clock assertion (716 ms; expected <200 ms). Phase stopped; owner explicitly authorized one isolated retry, then a unit-only run if that passes. Neither timing test nor implementation is changed. The isolated timing test passed (one selected test, 19 skipped, 66 ms test duration). The unit-only rerun then passed all 12 workspace tasks in 14.2 s, including operator-web 141 files / 1,255 tests, and DB tests (7 passed / 48 optional skipped). Final remote CI evidence is recorded in the PR.
- No standalone step 5 deploy. After explicit merge approval, let step 6 carry these comments; deploy step 6 before 16:00 Central, or hold until 09:00 tomorrow, then verify /api/version and require post-deploy-check.yml green. This documents the hold; it does not claim a scheduled automatic action.
- If source needs reverting before deployment: draft branch braden/revert-cleanup-5, git revert the eventual squash SHA, wait for owner merge. No immediate redeploy is needed while unshipped. If later shipped with step 6, roll back the failing live deployment first and follow the recorded plan. Never edit migration files as a rollback.
