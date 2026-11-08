# PATCH — PR-C: Staff Item-Level Refund + refund_jobs Worker (2026-05-29)

Fourth PR in the 2026-05-29 policy batch (PR-A1 schema → PR-A2 server wiring → PR-B bidder visibility → **PR-C staff refund + Stripe worker**). Closes the gap left by mig 0158: when `no_show_policy='refund_minus_restock'` the cron now inserts a `refund_jobs` row, and a new Node worker issues the actual Stripe refund. Also adds staff-initiated per-lot partial refunds.

## What shipped

PR #TBD — branch `feat/staff-refund-flow-prc` off `851f35d`.

### Database (mig 0159)

| Surface | Change |
|---|---|
| `notification_kind` enum | + `refund_completed`, `refund_failed` |
| `refund_reason` enum (new) | `no_show_refund_minus_restock`, `admin_partial_refund`, `admin_full_refund`, `defective_item`, `wrong_item`, `damaged_in_transit`, `other` |
| `refund_jobs` table (new) | queue with status (pending/processing/succeeded/failed), attempts, last_error, stripe_refund_id, locked_at/locked_by, idempotency via unique partial index on `(invoice_id) WHERE reason='no_show_refund_minus_restock' AND status IN (pending/processing/succeeded)` |
| RLS | operator admin+manager SELECT only; service-role + SECURITY DEFINER writes |
| `claim_refund_job(p_worker_id TEXT, p_limit INT DEFAULT 10)` RPC (new) | atomic `FOR UPDATE SKIP LOCKED` claim + attempts bump; stale-lock recovery >5min |
| `auto_mark_pickup_no_show()` CREATE OR REPLACE | Body from mig 0158 preserved verbatim + NEW Step 3c CTE enqueues refund_jobs rows for `refund_minus_restock` policy (amount = `total_cents - restock_fee_cents`, bounded > 0) |

### Server (operator-web)

| File | Change |
|---|---|
| `lib/refund-math.ts` (NEW) | Pure functions: `computeLotFullRefundableCents(invoice, winningBid)`, `computeOperatorRefundPortion(invoice, stripeRefundedAmount)`. Shared by both refund routes. |
| `api/invoices/[id]/refund/route.ts` | Refactor: inlined math (lines 176-184) → `computeOperatorRefundPortion` import. Behavior byte-identical. |
| `api/invoices/[id]/refund-items/route.ts` (NEW) | Staff per-lot refund API. Validates auth + role (admin/manager) + AAL2 + invoice status + pickup completed_at/checked_in_at + refund window vs operator_policies + super-admin override (`jmacluer@gmail.com`) + per-lot cap via shared math. Inserts N×`refund_jobs` + N×`operator_audit_log` (`refund.items_requested`). Returns 202 with `{job_ids}`. |
| `lib/cron/refund-jobs-drain.ts` (NEW) | Worker. `claim_refund_job` RPC → batch invoice fetch → `stripe.refunds.create({reverse_transfer:true, refund_application_fee:true})` with `idempotencyKey:refund-job:<id>`. On success: status='succeeded' + stripe_refund_id + operator_audit_log (`refund.items_issued` or `refund.no_show_minus_restock_issued`) + notifications_outbox (`refund_completed`). On transient (`StripeConnectionError`/`StripeAPIError`, attempts<5): revert to pending. On terminal: status='failed' + last_error + notifications_outbox (`refund_failed`) + Sentry.captureException. **Gated by `REFUND_WORKER_ENABLED=true`** (default OFF). |
| `api/cron/refund-jobs-drain/route.ts` (NEW) | POST handler with `checkCronSecret` + `runRefundJobsDrain`. Pattern matches auto-charge-drain route. |
| `apps/cron-trigger/src/index.ts` | Added `/api/cron/refund-jobs-drain` to the `* * * * *` schedule. |

### UI

| File | Change |
|---|---|
| `apps/field-mobile/components/RefundItemsSheet.tsx` (NEW) | Self-fetching staff sheet. Props: `{invoiceId, bidderName, operatorId, lots[], onClose}`. Internally fetches invoice money + operator_policies + pickup via existing `supabase` client. Renders window status, **destination-charge Connect-balance gotcha banner**, per-lot checkboxes with editable amounts capped at `computeLotFullRefundableCents`, sub-reason chips, optional note. POSTs to `/api/invoices/[id]/refund-items`. |
| `apps/field-mobile/app/(staff)/checkout/pickup-verify.tsx` | Added "Refund items (defective / wrong / damaged)" button in `step==='done'` block (after existing photo-capture button); mounts the sheet conditionally. |
| `apps/operator-web/src/app/(operator)/invoices/[id]/RefundJobsTable.tsx` (NEW) | Server Component table of `refund_jobs` for this invoice. Shows lot, amount, reason, status badge, attempts, created/processed timestamps, stripe_refund_id / last_error. Returns `null` if no rows. |
| `apps/operator-web/src/app/(operator)/invoices/[id]/page.tsx` | Added `<RefundJobsTable invoiceId={invoice.id}/>` below existing `<RefundButton>`. |

## Apply order (rollout)

Per audit §9 — staged rollout with the worker env-gated OFF:

1. **Merge PR** → code deploys to staging + prod with `REFUND_WORKER_ENABLED=false` (default). Worker returns early; queue dormant.
2. **Apply mig 0159 to staging.** Smoke-test by manually flipping a synthetic pickup to no_show → confirm `refund_jobs` row appears with `status='pending'`. Worker stays disabled.
3. **Flip `REFUND_WORKER_ENABLED=true` on staging** (`wrangler secret put REFUND_WORKER_ENABLED --env staging`, value `true`). Watch worker process the test row, verify the Stripe refund landed in test mode, confirm `refund_completed` notification fires.
4. **Apply mig 0159 to prod** (worker still off via env). 24-hour shadow mode — queue accumulates rows, no Stripe calls.
5. **Flip `REFUND_WORKER_ENABLED=true` on prod.** Monitor Sentry + the operator-web `RefundJobsTable` dashboard for the first 48 hours.
6. **Optional cleanup commit** to drop the env gate once the worker is proven.

## What this enables

1. **Closes the refund_minus_restock gap.** Mig 0158 inserted a notification but never refunded. PR-C makes the bidder actually whole (minus the restock fee per operator policy).
2. **Per-lot staff refunds.** Counter-staff can refund a single defective lot from a 5-lot pickup without zeroing the whole invoice. Captures sub-reason + free-text note for the audit log.
3. **Audit trail.** Three `operator_audit_log` entries per refund lifecycle: `refund.items_requested` (staff POST), `refund.items_issued`/`refund.no_show_minus_restock_issued` (worker success), `refund.failed` (terminal failure).
4. **Idempotency guarantees.** Stripe idempotencyKey `refund-job:<id>` + unique partial index on `(invoice_id, reason='no_show_refund_minus_restock')` prevent double-refunds across cron ticks and worker retries.
5. **Operator visibility.** New `RefundJobsTable` on the invoice detail page shows queue status, attempts, last_error so the operator can spot stuck/failed refunds.

## Risks surfaced

- **Destination-charge negative balance.** `reverse_transfer:true` pulls the operator's share back from their Connect balance. If payouts have already cleared, this can create a temporary negative balance Stripe will recover from the next payout. The staff sheet shows a yellow warning banner before submit. Worker does NOT auto-retry on `insufficient_funds` — flips to `failed` immediately and surfaces via Sentry.
- **Refund window enforcement.** Server is authoritative (`refund_window_post_pickup_hours` + `admin_can_refund_outside_window` + super-admin email `jmacluer@gmail.com`). Sheet shows window status as guidance only.
- **PR-D dependency for full bidder UX.** The `refund_completed` / `refund_failed` notification kinds added by PR-C will be ROUTED through the bidder push pipeline by PR-D (along with the 3 no_show kinds from PR-A2). Until PR-D lands, these push notifications still go out via the existing drain — body composition just falls back to `payload.title` / `payload.body` we set in this worker.

## Out of scope (deferred)

- Retry-failed-refund button in operator-web (a failed `no_show_refund_minus_restock` job currently can't be re-enqueued by the cron because the 5-minute updated_at filter elapses).
- Consolidating `/api/invoices/[id]/refund` (sync) into `refund_jobs` (async). Synchronous path keeps working for in-window admin refunds.
- Per-line tax reconciliation when Stripe Tax computed a different breakdown.
- Bidder-app "refund history" screen.
- Email receipts for refunds.

## References

- Audit blueprint: `docs/audits/prc-staff-refund-flow-2026-05-29.md`
- Schema: `packages/db/migrations/0159_refund_jobs.sql`
- Prior PRs: PR-A1 (mig 0157), PR-A2 (mig 0158), PR-B (PR #125 `851f35d`)
- Money-flow audit (gap source): `docs/audits/money-flow-audit-2026-05-29.md` §7
