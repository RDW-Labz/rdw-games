-- ============================================================================
-- Migration 0489 — append one photo URL to a lot atomically.
--
-- Why (RED TEAM on #683, 2026-11-04): the staff photo queue read
-- lots.photo_urls, then wrote `[...current, url]`. Two devices attaching to
-- the same lot could interleave between the read and the write: the second
-- device's attachment was erased by the first device's update. A zero-row
-- update (lot gone, operator switched, RLS refused) also returned no error,
-- so the queue deleted the local file and its entry and reported success.
--
-- Change: one small function that appends inside a single UPDATE. The BEFORE
-- UPDATE trigger lots_filter_photo_urls still strips unsafe URLs; if the
-- appended URL did not survive, the function reports ok=false so the client
-- keeps the file and retries instead of claiming success.
--
-- LOCKS / WINDOW: CREATE FUNCTION only (catalog lock). No table lock here; the
-- UPDATE takes the lot row lock for the duration of one statement.
-- Rollback: scripts/prod-rig/0489_ROLLBACK_append_lot_photo_url.sql
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.append_lot_photo_url(
  p_lot_id uuid,
  p_operator_id uuid,
  p_url text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_op   UUID := public.current_operator_id();
  v_urls TEXT[];
BEGIN
  IF v_op IS NULL OR p_operator_id IS NULL OR v_op <> p_operator_id THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  IF p_url IS NULL OR btrim(p_url) = '' OR p_url NOT LIKE 'https://%' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_url');
  END IF;

  UPDATE lots
     SET photo_urls = array_append(COALESCE(photo_urls, ARRAY[]::TEXT[]), p_url),
         updated_at = now()
   WHERE id = p_lot_id
     AND operator_id = p_operator_id
     AND deleted_at IS NULL
     AND NOT (COALESCE(photo_urls, ARRAY[]::TEXT[]) @> ARRAY[p_url])
  RETURNING photo_urls INTO v_urls;

  IF v_urls IS NULL THEN
    -- Either the lot is not the caller's, or this exact URL is already there.
    SELECT photo_urls INTO v_urls
      FROM lots
     WHERE id = p_lot_id
       AND operator_id = p_operator_id
       AND deleted_at IS NULL;

    IF v_urls IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
    END IF;
    IF COALESCE(v_urls, ARRAY[]::TEXT[]) @> ARRAY[p_url] THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'already_present', 'photo_urls', v_urls);
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'not_updated');
  END IF;

  -- lots_filter_photo_urls strips hosts outside the allowlist. A silent strip
  -- must not look like an attachment.
  IF NOT (v_urls @> ARRAY[p_url]) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unsafe_url');
  END IF;

  RETURN jsonb_build_object('ok', true, 'reason', 'appended', 'photo_urls', v_urls);
END;
$function$;

REVOKE ALL ON FUNCTION public.append_lot_photo_url(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.append_lot_photo_url(UUID, UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.append_lot_photo_url(UUID, UUID, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.append_lot_photo_url(UUID, UUID, TEXT) IS
  '0489: append one photo URL to lots.photo_urls in a single UPDATE so two '
  'devices cannot erase each other''s attachment. Returns ok:false when the '
  'row is missing, the URL is unsafe or the caller is not the lot operator.';

COMMIT;
