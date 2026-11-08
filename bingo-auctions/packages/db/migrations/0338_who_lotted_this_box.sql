-- 0338 — name the person who lotted a box, on the tablet that scans it.
--
-- Requested through the in-app form 2026-08-26 (Jourdan Parker, v1.0.1):
-- "It would be nice to have each lot show what lotter lotted it."
--
-- ── THE DATA ALREADY EXISTS; IT IS JUST NOT REACHABLE FROM A TABLET ──────────
-- 0281 added lots.lotted_by_worker, the PIN-identified human, and it is stamped
-- on 74% of lots since 08-15 (2,534 of 3,413) across nine workers. Today the
-- only thing that reads it is the operator-web workers dashboard, which shows
-- per-worker COUNTS. Nothing answers "who lotted THIS box", which is the
-- question staff have while holding the box.
--
-- lots.lotted_by is NOT the answer to that question and must not be used for
-- it. The staff app signs in per DEVICE as a shared station account, so
-- lotted_by is the tablet, not the person — it would confidently name one
-- account for every lot on that tablet. That is worse than showing nothing.
--
-- ── WHY A FUNCTION AND NOT AN RLS POLICY ─────────────────────────────────────
-- `workers` has RLS enabled with ZERO policies, so a PostgREST embed
-- (`workers(display_name)`) returns null to every client. The obvious fix —
-- add a SELECT policy for operator staff — is the wrong one: RLS is row-level,
-- not column-level, so it would also hand `pin_hash` to anyone signed in at a
-- station. These are short numeric PINs; an offline brute force against the
-- hash is trivial, and station credentials are shared. So the hash stays
-- unreadable and this returns the one column that was actually asked for.
--
-- Operator-scoped both ways: the lot must belong to the caller's operator AND
-- the worker must too, so a lot id from another tenant resolves to NULL rather
-- than leaking a name.
--
-- Returns NULL — not an error — for the 26% of lots with no worker stamped
-- (created before 0281, or by a path that does not carry the PIN, like the
-- nightly manifest importer). The caller renders nothing in that case; a lot
-- with no recorded lotter is an ordinary state, not a failure.

BEGIN;

CREATE OR REPLACE FUNCTION public.lot_lotter_name(p_lot_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT w.display_name
  FROM lots l
  JOIN workers w ON w.id = l.lotted_by_worker
  WHERE l.id = p_lot_id
    AND l.deleted_at IS NULL
    AND l.operator_id = (SELECT public.current_operator_id())
    -- The worker row is scoped too, so a cross-tenant lotted_by_worker (which
    -- should not exist, but is not constrained to) cannot surface a name.
    AND w.operator_id = l.operator_id;
  -- Deliberately NOT filtered on w.is_active: the whole point is answering
  -- "who lotted this" for a box found weeks later, and a worker who has since
  -- left is exactly when that question gets asked.
$function$;

GRANT EXECUTE ON FUNCTION public.lot_lotter_name(uuid) TO authenticated;

COMMIT;
