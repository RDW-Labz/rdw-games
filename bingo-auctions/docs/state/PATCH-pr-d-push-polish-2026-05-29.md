# PATCH — PR-D push polish + SCA verify-card route

**Date:** 2026-05-29
**Branch:** `feat/push-polish-prd` → master
**Blueprint:** `docs/audits/prd-push-polish-2026-05-29.md`

## What ships

PR-D is the bidder-app push notification polish layer that follows PR-A1/A2 (operator policy) + PR-B (bidder visibility) + PR-C (staff refund + worker). Pure TS — no migrations, no native rebuild, OTA-safe.

### Scope

| File | Change | Class |
|---|---|---|
| `apps/operator-web/src/lib/cron/payment-followups.ts:147` | `bidwizops://invoice/` → `clovrbid://invoice/` | scheme |
| `apps/operator-web/src/app/api/webhooks/stripe/route.ts:431` | `bidwizops://invoice/` → `clovrbid://invoice/`; "within 48 hours" → operator-agnostic copy | scheme + copy |
| `apps/operator-web/src/lib/cron/auto-charge-drain.ts:572` | `bidwizops://account/payment-method` → `clovrbid://profile/payment-method` | scheme |
| `apps/operator-web/src/lib/cron/auto-charge-drain.ts:586,588` | `bidwizops://invoice/${id}` → `clovrbid://invoice/${id}`; "within 48 hours" → operator-agnostic copy | scheme + copy |
| `apps/operator-web/src/lib/cron/auto-charge-drain.ts:613` | `bidwizops://verify-card` → `clovrbid://verify-card?invoice_id=${id}` | scheme |
| `apps/operator-web/src/lib/cron/grace-expiry.ts` | SELECT `operator_id`; batch-lookup `operator_policies.relist_fee_cents`; format body with actual fee; deep-link → `clovrbid://profile/pay-fees` | scheme + copy + policy read |
| `apps/operator-web/src/lib/cron/notifications-drain.ts` | Wide `OutboxRow.kind` (`string`); 10 new switch arms + `default` arm; multi-lot rollup with 15s grace; "Tap to pay" → "We auto-charged your card. Tap to view your pickup window." | union + rollup + copy |
| `apps/bidder-app/app/_layout.tsx` | Add `expo-linking` import; replace `handlePushResponse` with kind-aware router (prefers `deep_link`, then switches by kind); add `<Stack.Screen name="verify-card" />` | router rewrite |
| `apps/bidder-app/app/verify-card.tsx` | **NEW** — PaymentSheet recovery screen | new |
| `docs/audits/prd-push-polish-2026-05-29.md` | Audit doc copied into worktree | docs |
| `docs/state/PATCH-pr-d-push-polish-2026-05-29.md` | This file | docs |

### Why each change

**Scheme sweep — fixes silent push-tap drops.** The bidder app's scheme is `clovrbid` (`app.config.ts:27`); the staff app is `bidwizops`. Six bidder-targeted payloads encoded `bidwizops://...` deep-links — every tap silently launched the staff app if installed, otherwise dropped on the floor. Now `_layout.tsx`'s new handler prefers an explicit `deep_link` payload field (always `clovrbid://...` after this PR) and passes it to `Linking.openURL`.

**`notifications-drain.ts` widening.** The original type union covered 8 of 18 enum members. `payment_failed`, `payment_retry_reminder`, `dispute_opened`, `dispute_evidence_due`, `lot_relisted_no_show`, `relot_fee_applied`, `pickup_no_show_forfeit`, `pickup_no_show_refund_pending`, `refund_completed`, `refund_failed` had no case — `buildMessage`'s `switch` fell through to a "no message composed" path (TypeScript exhaustiveness was the only guard, runtime silently dropped). The widened union + `default` arm means no kind is ever dropped silently. Migrations 0077 / 0124 / 0158 / 0159 already shipped the enum values; PR-D wires them up.

**Multi-lot rollup.** `ROLLUP_KINDS` allow-list: `won`, `pickup_ready`, `saved_search_hit`, `relot_fee_applied`, `pickup_no_show_forfeit`, `pickup_no_show_refund_pending`, `lot_relisted_no_show`. 15s grace window so rows enqueued in the same `close_auction` RPC have time to land. Grouping by `(target_user_id, kind, group_key)` where `group_key` = `auction_id` / `saved_search_id` / `invoice_id`. `buildRollupMessage` composes a single push per group; `won` and the refund-pending kinds sum cents when payloads carry them. Singleton kinds (`outbid`, `closing_soon`, `payment_*`, `dispute_*`) bypass the grace entirely.

**"$5" hardcode → policy read.** `grace-expiry.ts` now batch-loads `operator_policies.relist_fee_cents` for every operator in the batch and bakes the actual fee into the push body. Matches the `apply_relot_fee` SQL function's policy-read fallback added in mig 0158 — DB and push body agree on the amount.

**"Tap to pay" → "We auto-charged your card."** PR-A2's auto-charge fires automatically at lot close, so the bidder never taps to pay. The next real action is the pickup window. Copy now reflects post-A2 reality.

**`verify-card.tsx`.** SCA recovery screen for `payment_requires_action` push taps. Uses `usePaymentSheet` (already linked via `@stripe/stripe-react-native`), loads invoice via existing bidder session (RLS), inits PaymentSheet with `paymentIntentClientSecret = authentication_client_secret`, presents sheet, POSTs to `/api/bidder/payment-intent/[id]/confirm-action` to clear the auth flag. No new native modules, no resolver endpoint, no one-time token — audit decision §4 line 344-350.

## Rollout sequence

1. ✅ PR opened; CI green
2. ✅ Squash-merge to master
3. ✅ OTA dispatch — `EAS Update (OTA)` workflow, `app=bidder`, `branches=both` (`preview` + `production` per memory `feedback_ota_both_branches.md`)
4. Verify: send a test `payment_requires_action` push (or any `won` push to a TestFlight bidder) — tap should land on the right screen via `clovrbid://...` deep-link.

## Out of scope (deferred)

- Cold-install token resolver endpoint for SCA pushes — audit defers; current design assumes bidder is already signed in when push arrives (true for any device that opted into push at all).
- Sentry observability adapter for the `default` arm — current implementation `console.warn`s the unknown kind. Add when re-enabling `@sentry/react-native` per `auction_platform_ios26_launch_crash.md`.
- Universal-Link asset-links update — clovrbid.com associations already pinned; PR-D didn't touch them.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| `default` switch arm masks a producer bug | `console.warn` surfaces the offending kind in CF Worker logs; safety net is intentional. |
| 15s rollup grace adds latency to `won` | Grace is well below the "missed it" threshold; the drain already runs every 60s so the worst-case latency was already 60s. |
| Rollup composer for an unrecognized kind | Falls through to `buildMessage(rows[0], ...)` then marks all source rows processed — no silent drop. |
| `expo-linking` not yet imported in `_layout.tsx` | Confirmed dep at `apps/bidder-app/package.json:37` (`expo-linking ~8.0.12`). |
| `verify-card.tsx` uses design-system tokens that don't exist | Verified all `colors.*` and `type.*` references against `packages/design-system/src/theme.ts`. |

## Verification commands

```powershell
cd C:\Users\jmacl\Projects\auction-platform
# After merge — confirm OTA reached both channels:
gh run watch <ota-run-id>
node scripts/verify-eas-update.mjs --app bidder --branches preview,production
```
