-- 0303 — BACKFILL: lots left "pending_intake" but holding a shelf location
--
-- Data repair for the defect fixed in mig 0302. `audit_relocate_lot` (0248)
-- wrote `intake_bin_id` on its own, so every lot corrected via the Bin Audit
-- "Move here" button while still un-put-away was stranded:
--
--     status = 'pending_intake'  AND  intake_bin_id IS NOT NULL
--     AND warehouse_id IS NULL   AND  intake_at IS NULL
--
-- 84 lots on prod carried that fingerprint when this was written (2026-07-30),
-- spanning 48 bins and first appearing 2026-07-15 — the most recent was minted
-- the same day the fix landed. Every other lot status had warehouse_id
-- populated, so the pattern is unambiguous and the match is exact.
--
-- These items are physically on the shelf: staff scanned each one IN the bin
-- during a bin audit, which is the only way to reach "Move here". Completing
-- the intake is therefore a correction to match reality, not an assumption —
-- it is exactly what re-running Put Away by hand does (verified on lot
-- BIN-001300 / sticker BIN:BRN4982038 on 2026-07-29).
--
-- `intake_at` is set to the lot's `updated_at` — the moment the relocate wrote
-- the bin, i.e. the best available record of when the item was confirmed on the
-- shelf — rather than now(), so age-in-inventory reporting stays truthful.
--
-- The `lots_status_history` trigger logs each pending_intake -> in_inventory
-- transition with changed_by = NULL, which correctly reads as a system repair
-- rather than a staff action.
--
-- Safety: scoped by the exact fingerprint, so it is idempotent (a second run
-- matches nothing) and cannot touch a lot that legitimately awaits intake (no
-- bin) or one already in inventory. Verified before writing: none of the 84
-- rows has an auction_id, all bins resolve to one warehouse, and every bin's
-- warehouse belongs to the lot's operator — so neither
-- `check_lot_auction_warehouse` nor the operator scoping is violated.

BEGIN;

UPDATE public.lots l
   SET status       = 'in_inventory',
       warehouse_id = b.warehouse_id,
       intake_at    = COALESCE(l.updated_at, now()),
       updated_at   = now()
  FROM public.bins b
 WHERE b.id = l.intake_bin_id
   AND l.status = 'pending_intake'
   AND l.warehouse_id IS NULL
   AND l.intake_at IS NULL;

COMMIT;
