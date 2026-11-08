-- ============================================================================
-- Migration 0197 — auto-enqueue image enrichment for photo-less lots
--
-- GAP (Quick Lot plan A1): create_draft_lot / createDraftLotFromCandidate mints a
-- lot but NOTHING ever enqueues an image_enrichment_jobs row for it. A lot created
-- from a UPC/ASIN scan that carries an identifier but no stock photo stays
-- "No photos yet" forever, even though the enrichment drain could resolve an image
-- from its identifier. Only commitImport() (the manifest path) enqueues today, and
-- only for import_rows — never for lots.
--
-- WHY A TRIGGER (not the mobile enrich() thunk the plan first proposed):
-- image_enrichment_jobs is RLS service-role-only (mig 0162 — zero policies), so an
-- operator JWT (the mobile / SSR client that runs enrich()) gets permission-denied
-- on INSERT. A SECURITY DEFINER AFTER INSERT trigger:
--   • enqueues atomically with lot creation (no extra round-trip, no lost job if the
--     app backgrounds before a fire-and-forget thunk runs),
--   • bypasses RLS safely (definer owns the table),
--   • covers EVERY lot-creation path (mobile Quick Lot, web Quick Lot, manual
--     listing, lot_from_manifest) with ZERO app/OTA change,
--   • leaves the critical create_draft_lot RPC untouched (no blast radius).
--
-- GATE: only enqueue when the NEW lot has NO usable photo AND carries an identifier
-- the drain can act on (asin / upc / external_code / fnsku / lpn). Lots that already
-- have a photo, or have no identifier, get no job (the drain would only skip them).
-- The photo check uses array_length(...) IS NULL because the lots_filter_photo_urls
-- BEFORE trigger normalises photo-less lots to the empty array '{}' (NOT null) — a
-- prod check on 2026-06-08 found 435 photo-less lots, ALL '{}', zero NULL.
--
-- Ordering note: lots_filter_photo_urls is BEFORE INSERT, so by the time this AFTER
-- trigger reads NEW.photo_urls it reflects the final, placeholder-stripped value.
--
-- BEST-EFFORT: the INSERT is wrapped in a nested EXCEPTION block so an enqueue
-- failure can NEVER roll back the lot insert. Idempotent via the existing
-- UNIQUE (target_table, target_id) on image_enrichment_jobs.
--
-- CONSUMER PRE-REQ: the image-enrichment-drain must already handle target_table
-- 'lots' by reading/writing lots.photo_urls[] (NOT the scalar photo_url it uses for
-- import_rows). That drain fix ships in the same PR and MUST be deployed to the
-- Cloudflare Worker BEFORE this migration is applied — otherwise the old drain
-- SELECTs a non-existent lots.photo_url column (400) and wrongly marks every lot
-- job 'target_row_not_found'.
-- ============================================================================

CREATE OR REPLACE FUNCTION enqueue_lot_image_enrichment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.photo_urls IS NULL OR array_length(NEW.photo_urls, 1) IS NULL)
     AND (
       COALESCE(NEW.asin, '') <> '' OR
       COALESCE(NEW.upc, '') <> '' OR
       COALESCE(NEW.external_code, '') <> '' OR
       COALESCE(NEW.fnsku, '') <> '' OR
       COALESCE(NEW.lpn, '') <> ''
     )
  THEN
    BEGIN
      INSERT INTO image_enrichment_jobs (operator_id, target_table, target_id, status)
      VALUES (NEW.operator_id, 'lots', NEW.id, 'pending')
      ON CONFLICT (target_table, target_id) DO NOTHING;
    EXCEPTION WHEN OTHERS THEN
      -- Enrichment enqueue is best-effort; it must NEVER break lot creation.
      NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_lot_image_enrichment ON lots;
CREATE TRIGGER trg_enqueue_lot_image_enrichment
  AFTER INSERT ON lots
  FOR EACH ROW
  EXECUTE FUNCTION enqueue_lot_image_enrichment();

-- ── Verification ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_enqueue_lot_image_enrichment'
      AND tgrelid = 'public.lots'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0197 verification failed: trg_enqueue_lot_image_enrichment not installed on lots';
  END IF;
  RAISE NOTICE '0197 verified: trg_enqueue_lot_image_enrichment installed on lots (photo-less + identified -> image_enrichment_jobs)';
END $$;
