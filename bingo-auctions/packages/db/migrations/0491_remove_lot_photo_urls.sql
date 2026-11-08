-- ============================================================================
-- Migration 0491 — remove photo URLs from a lot atomically.
--
-- Why (RED TEAM on #683, 2026-11-04): the inventory Save path wrote the whole
-- photo_urls array back. A background retry or a second device could attach a
-- photo between this device's load and Save, and the replacement erased it.
-- Appending is already atomic (0489); removals still need a statement that
-- touches only the URLs the operator actually removed.
--
-- Change: one function that filters the named URLs out inside a single UPDATE.
-- URLs added concurrently are not named, so they survive.
--
-- LOCKS / WINDOW: CREATE FUNCTION only (catalog lock). No table lock here; the
-- UPDATE takes the lot row lock for the duration of one statement.
-- Rollback: scripts/prod-rig/0491_ROLLBACK_remove_lot_photo_urls.sql
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.remove_lot_photo_urls(
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
  v_op   UUID := public.current_operator_id();
  v_urls TEXT[];
BEGIN
  IF v_op IS NULL OR p_operator_id IS NULL OR v_op <> p_operator_id THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  IF p_urls IS NULL OR cardinality(p_urls) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'noop');
  END IF;

  UPDATE lots
     SET photo_urls = COALESCE(
           (SELECT array_agg(u)
              FROM unnest(COALESCE(photo_urls, ARRAY[]::TEXT[])) AS u
             WHERE NOT (u = ANY (p_urls))),
           ARRAY[]::TEXT[]
         ),
         updated_at = now()
   WHERE id = p_lot_id
     AND operator_id = p_operator_id
     AND deleted_at IS NULL
  RETURNING photo_urls INTO v_urls;

  IF v_urls IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'reason', 'removed', 'photo_urls', v_urls);
END;
$function$;

REVOKE ALL ON FUNCTION public.remove_lot_photo_urls(UUID, UUID, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_lot_photo_urls(UUID, UUID, TEXT[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.remove_lot_photo_urls(UUID, UUID, TEXT[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.remove_lot_photo_urls(UUID, UUID, TEXT[]) IS
  '0491: remove named photo URLs from lots.photo_urls in a single UPDATE so a '
  'concurrent attachment by another device is not erased. Returns ok:false if '
  'the row is missing and raises when the caller is not the lot operator.';

COMMIT;
