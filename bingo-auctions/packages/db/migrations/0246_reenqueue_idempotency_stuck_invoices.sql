-- migration 0246 — re-enqueue invoices stranded by the IDEMPOTENCY_KEY_REUSED bug
--
-- Incident 2026-07-08 (launch weekend): the auto-charge worker built the Square
-- idempotency key as `sq:inv:<invoiceId>` — fixed per invoice, never varying by
-- attempt. When a charge was retried with any change to the request (a
-- later-closing lot changed the amount, or store credit was applied), Square
-- rejected the second attempt with IDEMPOTENCY_KEY_REUSED and the worker flipped
-- the invoice to payment_failed_grace — sometimes AFTER the card had already been
-- charged on the first attempt. Result: customers charged-but-shown-unpaid and
-- blocked from bidding (place_bid §C blocks on a grace invoice at the operator).
--
-- The code fix (per-attempt idempotency key + reconcile-before-charge that reads
-- Square and marks paid when a COMPLETED payment already exists) ships alongside
-- this. This migration re-enqueues an auto_charge_jobs row for each stranded
-- invoice so the now-fixed worker picks it up on the next tick and either:
--   • reconciles it to paid (card was already charged — no double charge), or
--   • charges it cleanly with a fresh per-attempt key (card was never charged).
--
-- Scope: ONLY invoices flipped to grace by our bug (last_auto_charge_error =
-- 'IDEMPOTENCY_KEY_REUSED'). Genuine declines (INSUFFICIENT_FUNDS,
-- TRANSACTION_LIMIT, GENERIC_DECLINE, …) are left alone — those customers really
-- do need to fix their card, and the per-attempt-key fix lets their own retry
-- work now. Idempotent: ON CONFLICT just re-arms next_attempt_at.

BEGIN;

INSERT INTO auto_charge_jobs (invoice_id, bidder_id, attempt_count, next_attempt_at, last_error)
SELECT i.id, i.bidder_id, COALESCE(i.auto_charge_attempt_count, 0), now(), i.last_auto_charge_error
FROM invoices i
WHERE i.status = 'payment_failed_grace'
  AND i.last_auto_charge_error = 'IDEMPOTENCY_KEY_REUSED'
ON CONFLICT (invoice_id) DO UPDATE
  SET next_attempt_at = now();

COMMIT;
