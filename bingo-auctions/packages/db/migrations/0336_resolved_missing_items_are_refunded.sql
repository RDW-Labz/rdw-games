-- 0336 — stamp lines whose missing-item refund was already processed.
--
-- Reported 2026-08-27 with a photo: "Breakroom Table PNK4996413 — MISSING ·
-- refund queued" still listed as an item to hand over, on a visit whose
-- missing-item queue row had been resolved on 2026-07-08.
--
-- The missing-item flow has two halves and they were never joined up:
--   1. counter marks the lot missing  -> pickup_lot_outcomes(outcome='missing')
--   2. office refunds, then clicks "Mark resolved" -> resolved_at set
--
-- Step 2 only wrote resolved_at. Nothing stamped invoice_lots.refunded_at, and
-- that column is what the counter screen reads to decide a line is no longer
-- owed. Only the refund-ITEMS route writes it; refunding an amount from the
-- invoice page -- the natural thing to do for a missing item -- does not. So
-- the item came back as available for pickup on every subsequent visit.
--
-- resolveMissingItem() now stamps the line as part of resolving. This backfills
-- the 8 lines already resolved. refunded_at is set to the moment the office
-- resolved the row, not now(), so the timeline stays truthful.

UPDATE invoice_lots il
   SET refunded_at = o.resolved_at
  FROM pickup_lot_outcomes o
  JOIN pickups p ON p.id = o.pickup_id
 WHERE il.invoice_id = p.invoice_id
   AND il.lot_id = o.lot_id
   AND o.outcome = 'missing'
   AND o.resolved_at IS NOT NULL
   AND il.refunded_at IS NULL;
