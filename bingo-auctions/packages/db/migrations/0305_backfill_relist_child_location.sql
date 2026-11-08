-- 0305 — the carried-over lot's location is on the TOMBSTONE, not the child
--
-- Field report 2026-07-31: two customers were sent to the shelf the "CARRIED
-- OVER" banner named and the box was not there. It was in the bin the banner
-- calls "last known on this record" — the ANCESTOR's location.
--
-- This is the damage 0304's resolver bug did to the data. 0304 stops it
-- happening again; this repairs what already happened.
--
-- ── The mechanism ──────────────────────────────────────────────────────────
--
-- `relist_lot_into_auction` COPIES `intake_at` and `intake_bin_id` from the
-- source onto the new child, so at the moment of relist both rows agree. Then
-- staff physically put the box away and scan the label on it — and until 0304
-- the scan resolvers probed `lot_code` before `sticker_code`, so the scan
-- matched the retired ANCESTOR and `confirm_move_lot_to_bin` wrote the new bin
-- there. The child kept its relist-time copy forever.
--
-- The two reported lots show the sequence exactly:
--
--   BRN4374076 (ancestor, relisted)  bin 8-03-02  intake_at 07-14 16:50:03
--   BIN-002059 (child, won)          bin 5-06-02  intake_at 05-28 16:20:09
--                                                 created   07-14 15:58:16
--
-- The child was minted at 15:58 carrying the source's then-current bin. At
-- 16:50 — 52 minutes later — a put-away scan landed on the ancestor and moved
-- it to 8-03-02. Staff found the box in 8-03-02. Same shape for PNK4860302
-- (ancestor binned 16:49:00, child created 16:21:25).
--
-- ── Which side is right ────────────────────────────────────────────────────
--
-- The ancestor's. A tombstone's location can only change because someone stood
-- at a shelf with the box and scanned it; the child's is an untouched copy. The
-- population confirms there is no ambiguity to resolve:
--
--   relist pairs where the two rows disagree on the bin            186
--     …of those, ancestor was re-binned AFTER the child existed    102
--       …of those, the ancestor's intake_at is the newer one       102   (100%)
--       …where the child was re-binned more recently                 0
--       …where the child has no bin at all                           0
--       …where the child has a staged pickup assignment              0
--
-- Both reported lots were verified physically, and both matched the ancestor.
--
-- ── Scope ──────────────────────────────────────────────────────────────────
--
-- 98 of the 102: those whose ancestor is a `relisted` tombstone. The other 4
-- are all children of ONE `canceled` parent (PNK4858937) that was relisted four
-- times over; two of those children are `in_inventory` simultaneously, so which
-- row holds the box is a question about that tangle rather than about this
-- defect. None of the 4 is `won` or listed, so no customer is affected. Left
-- for a human.
--
-- Of the 98: 46 are `won` (a customer is collecting these now) and 19 are
-- draft/scheduled/live.
--
-- Deliberately NOT changed:
--   • the ancestor keeps its `intake_bin_id`. Tombstones holding a stale bin is
--     a pre-existing condition across all 929 relisted rows, not something this
--     defect created, and clearing them is a separate question about what the
--     bin audit should expect to find.
--   • no `bin_assignments` writes: none of the 98 children has a staged
--     assignment, so there is nothing to keep in lockstep.

BEGIN;

-- ---------------------------------------------------------------------------
-- The repair, as a callable function rather than a bare one-shot UPDATE.
--
-- Two reasons: it can be TESTED against fixtures (a bare UPDATE in a migration
-- can only be re-typed into the test, which is how a predicate and its test
-- drift apart), and if a write path is ever added that bypasses
-- _find_lot_by_scan, ops can re-run the repair instead of hand-writing SQL
-- against prod.
--
-- Scoped by the exact fingerprint, so it is idempotent — a second run matches
-- nothing, because the bins then agree — and it cannot touch a child whose own
-- location was updated more recently than its ancestor's.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.repair_relist_location_drift()
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
      a.warehouse_id  AS true_warehouse,
      a.intake_at     AS true_intake_at
    FROM lots c
    JOIN lots a ON a.id = c.relisted_from_lot_id
    WHERE c.deleted_at IS NULL
      AND a.deleted_at IS NULL
      AND a.status = 'relisted'                      -- tombstone only
      AND a.intake_bin_id IS NOT NULL
      AND c.intake_bin_id IS DISTINCT FROM a.intake_bin_id
      -- the ancestor was re-binned AFTER the child existed: a put-away scan
      -- that landed on the wrong row
      AND a.intake_at > c.created_at
      -- and the child has not been re-binned since
      AND a.intake_at > COALESCE(c.intake_at, '-infinity'::TIMESTAMPTZ)
  )
  UPDATE lots c
     SET intake_bin_id = s.true_bin,
         -- warehouse follows the bin (the rule 0302 established)
         warehouse_id  = COALESCE(s.true_warehouse, c.warehouse_id),
         -- carry the real put-away time, not now(), so age-in-inventory
         -- reporting stays truthful (same reasoning as 0303)
         intake_at     = s.true_intake_at,
         updated_at    = now()
    FROM stranded s
   WHERE c.id = s.child_id;

  GET DIAGNOSTICS v_fixed = ROW_COUNT;
  RETURN v_fixed;
END;
$$;

REVOKE ALL ON FUNCTION public.repair_relist_location_drift() FROM PUBLIC;

COMMENT ON FUNCTION public.repair_relist_location_drift() IS
  '0305: move the physical location from a relisted tombstone onto its child '
  'where a put-away scan wrote it to the wrong row (the mig 0304 resolver bug). '
  'Idempotent, and refuses any pair where the child was binned more recently. '
  'Returns the number of lots repaired. Not granted to `authenticated` — this '
  'is an ops repair, not an app call.';

-- Run it. 98 rows expected on prod at time of writing.
SELECT public.repair_relist_location_drift();

-- ---------------------------------------------------------------------------
-- Keep the class visible. 0304 stops new occurrences at the resolver, but if a
-- write path is ever added that bypasses it, this is how it shows up before a
-- customer does.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.relist_location_drift_audit()
RETURNS TABLE (
  child_id        UUID,
  child_code      TEXT,
  sticker_code    TEXT,
  child_status    TEXT,
  child_bin       TEXT,
  ancestor_code   TEXT,
  ancestor_status TEXT,
  ancestor_bin    TEXT,
  ancestor_binned_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id, c.lot_code, c.sticker_code, c.status::TEXT,
    bc.code, a.lot_code, a.status::TEXT, ba.code, a.intake_at
  FROM lots c
  JOIN lots a ON a.id = c.relisted_from_lot_id
  LEFT JOIN bins bc ON bc.id = c.intake_bin_id
  LEFT JOIN bins ba ON ba.id = a.intake_bin_id
  WHERE c.deleted_at IS NULL
    AND a.deleted_at IS NULL
    AND a.intake_bin_id IS NOT NULL
    AND c.intake_bin_id IS DISTINCT FROM a.intake_bin_id
    AND a.intake_at > c.created_at
    AND a.intake_at > COALESCE(c.intake_at, '-infinity'::TIMESTAMPTZ)
  ORDER BY a.intake_at DESC;
$$;

REVOKE ALL ON FUNCTION public.relist_location_drift_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.relist_location_drift_audit() TO authenticated;

COMMENT ON FUNCTION public.relist_location_drift_audit() IS
  '0305: relist children whose retired ancestor holds a NEWER physical location '
  'than they do — a put-away scan that resolved to the tombstone. The box is at '
  'the ANCESTOR''s bin. Should stay empty now that mig 0304 ranks scans onto the '
  'live incarnation; a non-empty result means a write path is bypassing '
  '_find_lot_by_scan. Reports the 4 remaining PNK4858937 children, which 0305 '
  'deliberately left alone (non-tombstone ancestor, four-way relist tangle).';

COMMIT;
