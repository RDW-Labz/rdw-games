-- 0426 — Missing Items: a report of every item still marked missing, the
--        three ways to resolve one, and a history of who checked it.
--
-- ── THE ASK ─────────────────────────────────────────────────────────────────
-- Jared, 2026-10-15: items refunded as missing broke auction building (fixed
-- in the builder by #516). Nothing lists them, so nobody works them. He wants a
-- Missing Items report with per-item actions:
--   * Found              — scan it and put it away again; that clears the flag
--                          and it can be listed again.
--   * Confirmed missing  — write it off and remove it from active inventory.
--   * Found but unsellable — mark it for disposal, then record when the
--                          disposal is done.
-- and a verification history (who checked, when, outcome). Unresolved items
-- stay on the report until somebody works them.
--
-- ── WHAT "MISSING" MEANS HERE ───────────────────────────────────────────────
-- Exactly what the system already enforces — nothing new is invented:
--   * pickup: a pickup_lot_outcomes row with outcome 'missing' (0243). 0345's
--     trigger refuses any relist until the item is put away after the LATEST
--     such mark (intake_at, a lot_location_events row, or a bin_assignments
--     row dated after it). 0354 made a put-away onto the same shelf write a
--     location event, so put-away clears it from the floor.
--   * removal: removal_kind 'missing' (0352) — already written off.
-- missing_item_found_since() below is 0345's rule, verbatim, so the report and
-- the trigger cannot disagree about whether an item is still missing.
--
-- ── REUSE, NOT NEW PATHS ────────────────────────────────────────────────────
--   Found             → intake_lot_to_bin()          (the put-away RPC itself)
--   Confirmed missing → remove_lot_from_inventory(…, 'missing')   (0319/0352)
--   Unsellable        → lots.flagged_for_disposal    (0146; the Worklist's
--                       flagged section already shows these)
--   Disposal done     → remove_lot_from_inventory(…, <kind>)
-- Each RPC adds one missing_item_checks row on success. The wrapped RPCs keep
-- all their own guards (role, operator, live-with-bids, idempotency).
--
-- ── LOCKS ───────────────────────────────────────────────────────────────────
-- New table with foreign keys to lots and bins: adding a FK takes SHARE ROW
-- EXCLUSIVE on the referenced table, which briefly blocks writes to lots. It
-- is metadata-only (no scan of lots) and lock_timeout is 3s, but per Rule 9
-- apply in the 05:00–07:00 CT window. Everything else is new functions.
--
-- Rollback: 0426_ROLLBACK_missing_item_checks.sql (drops the functions and the
-- table; touches no existing object).

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. The history table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.missing_item_checks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id  uuid NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,
  lot_id       uuid NOT NULL REFERENCES public.lots(id) ON DELETE CASCADE,
  -- found             put away again; eligible to list
  -- confirmed_missing written off (removal_kind 'missing', status disposed)
  -- unsellable        found, not sellable; flagged for disposal
  -- disposed          the disposal of an unsellable item is done
  outcome      text NOT NULL
               CHECK (outcome IN ('found', 'confirmed_missing', 'unsellable', 'disposed')),
  note         text,
  -- found: the shelf it went back on. disposed: how it left.
  bin_id       uuid REFERENCES public.bins(id) ON DELETE SET NULL,
  removal_kind text,
  checked_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- clock_timestamp, not now(): two checks in one transaction (a script, a
  -- test) must still order correctly, since "latest check" decides the state.
  checked_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS missing_item_checks_lot_idx
  ON public.missing_item_checks (lot_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS missing_item_checks_operator_idx
  ON public.missing_item_checks (operator_id, checked_at DESC);

COMMENT ON TABLE public.missing_item_checks IS
  '0426: who checked a missing item, when, and the outcome. Written only by the missing_item_* RPCs.';

ALTER TABLE public.missing_item_checks ENABLE ROW LEVEL SECURITY;

-- Staff read their own operator's history. No write policies: rows are only
-- written by the SECURITY DEFINER RPCs below.
DROP POLICY IF EXISTS missing_item_checks_staff_read ON public.missing_item_checks;
CREATE POLICY missing_item_checks_staff_read ON public.missing_item_checks
  FOR SELECT TO authenticated
  USING (operator_id IN (SELECT ou.operator_id FROM public.operator_users ou
                          WHERE ou.user_id = (SELECT auth.uid())));

REVOKE ALL ON TABLE public.missing_item_checks FROM PUBLIC;
REVOKE ALL ON TABLE public.missing_item_checks FROM anon;
GRANT SELECT ON TABLE public.missing_item_checks TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. 0345's rule as a function: has anyone put it away since p_since?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.missing_item_found_since(p_lot_id uuid, p_since timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    EXISTS (SELECT 1 FROM lots p
             WHERE p.id = p_lot_id AND p.intake_at IS NOT NULL AND p.intake_at > p_since)
    OR EXISTS (SELECT 1 FROM lot_location_events e
                WHERE e.lot_id = p_lot_id AND e.occurred_at > p_since)
    OR EXISTS (SELECT 1 FROM bin_assignments ba
                WHERE ba.lot_id = p_lot_id AND ba.assigned_at > p_since);
$function$;

COMMENT ON FUNCTION public.missing_item_found_since(uuid, timestamptz) IS
  '0426: the clearing rule of lots_block_relist_of_missing_item (0345), shared by the Missing Items report and RPCs.';

REVOKE EXECUTE ON FUNCTION public.missing_item_found_since(uuid, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.missing_item_found_since(uuid, timestamptz) FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The report
-- ---------------------------------------------------------------------------
-- One row per lot ever marked missing (pickup outcome or 'missing' removal) in
-- the caller's operator. state:
--   open              still missing, nobody has resolved it      (unresolved)
--   unsellable        found but marked for disposal, not done yet (unresolved)
--   found             put away since the latest mark             (resolved)
--   confirmed_missing written off                                (resolved)
--   disposed          left inventory another way                 (resolved)
-- p_include_resolved = false returns only the unresolved two.
CREATE OR REPLACE FUNCTION public.missing_items_report(p_include_resolved boolean DEFAULT false)
RETURNS TABLE (
  lot_id              uuid,
  lot_code            text,
  display_code        text,
  title               text,
  photo_url           text,
  lot_status          text,
  location_code       text,
  location_at         timestamptz,
  missing_at          timestamptz,
  source              text,
  reason              text,
  marked_by_name      text,
  state               text,
  last_check_at       timestamptz,
  last_check_outcome  text,
  last_check_note     text,
  last_check_by_name  text,
  check_count         integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_op uuid;
BEGIN
  SELECT ou.operator_id INTO v_op
    FROM operator_users ou WHERE ou.user_id = auth.uid() LIMIT 1;
  IF v_op IS NULL THEN
    RETURN;  -- not staff: empty, never another operator's rows
  END IF;

  RETURN QUERY
  WITH marks AS (
    -- Latest pickup 'missing' outcome per lot, with its note and who decided.
    SELECT DISTINCT ON (o.lot_id)
           o.lot_id, o.created_at AS at, o.note, o.decided_by AS by_user
      FROM pickup_lot_outcomes o
      JOIN lots l ON l.id = o.lot_id
     WHERE o.outcome::text = 'missing'
       AND l.operator_id = v_op
     ORDER BY o.lot_id, o.created_at DESC
  ),
  removals AS (
    SELECT l.id AS lot_id, l.removed_at AS at, l.removal_note AS note, l.removed_by AS by_user
      FROM lots l
     WHERE l.operator_id = v_op
       AND l.removal_kind = 'missing'
       AND l.id NOT IN (SELECT m.lot_id FROM marks m)
  ),
  flagged AS (
    SELECT m.lot_id, m.at, m.note, m.by_user, 'pickup'::text AS source FROM marks m
    UNION ALL
    SELECT r.lot_id, r.at, r.note, r.by_user, 'removal'::text FROM removals r
  ),
  enriched AS (
    SELECT f.*,
           l.lot_code AS l_lot_code, l.display_code AS l_display_code, l.title AS l_title,
           l.photo_urls[1] AS l_photo, l.status::text AS l_status,
           l.removal_kind AS l_removal_kind, l.deleted_at AS l_deleted_at,
           lc.id AS c_id, lc.outcome AS c_outcome, lc.note AS c_note,
           lc.checked_at AS c_at, lc.checked_by AS c_by,
           (SELECT count(*)::int FROM missing_item_checks x WHERE x.lot_id = f.lot_id) AS c_count,
           COALESCE(f.at IS NOT NULL AND missing_item_found_since(f.lot_id, f.at), false) AS found_since,
           -- Last known location: the current shelf, else the last recorded one.
           COALESCE(ib.code, le.code) AS loc_code,
           CASE WHEN ib.code IS NOT NULL THEN l.intake_at ELSE le.occurred_at END AS loc_at
      FROM flagged f
      JOIN lots l ON l.id = f.lot_id
      LEFT JOIN bins ib ON ib.id = l.intake_bin_id
      LEFT JOIN LATERAL (
        SELECT b.code, e.occurred_at
          FROM lot_location_events e
          JOIN bins b ON b.id = e.bin_id
         WHERE e.lot_id = f.lot_id
         ORDER BY e.occurred_at DESC
         LIMIT 1
      ) le ON true
      LEFT JOIN LATERAL (
        -- Only checks made after the latest mark count: an item found once
        -- and marked missing again is open again.
        SELECT c.* FROM missing_item_checks c
         WHERE c.lot_id = f.lot_id
           AND (f.at IS NULL OR c.checked_at >= f.at)
         ORDER BY c.checked_at DESC
         LIMIT 1
      ) lc ON true
  ),
  stated AS (
    SELECT e.*,
           CASE
             WHEN e.c_outcome = 'disposed' THEN 'disposed'
             WHEN e.l_removal_kind = 'missing' OR e.c_outcome = 'confirmed_missing' THEN 'confirmed_missing'
             WHEN e.l_removal_kind IS NOT NULL THEN 'disposed'
             WHEN e.c_outcome = 'unsellable' THEN 'unsellable'
             WHEN e.found_since THEN 'found'
             ELSE 'open'
           END AS st
      FROM enriched e
     WHERE e.l_deleted_at IS NULL
  )
  SELECT s.lot_id, s.l_lot_code, s.l_display_code, s.l_title, s.l_photo, s.l_status,
         s.loc_code, s.loc_at, s.at, s.source,
         NULLIF(btrim(COALESCE(s.note, '')), ''),
         COALESCE(mb.display_name, mb.email),
         s.st, s.c_at, s.c_outcome, s.c_note,
         COALESCE(cb.display_name, cb.email),
         s.c_count
    FROM stated s
    LEFT JOIN operator_users mb ON mb.user_id = s.by_user AND mb.operator_id = v_op
    LEFT JOIN operator_users cb ON cb.user_id = s.c_by AND cb.operator_id = v_op
   WHERE p_include_resolved OR s.st IN ('open', 'unsellable')
   ORDER BY s.at DESC NULLS LAST;
END;
$function$;

COMMENT ON FUNCTION public.missing_items_report(boolean) IS
  '0426: Missing Items report rows for the caller''s operator. Unresolved = open or unsellable.';

REVOKE EXECUTE ON FUNCTION public.missing_items_report(boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.missing_items_report(boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.missing_items_report(boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- Shared precondition: the lot is this operator's and is currently missing.
-- Returns NULL when fine, else a reason. Also hands back the latest mark.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.missing_item_current_mark(p_lot_id uuid, p_op uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT max(o.created_at)
    FROM pickup_lot_outcomes o
    JOIN lots l ON l.id = o.lot_id
   WHERE o.lot_id = p_lot_id
     AND o.outcome::text = 'missing'
     AND l.operator_id = p_op;
$function$;

REVOKE EXECUTE ON FUNCTION public.missing_item_current_mark(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.missing_item_current_mark(uuid, uuid) FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Found — put it away again (any staff, same as put-away itself)
-- ---------------------------------------------------------------------------
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

  -- The put-away itself, with every one of its own guards (bin revoked or
  -- retired, other operator's warehouse, …). 0354: a put-away onto the shelf
  -- it is already recorded on still writes a location event, so this clears
  -- 0345's block in every case.
  v_res := intake_lot_to_bin(v_lot.lot_code, p_bin_qr_token);
  IF NOT COALESCE(v_res.ok, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', COALESCE(v_res.reason, 'putaway_failed'));
  END IF;

  IF NOT missing_item_found_since(p_lot_id, v_mark) THEN
    -- Should be unreachable after a successful put-away; refuse rather than
    -- record a "found" the relist guard will not agree with.
    RAISE EXCEPTION 'missing_item_found: put-away of % did not clear the missing mark', v_lot.lot_code;
  END IF;

  SELECT id INTO v_bin_id FROM bins WHERE qr_token = p_bin_qr_token LIMIT 1;
  INSERT INTO missing_item_checks (operator_id, lot_id, outcome, note, bin_id, checked_by)
  VALUES (v_op, p_lot_id, 'found', NULLIF(btrim(COALESCE(p_note, '')), ''), v_bin_id, v_caller);

  RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id, 'bin_code', v_res.bin_code,
                            'putaway', v_res.reason);
END;
$function$;

COMMENT ON FUNCTION public.missing_item_found(uuid, uuid, text) IS
  '0426: Missing Items → Found. Puts the lot away via intake_lot_to_bin (clears 0345) and records the check.';

REVOKE EXECUTE ON FUNCTION public.missing_item_found(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.missing_item_found(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.missing_item_found(uuid, uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Confirmed missing — write it off (admin/manager, via remove_lot_from_inventory)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.missing_item_confirm_missing(
  p_lot_id uuid,
  p_note   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_op     uuid;
  v_mark   timestamptz;
  v_res    jsonb;
  v_note   text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  SELECT operator_id INTO v_op FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_op IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  v_mark := missing_item_current_mark(p_lot_id, v_op);
  IF v_mark IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_marked_missing');
  END IF;
  IF missing_item_found_since(p_lot_id, v_mark) THEN
    -- Somebody put it away after it was marked: it is not missing.
    RETURN jsonb_build_object('ok', false, 'reason', 'already_found');
  END IF;

  -- Role, operator, live-with-bids and idempotency are all enforced here.
  v_res := remove_lot_from_inventory(p_lot_id, 'missing',
                                     COALESCE(v_note, 'Confirmed missing (Missing Items report)'));
  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RETURN v_res;
  END IF;

  INSERT INTO missing_item_checks (operator_id, lot_id, outcome, note, removal_kind, checked_by)
  VALUES (v_op, p_lot_id, 'confirmed_missing', v_note, 'missing', v_caller);

  RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id);
END;
$function$;

COMMENT ON FUNCTION public.missing_item_confirm_missing(uuid, text) IS
  '0426: Missing Items → Confirmed missing. remove_lot_from_inventory(kind missing) + a check row.';

REVOKE EXECUTE ON FUNCTION public.missing_item_confirm_missing(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.missing_item_confirm_missing(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.missing_item_confirm_missing(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Found but unsellable — flag for disposal, later record the disposal
--    (admin/manager)
-- ---------------------------------------------------------------------------
-- p_disposal_kind NULL: step 1, mark for disposal (lots.flagged_for_disposal,
--   which the Worklist's flagged section already lists).
-- p_disposal_kind set:  step 2, the disposal is done — remove_lot_from_inventory
--   with that kind ('destroyed','bin_store','donated','liquidated','other').
--   Only after step 1.
CREATE OR REPLACE FUNCTION public.missing_item_unsellable(
  p_lot_id        uuid,
  p_note          text DEFAULT NULL,
  p_disposal_kind text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_op     uuid;
  v_role   operator_user_role;
  v_lot    lots%ROWTYPE;
  v_mark   timestamptz;
  v_last   text;
  v_res    jsonb;
  v_note   text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  SELECT operator_id, role INTO v_op, v_role FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_op IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;
  IF v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'admin_or_manager_required');
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL OR v_lot.operator_id <> v_op THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;

  v_mark := missing_item_current_mark(p_lot_id, v_op);
  IF v_mark IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_marked_missing');
  END IF;
  SELECT c.outcome INTO v_last FROM missing_item_checks c
   WHERE c.lot_id = p_lot_id AND c.checked_at >= v_mark
   ORDER BY c.checked_at DESC LIMIT 1;

  IF p_disposal_kind IS NULL THEN
    -- Step 1: mark for disposal.
    IF v_lot.removal_kind IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'already_removed_as_' || v_lot.removal_kind);
    END IF;
    IF v_last = 'unsellable' THEN
      RETURN jsonb_build_object('ok', true, 'idempotent', true, 'lot_id', p_lot_id);
    END IF;
    UPDATE lots
       SET flagged_for_disposal = TRUE,
           flagged_at           = COALESCE(flagged_at, now()),
           flagged_reason       = 'unsellable: found after missing'
                                  || COALESCE(' — ' || v_note, ''),
           updated_at           = now()
     WHERE id = p_lot_id;
    INSERT INTO missing_item_checks (operator_id, lot_id, outcome, note, checked_by)
    VALUES (v_op, p_lot_id, 'unsellable', v_note, v_caller);
    RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id, 'step', 'marked_for_disposal');
  END IF;

  -- Step 2: the disposal is done.
  IF v_last IS DISTINCT FROM 'unsellable' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_marked_unsellable');
  END IF;
  IF p_disposal_kind = 'missing' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_removal_kind');
  END IF;
  v_res := remove_lot_from_inventory(p_lot_id, p_disposal_kind,
                                     COALESCE(v_note, 'Unsellable after missing (Missing Items report)'));
  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RETURN v_res;
  END IF;
  INSERT INTO missing_item_checks (operator_id, lot_id, outcome, note, removal_kind, checked_by)
  VALUES (v_op, p_lot_id, 'disposed', v_note, p_disposal_kind, v_caller);
  RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id, 'step', 'disposed',
                            'removal_kind', p_disposal_kind);
END;
$function$;

COMMENT ON FUNCTION public.missing_item_unsellable(uuid, text, text) IS
  '0426: Missing Items → Found but unsellable. No kind: flag for disposal. With kind: record the disposal via remove_lot_from_inventory.';

REVOKE EXECUTE ON FUNCTION public.missing_item_unsellable(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.missing_item_unsellable(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.missing_item_unsellable(uuid, text, text) TO authenticated;

COMMIT;
