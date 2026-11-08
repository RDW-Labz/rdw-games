-- ============================================================================
-- 0049_lot_photo_url_trigger
--
-- DB-layer defense-in-depth for lots.photo_urls. Application code already
-- filters via filterSafeImageUrls (R2.1 in persistence.ts + useLotUpdate),
-- but a trigger here catches:
--   - Direct service-role INSERTs from one-off scripts that bypass the
--     persistence layer
--   - Future RPC paths that build their own INSERT without filtering
--   - Manual SQL written by an admin in psql
--
-- Behavior: silently strips unsafe URLs from the array on INSERT/UPDATE.
-- We choose strip-not-reject because:
--   - Existing photo_urls history may legitimately contain trailing
--     legacy entries that newer rows would inherit.
--   - Real flow always provides at least one valid CDN URL — the
--     stripped array gracefully degrades instead of failing the write.
--   - Logs are emitted via RAISE NOTICE so engineers can see when it
--     fired.
--
-- Idempotent: function uses CREATE OR REPLACE; trigger uses DROP IF EXISTS
-- + CREATE.
-- ============================================================================

CREATE OR REPLACE FUNCTION filter_lot_photo_urls()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_filtered TEXT[];
  v_dropped INT;
BEGIN
  IF NEW.photo_urls IS NULL THEN
    NEW.photo_urls := ARRAY[]::TEXT[];
    RETURN NEW;
  END IF;

  -- Build the filtered array using is_safe_image_url(). array_agg(filter)
  -- returns NULL when no rows match — coalesce to empty array so the
  -- column NOT NULL DEFAULT contract is honored.
  SELECT COALESCE(array_agg(u), ARRAY[]::TEXT[])
  INTO v_filtered
  FROM unnest(NEW.photo_urls) AS u
  WHERE is_safe_image_url(u);

  v_dropped := array_length(NEW.photo_urls, 1) - COALESCE(array_length(v_filtered, 1), 0);
  IF v_dropped IS NOT NULL AND v_dropped > 0 THEN
    -- Surfaced in postgres logs at INFO level; not raised as an error
    -- because we want the row to commit with the safe subset.
    RAISE NOTICE 'lot_photo_url_filter: stripped % unsafe URL(s) from lot %',
      v_dropped, COALESCE(NEW.lot_code, NEW.id::TEXT);
  END IF;

  NEW.photo_urls := v_filtered;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION filter_lot_photo_urls() IS
  'R6.1: BEFORE INSERT/UPDATE trigger function. Strips unsafe URLs from lots.photo_urls via is_safe_image_url() (the same allowlist used in TS by filterSafeImageUrls). Defense-in-depth catches paths that bypass persistence.ts.';

DROP TRIGGER IF EXISTS lots_filter_photo_urls ON lots;

CREATE TRIGGER lots_filter_photo_urls
BEFORE INSERT OR UPDATE OF photo_urls ON lots
FOR EACH ROW
EXECUTE FUNCTION filter_lot_photo_urls();

COMMENT ON TRIGGER lots_filter_photo_urls ON lots IS
  'R6.1: enforce ALLOWED_IMAGE_HOSTS allowlist on every photo_urls write, regardless of caller.';
