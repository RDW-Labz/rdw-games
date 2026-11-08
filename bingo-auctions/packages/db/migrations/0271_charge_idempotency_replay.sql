-- 0271 — charge idempotency replay (make auto-charge double-charge impossible)
--
-- Owner, 2026-07-16. Money audit found a real double-charge path in the
-- auto-charge drain: the Square idempotency key is per-ATTEMPT
-- (inv:{id}:{attempt}) so a retry uses a NEW key and Square will charge again.
-- The only guard was reconcile-before-charge, whose fallback
-- findCompletedPaymentForInvoice() scans location-wide ListPayments capped at
-- 1000 rows — on the shared Bingo retail location a prior (timed-out-but-
-- captured) payment can fall outside that window and be charged a second time.
--
-- Fix (Approach A): persist the EXACT params of each CreatePayment attempt
-- before the network call, and on the next retry REPLAY that idempotency key.
-- Square then returns the prior payment if one was ever created (recovering a
-- timed-out success with no scan) or performs the single intended charge —
-- reusing the key makes a double charge impossible by construction. A genuinely
-- FAILED prior comes back FAILED and the drain escalates to a fresh key, so
-- card-update and same-card-funded retries still work.
--
--   invoices.last_charge_attempt jsonb  { key, amount_cents, card_id } — written
--                                       immediately BEFORE chargeCardOnFile;
--                                       cleared (NULL) once the invoice is paid.
--
-- Additive + nullable; safe to deploy ahead of the code. No backfill.

BEGIN;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS last_charge_attempt jsonb;

COMMENT ON COLUMN public.invoices.last_charge_attempt IS
  '0271: { key, amount_cents, card_id } of the last CreatePayment attempt, persisted before the Square call so a retry replays the exact idempotency key (recover prior payment or charge once) — prevents double-charge. NULL once paid.';

COMMIT;
