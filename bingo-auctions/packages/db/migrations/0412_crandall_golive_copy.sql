-- ============================================================================
-- Migration 0412 — Crandall go-live copy (data only)
--
-- Braden, 2026-10-13: Crandall pickup is Sat + Sun 12:00–16:00, staff on-site.
-- Merges the console-entered text (which had the "above Cause for Paws"
-- landmark) with the go-live dates and forfeit line. Replaces:
--   pickup_hours        Sat+Sun 09:00–16:00 placeholder (0411) → 12:00–16:00
--   pickup_instructions console text (said self-service / no staff — WRONG)
--   customer_notice     console text (no dates, no forfeit line)
-- Rollback (scripts/prod-rig/0412_ROLLBACK_…) restores the exact previous text.
-- Row: a6cc2d66-f6ba-4923-acb1-81fd3855ea06 (Crandall, mig 0411). Skips cleanly
-- where that row doesn't exist (CI / dev), like 0403 / 0411. Re-running is a
-- no-op beyond updated_at.
-- ============================================================================

BEGIN;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.warehouses WHERE id = 'a6cc2d66-f6ba-4923-acb1-81fd3855ea06') THEN
    RAISE NOTICE 'Crandall warehouse not here, skipping';
    RETURN;
  END IF;
  UPDATE public.warehouses
     SET pickup_hours        = $h${"sat":[{"open":"12:00","close":"16:00"}],"sun":[{"open":"12:00","close":"16:00"}]}$h$::jsonb,
         pickup_instructions = $i$Bring your invoice or pickup QR. Pickup at 119 East Crandall Avenue (above Cause for Paws) only — not the main warehouse. Staff on-site to check you out. Bring help and equipment for loading.$i$,
         customer_notice     = $n$SPECIAL OFF-SITE AUCTION — Pickup at 119 East Crandall Avenue, Harrison, AR 72601 (above Cause for Paws). Pickup Saturday Oct 17 and Sunday Oct 18, 12–4 PM only. Items not picked up by Sunday 4 PM are forfeited.$n$,
         updated_at          = now()
   WHERE id = 'a6cc2d66-f6ba-4923-acb1-81fd3855ea06';
END
$do$;

COMMIT;
