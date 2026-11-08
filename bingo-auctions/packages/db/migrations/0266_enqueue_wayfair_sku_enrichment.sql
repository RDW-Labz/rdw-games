-- ============================================================================
-- Migration 0266 — enqueue image enrichment for Wayfair-SKU lots too
--
-- GAP: the 0197 AFTER-INSERT trigger only enqueues a photo-less lot for image
-- enrichment when it carries asin / upc / external_code / fnsku / lpn. Wayfair
-- D2L returns almost never have a UPC (the manifest's UPC is usually blank —
-- see apps/.../lotting/quick.tsx candidateFromManifestRow), so a photo-less
-- Wayfair QuickLot with ONLY a SiteSKU/ProductSKU (mig 0188) never got a job
-- and stayed "No photos yet" forever — exactly the lots the new Wayfair-SKU
-- drain tier (2026-07-15) is built to fix.
--
-- FIX: add site_sku / product_sku to the enqueue gate. Everything else about
-- the trigger is unchanged (photo-less gate, best-effort nested EXCEPTION,
-- idempotent ON CONFLICT). The drain's Wayfair-SKU tier consumes these.
--
-- CONSUMER PRE-REQ (same as 0197): the image-enrichment-drain that reads
-- lots.site_sku / product_sku and runs enrichWayfairImagesBySku must be
-- deployed to the Cloudflare Worker BEFORE this migration is applied.
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
       COALESCE(NEW.lpn, '') <> '' OR
       -- Wayfair returns: SKU is the only identifier on most rows.
       COALESCE(NEW.site_sku, '') <> '' OR
       COALESCE(NEW.product_sku, '') <> ''
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

-- Trigger binding is unchanged from 0197 (CREATE OR REPLACE FUNCTION swaps the
-- body in place). Re-verify it's still installed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_enqueue_lot_image_enrichment'
      AND tgrelid = 'public.lots'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0266 verification failed: trg_enqueue_lot_image_enrichment not installed on lots';
  END IF;
  RAISE NOTICE '0266 verified: enqueue gate now includes site_sku/product_sku';
END $$;
