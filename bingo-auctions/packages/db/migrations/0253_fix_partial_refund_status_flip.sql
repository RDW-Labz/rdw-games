-- migration 0253 — repair invoices wrongly flipped to fully-refunded
--
-- Incident (Murry Bryant, 2026-07-09): the Square webhook's refund handler
-- set status='refunded' on ANY completed refund regardless of amount, so a
-- PARTIAL per-item refund (refund-items route, which stamps
-- invoice_lots.refunded_at on just the refunded lines) flipped the whole
-- invoice to fully-refunded once Square confirmed. The customer's remaining
-- PAID items then dropped off pickup (0245's staff-scan/pass mirror skips
-- refunded invoices).
--
-- Repair scope: invoices in status='refunded' that show the per-item partial
-- pattern — at least one line refunded AND at least one line NOT refunded.
-- Those cannot be true full refunds (a full refund refunds every line or
-- none via the dashboard custom-amount path, which stamps no lines at all
-- and is indistinguishable from a legit full refund — left untouched).
--
-- The webhook code fix ships in the same PR; this migration fixes the rows
-- the old code already damaged. Idempotent.

BEGIN;

UPDATE invoices i
SET status = 'partially_refunded',
    updated_at = now()
WHERE i.status = 'refunded'
  AND EXISTS (
    SELECT 1 FROM invoice_lots il
    WHERE il.invoice_id = i.id AND il.refunded_at IS NOT NULL
  )
  AND EXISTS (
    SELECT 1 FROM invoice_lots il
    WHERE il.invoice_id = i.id AND il.refunded_at IS NULL
  );

COMMIT;
