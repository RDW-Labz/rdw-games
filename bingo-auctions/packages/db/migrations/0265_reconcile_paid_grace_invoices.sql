-- migration 0265 — reconcile invoices stuck in payment_failed_grace WITH paid_at
--
-- 2026-07-14. Root cause fixed forward in #191 (flipInvoiceToGrace now guards
-- .neq status paid/refunded), but rows already corrupted before that deploy
-- remain. A prod count (2026-07-14) found exactly 2 such invoices, and BOTH
-- carry a square_payment_id — i.e. the customer's card WAS charged, yet the
-- invoice reads payment_failed_grace. Two consequences for those real,
-- paid customers:
--   1. They're shown as owing money they already paid.
--   2. place_bid (mig 0263 §C) BLOCKS any bidder with a payment_failed_grace
--      invoice at that operator — so a paid customer cannot bid until this runs.
--
-- Fix: for grace rows that have BOTH paid_at and square_payment_id (a real
-- Square capture on file), set status='paid' and clear the grace bookkeeping.
-- Scoped tightly so it can only ever touch money-confirmed rows; offline
-- artifacts (square_payment_id IS NULL) are intentionally left untouched (the
-- prod count found zero of those).

BEGIN;

UPDATE invoices
SET status = 'paid',
    grace_until = NULL,
    last_auto_charge_error = NULL
WHERE status = 'payment_failed_grace'
  AND paid_at IS NOT NULL
  AND square_payment_id IS NOT NULL;

COMMIT;
