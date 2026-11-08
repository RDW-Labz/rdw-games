-- 0311 — "Move here" must follow the live lot, not the tombstone
--
-- Field report 2026-08-03: relisted items are still not in the bin the app
-- says they are in. Staff worked around it by opening the OLD record, whose
-- page labels its bin "Location (last known on this record)" — and the box was
-- there. That workaround is the diagnosis: the tombstone holds the true bin
-- and the live child holds a stale copy.
--
-- ── Why 0305 did not already fix this ──────────────────────────────────────
--
-- Same defect class, different write path. 0305 repaired children stranded by
-- put-away SCANS landing on the ancestor, and keyed its predicate entirely on
-- `intake_at`:
--
--     AND a.intake_at > c.created_at
--     AND a.intake_at > COALESCE(c.intake_at, '-infinity')
--
-- But the Bin Audit "Move here" button calls `audit_relocate_lot`, and its
-- location-only branch (0302) writes:
--
--     UPDATE lots SET intake_bin_id = …, warehouse_id = …, updated_at = now()
--
-- — no `intake_at`. Deliberately: `intake_at` means "when was this put away",
-- and age-in-inventory reporting reads it, so a shelf-to-shelf move must not
-- reset it. The cost is that 0305's detector is blind to every move made this
-- way. Those pairs sat unrepaired, and 0304 (which fixed scan resolution)
-- never touched them because no scan was involved.
--
-- Prod census, 2026-08-03 — 51 relist pairs disagree on the bin:
--
--   ancestor moved via "Move here", no scan put-away either side since
--     the relist (a.intake_at = c.intake_at AND a.updated_at > c.created_at)   40
--     …of those, child is `won` — a customer is collecting it now             17
--     …of those, child is draft/scheduled/live                                 0
--   child scan-binned more recently — the CHILD is right, leave alone           3
--   ancestor scan-binned more recently but before the child existed             2
--   ambiguous (no signal on either side)                                        6
--
-- The 40 are unambiguous. `intake_at` being equal proves no scan put-away
-- touched either row since the relist, so the child's bin is provably still
-- the untouched copy `relist_lot_into_auction` made; and the ancestor — a
-- tombstone nothing else writes to — was updated after the child was born.
-- The only thing that does that is someone standing at a shelf tapping
-- "Move here". Their `updated_at` values are spread across working hours over
-- Jul 14–27 in clusters of 1–4, which is people moving boxes, not a sweep.
--
-- The 3 + 2 + 6 are deliberately left alone: for the 3 the child is the
-- correct row, and for the other 8 there is no signal that says which side
-- holds the box. Those want a human with a scanner, not a guess.
--
-- ── The leak is still open ─────────────────────────────────────────────────
--
-- The count went 50 -> 51 during the session that wrote this file. 0304 closed
-- the scan path, but nothing stops staff opening a superseded record in the UI
-- and relocating THAT. So this migration does both halves:
--
--   1. `audit_relocate_lot` redirects a location write on a retired tombstone
--      to its one live successor. The physical box is the successor's; a
--      tombstone cannot be somewhere. This closes the path regardless of which
--      screen or search got the operator to the dead record.
--   2. `repair_relist_location_drift_v2()` fixes the 40 already stranded.
--
-- Deliberately NOT changed:
--   • `intake_at` semantics. A relocate still does not reset it (age-in-
--     inventory stays truthful). The redirect means we no longer need it to
--     carry location provenance.
--   • the tombstone keeps its `intake_bin_id`. It is what the "last known on
--     this record" banner reads, and that banner is what let staff find these
--     boxes at all. After the redirect it simply stops being the only truth.
--   • 0305's `repair_relist_location_drift()` is left in place, untouched, so
--     the scan-path repair stays independently re-runnable.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Redirect a location write on a retired record to the live successor.
--
-- Body is 0302's verbatim except for the resolution block marked 0311 and the
-- two extra keys in the return payload.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_relocate_lot(p_lot_id uuid, p_bin_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_lot lots%ROWTYPE;
  v_bin bins%ROWTYPE;
  v_bin_operator uuid;
  v_moved text;
  v_intaked boolean := false;
  -- 0311
  v_target_id    uuid := p_lot_id;
  v_redirected   boolean := false;
  v_successors   integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_lot FROM public.lots WHERE id = p_lot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lot_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Caller must be staff of the lot's operator.
  IF NOT EXISTS (
    SELECT 1 FROM public.operator_users ou
    WHERE ou.user_id = v_uid AND ou.operator_id = v_lot.operator_id
  ) THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  -- 0311: a retired record is a tombstone — the physical box belongs to its
  -- successor, so the location write belongs there too. Redirect when there is
  -- EXACTLY ONE live successor; with zero (nothing inherited it) or several
  -- (the PNK4858937-style tangle 0305 left for a human) we cannot know which
  -- row holds the box, so write where we were told and let the operator sort
  -- it out rather than guessing.
  IF v_lot.status IN ('relisted', 'canceled', 'disposed') THEN
    SELECT count(*) INTO v_successors
      FROM public.lots s
     WHERE s.relisted_from_lot_id = p_lot_id
       AND s.deleted_at IS NULL
       AND s.status NOT IN ('relisted', 'canceled', 'disposed');

    IF v_successors = 1 THEN
      SELECT s.id INTO v_target_id
        FROM public.lots s
       WHERE s.relisted_from_lot_id = p_lot_id
         AND s.deleted_at IS NULL
         AND s.status NOT IN ('relisted', 'canceled', 'disposed');
      v_redirected := true;
      -- Re-read: every branch below tests the TARGET's status, not the
      -- tombstone's (a successor can legitimately be pending_intake).
      SELECT * INTO v_lot FROM public.lots WHERE id = v_target_id;
    END IF;
  END IF;

  -- Target bin must belong to the same operator (via its warehouse).
  SELECT * INTO v_bin FROM public.bins WHERE id = p_bin_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bin_not_in_operator' USING ERRCODE = '42501';
  END IF;

  SELECT w.operator_id INTO v_bin_operator
  FROM public.warehouses w WHERE w.id = v_bin.warehouse_id;

  IF v_bin_operator IS NULL OR v_bin_operator <> v_lot.operator_id THEN
    RAISE EXCEPTION 'bin_not_in_operator' USING ERRCODE = '42501';
  END IF;

  -- Move the staged pickup assignment if there is one; else the intake pointer.
  UPDATE public.bin_assignments
     SET bin_id = p_bin_id
   WHERE lot_id = v_target_id AND status = 'staged';

  IF FOUND THEN
    v_moved := 'staged';
  ELSE
    IF v_lot.status = 'pending_intake' THEN
      -- 0302: "Move here" on a never-put-away lot IS a put-away. Mirrors
      -- intake_lot_to_bin (mig 0273/0295) so the two paths agree.
      UPDATE public.lots
         SET intake_bin_id = p_bin_id,
             warehouse_id  = v_bin.warehouse_id,
             status        = 'in_inventory',
             intake_at     = now(),
             updated_at    = now()
       WHERE id = v_target_id;
      v_intaked := true;
    ELSE
      -- LOCATION-ONLY for every other status. warehouse_id follows the bin;
      -- status / auction_id / bids / invoices are untouched.
      UPDATE public.lots
         SET intake_bin_id = p_bin_id,
             warehouse_id  = v_bin.warehouse_id,
             updated_at    = now()
       WHERE id = v_target_id;
    END IF;
    v_moved := 'intake';
  END IF;

  RETURN json_build_object(
    'ok', true,
    'moved', v_moved,
    'intaked', v_intaked,
    -- 0311: lot_id is the row actually written. Callers that echo it back (or
    -- re-read it) must follow the redirect, or they would show the operator
    -- the tombstone they aimed at instead of the lot that moved.
    'lot_id', v_target_id,
    'redirected_from', CASE WHEN v_redirected THEN p_lot_id ELSE NULL END,
    'bin_id', p_bin_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.audit_relocate_lot(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Repair the children already stranded by the "Move here" path.
--
-- A function rather than a bare UPDATE, for 0305's reasons: it can be tested
-- against fixtures, and ops can re-run it without hand-writing SQL on prod.
-- Idempotent — after it runs the bins agree, so a second run matches nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.repair_relist_location_drift_v2()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fixed INTEGER;
BEGIN
  WITH stranded AS (
    SELECT
      c.id            AS child_id,
      a.intake_bin_id AS true_bin,
      a.warehouse_id  AS true_warehouse
    FROM lots c
    JOIN lots a ON a.id = c.relisted_from_lot_id
    WHERE c.deleted_at IS NULL
      AND a.deleted_at IS NULL
      AND a.status = 'relisted'                        -- tombstone only
      AND a.intake_bin_id IS NOT NULL
      AND c.intake_bin_id IS DISTINCT FROM a.intake_bin_id
      -- No scan put-away has touched EITHER row since the relist, so the
      -- child's bin is still the copy relist_lot_into_auction made. (Both
      -- NULL counts as equal — hence IS NOT DISTINCT FROM.)
      AND a.intake_at IS NOT DISTINCT FROM c.intake_at
      -- …and the tombstone was written after the child was born. Nothing but
      -- a relocate does that: relist itself stamps parent.updated_at and
      -- child.created_at from the same transaction clock, so this is strictly
      -- false for an untouched pair.
      AND a.updated_at > c.created_at
  )
  UPDATE lots c
     SET intake_bin_id = s.true_bin,
         -- warehouse follows the bin (the rule 0302 established)
         warehouse_id  = COALESCE(s.true_warehouse, c.warehouse_id),
         -- intake_at is deliberately NOT copied: neither row was re-put-away,
         -- so the child's existing value is already the correct put-away time
         -- and age-in-inventory must not shift.
         updated_at    = now()
    FROM stranded s
   WHERE c.id = s.child_id;

  GET DIAGNOSTICS v_fixed = ROW_COUNT;
  RETURN v_fixed;
END;
$$;

REVOKE ALL ON FUNCTION public.repair_relist_location_drift_v2() FROM PUBLIC;

DO $$
DECLARE v_fixed INTEGER;
BEGIN
  SELECT public.repair_relist_location_drift_v2() INTO v_fixed;
  RAISE NOTICE '0311: repaired % relist children stranded by the relocate path', v_fixed;
END $$;

COMMIT;
