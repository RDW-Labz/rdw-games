-- ============================================================================
-- 0051_auction_featured_images
--
-- Adds an auction-level cover/hero image array. Mirrors the bidder-facing
-- pattern from Nellis / MAC.BID / BidFTA where each auction listing has
-- a 4-6 photo collage of "the best stuff in this auction" — drives
-- click-through from the auction list to the lot grid.
--
-- Source of truth: operator-curated. Default = empty; operators run
-- auto_pick_featured_images() to seed it from their highest-MSRP lots
-- with photos. They can swap individual images via UI later.
--
-- Capped at 6 because the bidder UI displays a 2x3 or 1+5 collage; more
-- photos than that bloat the listing card.
--
-- Cross-cutting:
--   - photo URL allowlist enforced via the same is_safe_image_url() that
--     guards lots.photo_urls (migration 0049). New trigger here mirrors
--     that pattern — strips unsafe URLs silently rather than rejecting
--     the whole row.
--   - auto_pick_featured_images() takes an optional exclude_urls[] arg
--     so the UI's "pick another" button can swap an image without
--     clobbering operator choices.
-- ============================================================================

-- ── Column ───────────────────────────────────────────────────────────────────
ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS featured_image_urls TEXT[] NOT NULL DEFAULT '{}';

-- Length cap. CHECK keeps the data shape predictable for the bidder UI.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auctions_featured_image_urls_max_six'
      AND conrelid = 'public.auctions'::regclass
  ) THEN
    ALTER TABLE public.auctions
      ADD CONSTRAINT auctions_featured_image_urls_max_six
      CHECK (cardinality(featured_image_urls) <= 6);
  END IF;
END $$;

COMMENT ON COLUMN auctions.featured_image_urls IS
  'Operator-curated 0-6 cover images for the auction listing. Auto-pick via auto_pick_featured_images(). Hosts filtered through is_safe_image_url().';

-- ── Trigger: strip unsafe URLs on INSERT/UPDATE ──────────────────────────────
-- Same pattern as filter_lot_photo_urls() from 0049. Defense-in-depth so
-- direct service-role UPDATEs and admin SQL get the same allowlist.
CREATE OR REPLACE FUNCTION filter_auction_featured_images()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_filtered TEXT[];
  v_dropped INT;
BEGIN
  IF NEW.featured_image_urls IS NULL THEN
    NEW.featured_image_urls := ARRAY[]::TEXT[];
    RETURN NEW;
  END IF;

  SELECT COALESCE(array_agg(u), ARRAY[]::TEXT[])
  INTO v_filtered
  FROM unnest(NEW.featured_image_urls) AS u
  WHERE is_safe_image_url(u);

  v_dropped := array_length(NEW.featured_image_urls, 1) - COALESCE(array_length(v_filtered, 1), 0);
  IF v_dropped IS NOT NULL AND v_dropped > 0 THEN
    RAISE NOTICE 'auction_featured_images_filter: stripped % unsafe URL(s) from auction %',
      v_dropped, NEW.id;
  END IF;

  NEW.featured_image_urls := v_filtered;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auctions_filter_featured_images ON auctions;
CREATE TRIGGER auctions_filter_featured_images
BEFORE INSERT OR UPDATE OF featured_image_urls ON auctions
FOR EACH ROW
EXECUTE FUNCTION filter_auction_featured_images();

COMMENT ON FUNCTION filter_auction_featured_images() IS
  '0051: enforce ALLOWED_IMAGE_HOSTS allowlist on every featured_image_urls write.';

-- ── RPC: auto_pick_featured_images ───────────────────────────────────────────
-- Strategy: random sample of up to N (default 6) from the top 20 lots in
-- this auction, ordered by msrp_cents DESC NULLS LAST. Random sampling
-- inside the top 20 prevents the SAME 6 hero shots from appearing on
-- every auction (which they would if we just took the top 6 by MSRP —
-- pallet auctions tend to have similar high-value items repeating).
-- Variety > determinism for the cover image.
--
-- Args:
--   p_auction_id    auction to seed
--   p_limit         max images returned (default 6, capped at 6 by CHECK)
--   p_exclude_urls  optional URLs to exclude — used by the "swap this
--                   one" flow so the operator can iterate.
--
-- Returns: TEXT[] of selected image URLs. Caller writes to
-- auctions.featured_image_urls themselves (lets the UI preview before
-- committing). Empty array if no candidates qualify.
--
-- Security: SECURITY DEFINER + operator-match guard. Same shape as
-- create_draft_lot from 0048.
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

  -- Verify the auction belongs to the caller's operator. Return empty
  -- (not an error) if the auction doesn't exist or belongs to another
  -- operator — that's an information-disclosure boundary.
  SELECT operator_id INTO v_auction_op FROM auctions WHERE id = p_auction_id;
  IF v_auction_op IS NULL OR v_auction_op IS DISTINCT FROM v_caller_op THEN
    RETURN ARRAY[]::TEXT[];
  END IF;

  v_limit := LEAST(GREATEST(COALESCE(p_limit, 6), 0), 6);
  IF v_limit = 0 THEN
    RETURN ARRAY[]::TEXT[];
  END IF;

  -- Top 20 lots in this auction with at least one photo, ordered by
  -- MSRP. Random sample v_limit of them. The first photo URL of each
  -- becomes a featured image candidate.
  WITH top_pool AS (
    SELECT photo_urls[1] AS img
    FROM lots
    WHERE auction_id = p_auction_id
      AND cardinality(photo_urls) > 0
      AND photo_urls[1] IS NOT NULL
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

REVOKE EXECUTE ON FUNCTION auto_pick_featured_images(UUID, INT, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auto_pick_featured_images(UUID, INT, TEXT[]) TO authenticated;

COMMENT ON FUNCTION auto_pick_featured_images(UUID, INT, TEXT[]) IS
  '0051: random sample of up to 6 image URLs from the top 20 lots by MSRP in this auction. Variety-by-design so multiple auctions with similar inventory get distinct covers. Returns empty array on missing auction or no qualifying lots.';
