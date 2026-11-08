-- 0312 — the relist location repair must run to a fixpoint, not once
--
-- 0311 shipped a single-pass repair. Applying it to prod on 2026-08-03 showed
-- that one pass is not enough: it repaired the 40 pairs it predicted, and in
-- doing so EXPOSED 6 more that had been invisible.
--
-- ── Why one pass is not enough ─────────────────────────────────────────────
--
-- Relist lineage is a chain, not a pair. Prod's deepest is three:
--
--     grandparent ──relist──▶ parent ──relist──▶ child
--      (tombstone)          (tombstone)         (live)
--
-- A "Move here" on the grandparent writes the true bin there. Both descendants
-- keep the relist-time copy — and they keep the SAME copy, so grandparent and
-- parent disagree (detected) but parent and child agree (invisible). The
-- child is just as wrong as the parent; nothing in a pairwise query can see it
-- until the parent is fixed.
--
-- 0311 fixed parent-from-grandparent, and only then did parent-vs-child start
-- disagreeing. The repair propagates exactly one generation per run.
--
-- Observed on prod, running 0311's function repeatedly:
--
--     pass 1   40 rows      (as predicted by the census)
--     pass 2    6 rows      (generation 2 — revealed by pass 1)
--     pass 3    2 rows      (revealed by pass 2)
--     pass 4    0 rows      converged
--     pass 5-6  0 rows      confirmed stable, no oscillation
--
--     diverged pairs: 51 -> 11
--
-- The 11 that remain are exactly the leave-alone set from the original census
-- — 6 ambiguous, 3 where the child is the correct row, 2 where the ancestor
-- was scan-binned before the child existed. The repair did not touch them,
-- which is the point.
--
-- ── What this migration changes ────────────────────────────────────────────
--
-- Prod is already at the fixpoint (the passes above were run by hand). This
-- migration is about every OTHER way the function gets invoked: a fresh apply
-- of the migration chain, a restore, a staging rebuild, or ops re-running the
-- repair after a future incident. In all of those, 0311 alone silently
-- half-repairs — the worst possible outcome for a location table, because it
-- looks like it worked.
--
-- So: keep the single-generation function as the primitive (it is the thing
-- with a provable predicate) and add a driver that runs it to convergence.
--
-- The loop is bounded at 10. Prod's max ancestry depth is 3, so convergence
-- takes at most 3 passes plus one to confirm; 10 is slack for a deeper chain
-- appearing later. Hitting the bound raises rather than returning quietly —
-- a repair that cannot converge means the predicate is cycling, and silently
-- returning a partial result is exactly the failure this migration exists to
-- remove.
--
-- ── A note on `updated_at` as evidence ─────────────────────────────────────
--
-- The single-generation predicate reads `a.updated_at > c.created_at` as "a
-- relocate touched this tombstone after the child was born". Once the repair
-- itself writes `updated_at = now()` on a row, that row trivially satisfies
-- the clause for its own children — so on passes 2+ the clause carries no
-- evidence and the real guard is `a.intake_at IS NOT DISTINCT FROM c.intake_at`.
--
-- That guard is the load-bearing one, and it holds: identical intake_at across
-- the chain proves no scan put-away touched ANY generation since the relist,
-- so every descendant is still carrying the untouched relist-time copy and the
-- chain root's bin is the only physical event in the lineage. Verified on all
-- 8 rows that passes 2-3 touched: intake_at was identical across all three
-- generations in every one, and each parent's post-repair bin matched its
-- grandparent's exactly. If a descendant HAD been scan-binned, its intake_at
-- would differ and the propagation stops there — which is the correct
-- behaviour, and is pinned by the `chain stops at a re-scanned generation`
-- fixture in the test.

BEGIN;

CREATE OR REPLACE FUNCTION public.repair_relist_location_drift_to_fixpoint()
RETURNS TABLE (passes INTEGER, rows_repaired INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pass    INTEGER := 0;
  v_this    INTEGER;
  v_total   INTEGER := 0;
  c_max_passes CONSTANT INTEGER := 10;
BEGIN
  LOOP
    v_pass := v_pass + 1;

    IF v_pass > c_max_passes THEN
      -- Not a stuck counter: the predicate is cycling, which would mean two
      -- rows in one lineage each claim the other's bin. Fail loudly.
      RAISE EXCEPTION
        'repair_relist_location_drift did not converge in % passes (% rows written so far)',
        c_max_passes, v_total
        USING HINT = 'Inspect relist chains for a cycle in relisted_from_lot_id.';
    END IF;

    SELECT public.repair_relist_location_drift_v2() INTO v_this;
    EXIT WHEN v_this = 0;

    v_total := v_total + v_this;
    RAISE NOTICE 'relist location repair: pass % repaired % row(s)', v_pass, v_this;
  END LOOP;

  passes := v_pass;
  rows_repaired := v_total;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.repair_relist_location_drift_to_fixpoint() FROM PUBLIC;

DO $$
DECLARE v_passes INTEGER; v_rows INTEGER;
BEGIN
  SELECT p.passes, p.rows_repaired
    INTO v_passes, v_rows
    FROM public.repair_relist_location_drift_to_fixpoint() p;

  -- On prod this logs 1 pass / 0 rows: the hand-run passes already converged.
  -- On a fresh apply or a restore it does the whole job.
  RAISE NOTICE '0312: relist location repair converged after % pass(es), % row(s) repaired',
    v_passes, v_rows;
END $$;

COMMIT;
