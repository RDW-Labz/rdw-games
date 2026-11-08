-- 0445 — Missing Items "Found" works on an item that was relisted after it
--        was marked missing.
--
-- ── THE REPORT ──────────────────────────────────────────────────────────────
-- Staff, 2026-10-22: Found → put-away fails with
--   "missing_item_found: put-away of BIN-011585 did not clear the missing mark"
-- (also BIN-005996, BIN-005667). The item stays "Still missing".
--
-- ── WHY (read-only on prod, 2026-10-22) ─────────────────────────────────────
-- All three lots were marked missing at pickup (Aug 2 / Aug 4 / Aug 28) and
-- then RELISTED (children created Aug 12 / Aug 12 / Sep 1, before the 0345
-- relist guard). The sticker and the box now belong to the child lot.
-- missing_item_found() puts away by lot code; intake_lot_to_bin() resolves the
-- code through _find_lot_by_scan(), which (0316) returns the CURRENT lineage
-- member: the child. So the put-away lands on the child ('ok_already_here',
-- a location event on the child), while missing_item_found_since() looks only
-- at the parent and finds nothing, and the RAISE rolls everything back. No row
-- is left behind (checked: no events on the children today, no check rows).
-- Not from #558 (that changed only which bin a typed code matches); 0426 has
-- had this since it shipped. Lots marked missing, unresolved, with a relist:
-- 5 on prod today.
--
-- ── WHAT ────────────────────────────────────────────────────────────────────
-- 1. missing_item_found_since(lot, since) also counts the lot's relist
--    descendants (any depth): the same three signals (intake_at, a
--    lot_location_events row, a bin_assignments row) after `since` on a
--    descendant mean the box was handled after the mark. Used by the report,
--    Found and Confirmed missing. The 0345 relist trigger has its own copy of
--    the rule and is NOT changed (a relisted parent cannot be relisted again
--    anyway).
-- 2. missing_item_found() refuses BEFORE any put-away when the scan resolves
--    to a relist lot that was already written off (removal_kind set):
--    'relist_removed_as_<kind>' plus the relist's lot code. Re-lot that box
--    instead (BIN-011585's relist BIN-014913 is disposed). Its result also
--    carries 'put_away_lot_code', the lot the box is shelved under now.
--
-- LOCKS: CREATE OR REPLACE FUNCTION only.
-- ROLLBACK: scripts/prod-rig/0445_ROLLBACK_missing_item_found_follows_relist.sql
--           (restores both 0426 definitions verbatim).

SET lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.missing_item_found_since(p_lot_id uuid, p_since timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH RECURSIVE fam AS (
    SELECT p_lot_id AS id, 0 AS depth
    UNION ALL
    SELECT c.id, f.depth + 1
      FROM lots c JOIN fam f ON c.relisted_from_lot_id = f.id
     WHERE f.depth < 10
  )
  SELECT
    EXISTS (SELECT 1 FROM lots p JOIN fam f ON f.id = p.id
             WHERE p.intake_at IS NOT NULL AND p.intake_at > p_since)
    OR EXISTS (SELECT 1 FROM lot_location_events e JOIN fam f ON f.id = e.lot_id
                WHERE e.occurred_at > p_since)
    OR EXISTS (SELECT 1 FROM bin_assignments ba JOIN fam f ON f.id = ba.lot_id
                WHERE ba.assigned_at > p_since);
$function$;

COMMENT ON FUNCTION public.missing_item_found_since(uuid, timestamptz) IS
  '0426/0445: has the item been handled since p_since: 0345''s clearing rule '
  '(intake, location event, bin assignment), over the lot and its relist '
  'descendants. Shared by the Missing Items report and RPCs.';

REVOKE EXECUTE ON FUNCTION public.missing_item_found_since(uuid, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.missing_item_found_since(uuid, timestamptz) FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.missing_item_found(
  p_lot_id        uuid,
  p_bin_qr_token  uuid,
  p_note          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_op     uuid;
  v_lot    lots%ROWTYPE;
  v_mark   timestamptz;
  v_last   text;
  v_res    intake_lot_result;
  v_bin_id uuid;
  v_find   jsonb;
  v_target lots%ROWTYPE;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  SELECT operator_id INTO v_op FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_op IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id;
  IF v_lot.id IS NULL OR v_lot.operator_id <> v_op THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  IF v_lot.removal_kind IS NOT NULL THEN
    -- Written off already (disposed). Put-away does not bring a disposed lot
    -- back; re-lot it instead, the way any found item is.
    RETURN jsonb_build_object('ok', false, 'reason', 'already_removed_as_' || v_lot.removal_kind);
  END IF;

  v_mark := missing_item_current_mark(p_lot_id, v_op);
  IF v_mark IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_marked_missing');
  END IF;
  SELECT c.outcome INTO v_last FROM missing_item_checks c
   WHERE c.lot_id = p_lot_id AND c.checked_at >= v_mark
   ORDER BY c.checked_at DESC LIMIT 1;
  IF v_last = 'unsellable' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'marked_unsellable');
  END IF;

  -- 0445: the put-away goes by lot code, and the scan resolver (0316) hands
  -- back the CURRENT lineage member. For an item relisted after its mark that
  -- is the relist lot. If that lot was written off, refuse before touching
  -- anything: re-lot the box instead.
  v_find := _find_lot_by_scan(ARRAY[v_lot.lot_code]);
  IF COALESCE((v_find->>'ok')::boolean, false) THEN
    SELECT * INTO v_target FROM lots WHERE id = (v_find->'lot'->>'id')::uuid;
    IF v_target.id IS NOT NULL AND v_target.id <> p_lot_id AND v_target.removal_kind IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'relist_removed_as_' || v_target.removal_kind,
                                'relist_lot_code', v_target.lot_code);
    END IF;
  END IF;

  -- The put-away itself, with every one of its own guards (bin revoked or
  -- retired, other operator's warehouse, …). 0354: a put-away onto the shelf
  -- it is already recorded on still writes a location event, so this clears
  -- 0345's block in every case.
  v_res := intake_lot_to_bin(v_lot.lot_code, p_bin_qr_token);
  IF NOT COALESCE(v_res.ok, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', COALESCE(v_res.reason, 'putaway_failed'));
  END IF;

  IF NOT missing_item_found_since(p_lot_id, v_mark) THEN
    -- 0445: found_since now covers the relist lineage, so this means the scan
    -- resolved to a lot outside it. Refuse rather than record a wrong "found".
    RAISE EXCEPTION 'missing_item_found: put-away of % did not clear the missing mark', v_lot.lot_code;
  END IF;

  SELECT id INTO v_bin_id FROM bins WHERE qr_token = p_bin_qr_token LIMIT 1;
  INSERT INTO missing_item_checks (operator_id, lot_id, outcome, note, bin_id, checked_by)
  VALUES (v_op, p_lot_id, 'found', NULLIF(btrim(COALESCE(p_note, '')), ''), v_bin_id, v_caller);

  RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id, 'bin_code', v_res.bin_code,
                            'putaway', v_res.reason,
                            'put_away_lot_code', v_res.lot_code);
END;
$function$;

COMMENT ON FUNCTION public.missing_item_found(uuid, uuid, text) IS
  '0426/0445: Missing Items → Found. Puts the lot away via intake_lot_to_bin '
  '(which follows a relist to the current lot), refuses a written-off relist, '
  'and records the check.';

REVOKE EXECUTE ON FUNCTION public.missing_item_found(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.missing_item_found(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.missing_item_found(uuid, uuid, text) TO authenticated;
