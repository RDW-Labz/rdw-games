# Auction + Lot Audit Plan

**Created**: 2026-05-20 (evening)
**Source**: 3 parallel agent audits (auction-creation UX, lot-listing+intake UX, architecture/data-model)
**Status**: planning complete; launch-critical fixes execute tonight, structural changes defer post-Bingo

---

## Headline findings

### The two biggest gaps

1. **`auctions.status` never transitions** (BUG-ARCH-01/02): nothing in the codebase ever flips an auction from `scheduled→live` or `live→closed`. Lots close individually via pg_cron, invoices get built, payments process — and the auction record stays `live` forever. Affects analytics, "past auctions" filters, "closing soon" detection, and the `editAuction` lock (which currently works *only because* nothing ever clears it).

2. **Zero structured audit trail** (BUG-ARCH-04): `bid_records` is the only immutable history. Every other state transition is a destructive UPDATE. No `lot_status_history`, `auction_status_history`, `invoice_status_history`. First chargeback dispute or state-AG inquiry that wants "who canceled this and when" — there's no answer.

### Security holes (defense-in-depth gone)

- **BUG-AC-01** P0: `cancelAuction`, `scheduleAuction`, `editAuction` don't verify operator ownership on the auction. Rely entirely on RLS at the DB layer — single point of failure.
- **BUG-AC-02** P0: `cloneAuction` reads the source auction without checking the caller owns it, then writes `operator_id: src.operator_id` into the new auction (effectively passing data from one tenant to another, even if RLS blocks the cross-tenant write).
- **BUG-AC-03** P1: `listWarehouses` in `auctions/new/actions.ts` has no auth check at all.

### Money math drift

- **BUG-ARCH-07**: `application_fee_cents` computed at invoice build time AND overwritten at PaymentIntent creation with different formula. Bracket-straddling timing race possible.
- **BUG-ARCH-08**: `tax_cents` is never written (Stripe Tax adds tax on top via Connect MOR, but our invoice row keeps tax at 0). Refund math reads the wrong total.

### State machine

- **BUG-ARCH-09** HIGH: Canceled auctions with live lots can still auto-finalize and create invoices.
- **BUG-ARCH-06** HIGH: `relistLot` doesn't enforce source-lot precondition (can relist a won/paid lot, breaking invoice audit story).
- **BUG-ARCH-14** MEDIUM: `editLot` allows title/description edits on won lots — fraud risk (operator could swap "iPad Pro 12.9" to "iPad Pro 11" post-close).
- **BUG-LL-02** P1: CSV import races on `lot_number` — duplicate numbers possible under concurrent imports.
- **BUG-LL-04** P1: `relistLot` doesn't mint a new `lot_code` — relisted lots are broken in the intake scanner and label printer.

### UX friction

- **BUG-AC-06** P1: After creating a new auction, redirect goes to `/auctions` list not `/auctions/[id]` detail. One-line fix, high impact.
- **BUG-AC-07** P2: "Add lot manually" button visible on `live` / `closed` auctions with no `canEdit` guard.
- **BUG-AC-04** P1: Manual lot creation via `/lots/new` hardcodes `close_at = auction.ends_at` for ALL lots — manually-added lots get the first lot's close time regardless of `lot_number`. No redistribute prompt after.
- **BUG-LL-08** P2: Picker app's lot-scan step uses `QR_ONLY` code types — fails on Code128 labels (common Zebra ZPL output).
- **No bulk operations**: pricing 60 manifest items requires 60 individual edits. Bulk-assign-to-auction is missing entirely.
- **CSV import errors swallowed**: "58 imported, 2 skipped" — never shows the 2 reasons.
- **Two parallel import systems** (`/lots/import` vs `/lotting/manifest-pool`) with no guidance.
- **`/lots/new` is a dead end without an existing auction** (mandatory dropdown, no empty state).

---

## Bingo launch-blocker subset (fix tonight)

These are the items that genuinely affect Bingo's day-1 operations or expose real risk before the first paid invoice:

### Operator-web fixes
- [ ] **BUG-AC-06** — redirect to `/auctions/[id]` after create (one-line)
- [ ] **BUG-AC-01/02/03** — defense-in-depth operator scope guards on `cancelAuction`, `scheduleAuction`, `editAuction`, `cloneAuction`, `listWarehouses`
- [ ] **BUG-AC-07** — `canEdit` guard on "Add lot manually" button
- [ ] **BUG-AC-04** — when adding a manual lot to a windowed-close auction, refuse OR auto-redistribute close times
- [ ] **BUG-LL-04** — `relistLot` mints a fresh `lot_code` via `next_lot_code` RPC
- [ ] **BUG-LL-02** — `importLotsCsv` lot_number assignment moved server-side / atomic (or add UNIQUE constraint)
- [ ] **BUG-LL-08** — picker app uses `ALL_RETAIL_CODE_TYPES` for lot label scan
- [ ] **BUG-LL-06** — `PhotoEditor` client-side guard on 20-photo limit before upload
- [ ] **BUG-LL-07** — pagination warning when inventory hits 500 cap

### Migration 0096 — auction lifecycle completeness
- [ ] `auctions.closed_at`, `auctions.canceled_at`, `auctions.canceled_by`
- [ ] `lots.canceled_at`, `lots.canceled_by`
- [ ] New SECURITY DEFINER function `advance_auction_lifecycle()` running every 60s in pg_cron:
  - `scheduled → live` when current ts ≥ starts_at and ≥1 lot is live (or any lot transitions to live)
  - `live → closed` when every child lot is in a terminal state and ≥1 lot has actually closed
  - Sets `closed_at`
- [ ] New SECURITY DEFINER RPC `cancel_auction(auction_id, reason)`:
  - Refuses if any lot has `bid_count > 0` OR status is `live`
  - Atomically flips auction + all child lots to `canceled`
  - Captures `canceled_by = auth.uid()`, `canceled_at = now()`
- [ ] Update `cancelAuction` server action to call the new RPC

---

## Defer to post-Bingo

These need substantial work and don't affect day-1 launch correctness:

### Migration 0097 — audit trail
Tables: `lot_status_history`, `auction_status_history`, `invoice_status_history`. AFTER UPDATE triggers. RLS scoped to owner. ~200 lines SQL.

### Migration 0098 — money math single-source-of-truth
- Stripe canonical, Supabase projection
- `application_fee_cents` revoke-write from app code, only webhook writes
- `tax_cents` populated from `pi.amount_received` minus subtotal
- `total_cents` becomes a generated column
- Bigger lift; do not attempt before launch

### Migration 0099 — lot/auction warehouse integrity + relist lineage
- Trigger enforcing `lots.warehouse_id == auctions.warehouse_id`
- `lots.relisted_from_lot_id` instead of destructive flip in `relistLot`

### Migration 0100 — webhook idempotency correctness
- `processed_webhook_events.processed_at NULL` until handler succeeds
- Replace `INSERT...ON CONFLICT` with claim-then-commit pattern

### UX redesigns
- **Auction launch hub** pattern (BUG-AC-02): single page on `/auctions/[id]` with persistent checklist showing required vs optional steps. Eliminates the 10-step fragmented flow.
- **Unified lot pipeline view**: status-column swimlanes across `manifest-pool → drafts → inventory → in-auction → won/unsold`. Currently 5 separate pages.
- **Bulk operations**: select-N inventory lots + assign-to-auction, bulk price edit, bulk publish.
- **Deprecate `/lots/import`** in favor of `/lotting/manifest-pool` as the single canonical CSV path.
- **Show CSV import errors per-row** instead of just the skipped count.

### Architectural (multi-week)
- Event-sourced lifecycle (`entity_events` table) replacing status enum columns
- Bid + close engine extracted into `packages/auction-engine` with property-based tests
- Stripe as canonical money store

---

## Open questions for the user

1. **Is `/lots/import` actually used today**, or is it legacy scaffolding? If unused, deprecate now — kills BUG-LL-02 and the dual-import-system confusion in one stroke.
2. **What thermal label format are you printing?** QR or Code128? Determines whether BUG-LL-08 (scanner code types) is a P0 day-1 or a deferrable polish.
3. **Are "Dutch" and "Last Chance" auction formats functional**, or just exposed in the dropdown? If non-functional they're a launch trap.
4. **Do you want post-close `condition` edits allowed** on won lots? (BUG-ARCH-14) Operators may want to mark "actually was Good not Open Box" after pickup feedback.
5. **What's the auction-engine downtime tolerance?** pg_cron is the heart of the lifecycle. Worth adding the stuck-job dashboard now or post-launch?

---

## Tonight's execution order

1. AC-06 redirect (trivial)
2. AC-07 canEdit guard (trivial)
3. AC-01/02/03 operator scope guards (medium — 4 actions to harden)
4. LL-04 relistLot lot_code mint (small)
5. LL-08 scanner code types (small)
6. LL-06 photo limit guard (small)
7. Migration 0096 — auction lifecycle (medium — new SQL, RPC, cron schedule)
8. Update `cancelAuction` to call new RPC
9. AC-04 manual-lot-create close_at fix (small)
10. Typecheck, lint, push, GHA validate

Skipping LL-02 (CSV race) for tonight — defer with a code comment noting the gap. Concurrent imports are unlikely with Bingo's single-operator team.

---

## Reference

- Full UX-operator-auction agent report: ran 2026-05-20 evening; output captured in conversation transcript
- Full UX-operator-lot-listing agent report: ran 2026-05-20 evening
- Full architect agent report: ran 2026-05-20 evening
- Companion to `docs/warehouse-redesign-plan.md` (prior audit, similar style)
