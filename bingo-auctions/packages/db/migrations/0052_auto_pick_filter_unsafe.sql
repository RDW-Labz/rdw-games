-- ============================================================================
-- 0052_auto_pick_filter_unsafe
--
-- Hotfix to 0051's auto_pick_featured_images. The function returned ALL
-- top-MSRP photo URLs without filtering through is_safe_image_url() —
-- but the trigger in 0051 strips unsafe URLs on the subsequent
-- UPDATE auctions.featured_image_urls. So the operator clicked
-- "auto-pick", got 6 URLs back, the UI POSTed them to the row, the
-- trigger silently dropped them all, and the result was an empty
-- featured array with no error.
--
-- Fix: filter inside the RPC so caller and storage agree from the start.
-- Adds AND is_safe_image_url(photo_urls[1]) to the candidate selection.
--
-- Also: extracts the safe-photo predicate to the WHERE clause so the
-- LIMIT 20 actually picks 20 SAFE candidates (previously it could pick
-- 20 picsum.photos rows and then return them all to be stripped).
-- ============================================================================

CREATE OR REPLACE FUNCTION auto_pick_featured_images(
  p_auction_id UUID,
  p_limit INT DEFAULT 6,
  p_exclude_urls TEXT[] DEFAULT '{}'::TEXT[]
)
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_op UUID;
  v_auction_op UUID;
  v_picked TEXT[];
  v_limit INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auto_pick_featured_images: not authenticated' USING ERRCODE = '28000';
  END IF;

  v_caller_op := current_operator_id();
  IF v_caller_op IS NULL THEN
    RAISE EXCEPTION 'auto_pick_featured_images: caller is not operator staff'
      USING ERRCODE = '42501';
  END IF;

  SELECT operator_id INTO v_auction_op FROM auctions WHERE id = p_auction_id;
  IF v_auction_op IS NULL OR v_auction_op IS DISTINCT FROM v_caller_op THEN
    RETURN ARRAY[]::TEXT[];
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 6), 0), 6);
  IF v_limit = 0 THEN
    RETURN ARRAY[]::TEXT[];
  END IF;

  -- Top 20 candidates by MSRP, with a SAFE first image. The
  -- is_safe_image_url() check matches what the storage trigger does on
  -- UPDATE so the caller's list and the stored list agree.
  WITH top_pool AS (
    SELECT photo_urls[1] AS img
    FROM lots
    WHERE auction_id = p_auction_id
      AND cardinality(photo_urls) > 0
      AND photo_urls[1] IS NOT NULL
      AND is_safe_image_url(photo_urls[1])
      AND NOT (photo_urls[1] = ANY (p_exclude_urls))
    ORDER BY msrp_cents DESC NULLS LAST, lot_number ASC
    LIMIT 20
  )
  SELECT array_agg(img) INTO v_picked
  FROM (
    SELECT img FROM top_pool ORDER BY random() LIMIT v_limit
  ) sampled;

  RETURN COALESCE(v_picked, ARRAY[]::TEXT[]);
END;
$$;

COMMENT ON FUNCTION auto_pick_featured_images(UUID, INT, TEXT[]) IS
  '0051+0052: random sample of up to 6 image URLs from the top 20 lots by MSRP in this auction. Pre-filters via is_safe_image_url so caller and storage trigger agree.';
