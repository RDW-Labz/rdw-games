-- ============================================================================
-- Migration 0492 — reorder a lot's photo URLs atomically.
--
-- Why (RED TEAM on #683, 2026-11-04): the inventory Save path sends a delta
-- (0489 append / 0491 remove) so a concurrent attachment survives. That delta
-- only carried membership, so "Make Hero" — moving a photo to the front without
-- adding or removing one — looked correct on the phone but never changed
-- lots.photo_urls[0]. A full-array write would persist the order but erase a
-- concurrent attachment.
--
-- Change: one function that orders the URLs this device knows about, keeps any
-- URL another device attached concurrently at the end, and never re-adds a URL
-- that is no longer present. The BEFORE UPDATE trigger lots_filter_photo_urls
-- still strips unsafe URLs; if any named URL did not survive, the function
-- reports ok=false so the client does not claim the order was saved.
--
-- LOCKS / WINDOW: CREATE FUNCTION only (catalog lock). The read takes the lot
-- row lock (`FOR UPDATE`) so a concurrent append that commits between the read
-- and the write cannot be overwritten by an order built from a stale snapshot
-- (RED TEAM #683 HIGH). The lock is held until the function's transaction
-- commits.
-- Rollback: scripts/prod-rig/0492_ROLLBACK_reorder_lot_photo_urls.sql
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.reorder_lot_photo_urls(
  p_lot_id uuid,
  p_operator_id uuid,
  p_urls text[]
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_op     UUID := public.current_operator_id();
  v_before TEXT[];
  v_after  TEXT[];
BEGIN
  IF v_op IS NULL OR p_operator_id IS NULL OR v_op <> p_operator_id THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  IF p_urls IS NULL OR cardinality(p_urls) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'noop');
  END IF;

  SELECT COALESCE(photo_urls, ARRAY[]::TEXT[]) INTO v_before
    FROM lots
   WHERE id = p_lot_id
     AND operator_id = p_operator_id
     AND deleted_at IS NULL
     FOR UPDATE;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- Named URLs that are still present, in the requested order, followed by any
  -- URL attached concurrently that this device never saw (kept, not dropped).
  UPDATE lots
     SET photo_urls = COALESCE(
           (SELECT array_agg(u ORDER BY ord)
              FROM (
                SELECT x.u, x.ord
                  FROM unnest(p_urls) WITH ORDINALITY AS x(u, ord)
                 WHERE x.u = ANY (v_before)
                UNION ALL
                SELECT e.u, cardinality(p_urls)::bigint + e.ord
                  FROM unnest(v_before) WITH ORDINALITY AS e(u, ord)
                 WHERE NOT (e.u = ANY (p_urls))
              ) ordered),
           ARRAY[]::TEXT[]
         ),
         updated_at = now()
   WHERE id = p_lot_id
     AND operator_id = p_operator_id
     AND deleted_at IS NULL
  RETURNING photo_urls INTO v_after;

  IF v_after IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- lots_filter_photo_urls may strip a host outside the allowlist. A silent
  -- strip must not look like the order was saved.
  IF NOT (v_after @> (SELECT COALESCE(array_agg(x), ARRAY[]::TEXT[])
                        FROM unnest(p_urls) AS x
                       WHERE x = ANY (v_before))) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unsafe_url');
  END IF;

  RETURN jsonb_build_object('ok', true, 'reason', 'reordered', 'photo_urls', v_after);
END;
$function$;

REVOKE ALL ON FUNCTION public.reorder_lot_photo_urls(UUID, UUID, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reorder_lot_photo_urls(UUID, UUID, TEXT[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.reorder_lot_photo_urls(UUID, UUID, TEXT[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.reorder_lot_photo_urls(UUID, UUID, TEXT[]) IS
  '0492: set lots.photo_urls order in a single UPDATE while keeping URLs a '
  'concurrent device attached and never re-adding a removed URL. Returns '
  'ok:false when the row is missing, a named URL was stripped, or the caller '
  'is not the lot operator.';

COMMIT;
