-- 0400 — a lot with a physical footprint can't be hard-deleted, and every
-- hard delete of a lot leaves an operator_audit_log row
--
-- WHY (2026-10-06): BIN-028904 was in_inventory with a sticker, a shelf and
-- location history. The console's "Delete lot" (lots/[id]/actions.ts
-- deleteLot) hard-deleted it: that action only checks bids and status, and
-- writes no audit row. Deleting a lot also cascades away its
-- lot_location_events, bin_assignments and lot_status_history, so the item
-- vanished with no trace at all. docs/PREFLIGHT.md already says any physical
-- footprint blocks destructive cleanup; that rule only reached migrations
-- (assert_no_physical_footprint, 0369), not the app.
--
-- WHAT: one BEFORE DELETE row trigger on lots, so every path is covered:
-- the console Delete lot (user's client), the Drafts page delete (service
-- role), any future route, a cascade from an auction or operator delete, and
-- hand-run SQL.
--   1. Refuses when the lot being deleted has its own physical evidence: the
--      same six sources 0369's _lot_physical_footprint reports
--      (sticker_code, intake_bin_id, intake_at, bin_assignments,
--      lot_location_events, lot_sticker_pool). The message starts with
--      lot_has_physical_footprint: and DETAIL carries the reasons
--      comma-separated, which the app turns into staff copy ("use Remove from
--      inventory instead").
--   2. Otherwise writes operator_audit_log (action_type lot.hard_deleted,
--      target = the lot, before_state = the whole row, actor) and lets the
--      delete go ahead. The insert is in the delete's transaction: a delete
--      that fails later rolls its audit row back with it.
--
-- WHY OWN-ROW, NOT 0369'S FAMILY TRAVERSAL: 0369 walks the relot family
-- because a migration deletes batches and lineage tells a reviewer what is
-- linked. A row trigger only has to promise that no row carrying evidence is
-- ever deleted, and checking each row's own evidence does exactly that (in a
-- multi-row delete, each row is checked). The traversal would also refuse a
-- bare row for a relative's sticker, and raise lineage errors mid-statement
-- when a parent was deleted earlier in the same statement.
--
-- ACTOR: auth.uid() for a user's request. The Drafts page deletes with the
-- service role, so for a service_role request the trigger also accepts the
-- x-bingo-actor request header (set by that server action), only when it is
-- a real auth.users id. Direct SQL has no actor; after_state.via records the
-- database role, so those rows are still recognisable.
--
-- CONCURRENCY: the executor locks the lot row before a BEFORE DELETE trigger
-- runs, so a concurrent sticker claim / intake (UPDATE of the row, or an FK
-- insert into lot_location_events / bin_assignments) either committed before
-- the lock and is seen here, or waits for this transaction and then fails
-- its FK against the deleted row.
--
-- NO BYPASS FLAG (PREFLIGHT: "no blanket bypass flag"). Removing a lot that
-- has a footprint goes through Remove from inventory (0319,
-- remove_lot_from_inventory), which keeps the row. A deliberate DBA removal
-- is ALTER TABLE ... DISABLE TRIGGER in a reviewed migration, which leaves
-- that trace.
--
-- LOCK: CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE on public.lots
-- for the length of this transaction. It blocks INSERT/UPDATE/DELETE on lots
-- (place_bid's lot update included), not reads. The statement itself is
-- instant; the risk is the wait behind a long writer, hence lock_timeout.
-- Window: 05:00-07:00 CT (CLAUDE.md Rule 9, database locks on lots).
--
-- Additive except for behaviour: deleting a lot with a footprint now fails
-- (console Delete lot and Drafts delete both map the error to staff copy).
-- On 2026-10-07, 1401 of 1725 pending_intake drafts carried a sticker, so
-- the Drafts page delete will refuse those; staff use Remove from inventory.
--
-- Rollback: 0400_ROLLBACK (DROP TRIGGER lots_guard_hard_delete_trg ON
-- public.lots; DROP FUNCTION public.lots_guard_hard_delete();). DROP TRIGGER
-- takes ACCESS EXCLUSIVE on lots, so roll back in the same window. Audit rows
-- already written stay.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.lots_guard_hard_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reasons text[];
  v_actor   uuid;
  v_role    text;
  v_header  text;
BEGIN
  SELECT coalesce(array_agg(r.reason), '{}'::text[]) INTO v_reasons
  FROM (
    SELECT 'sticker_code'::text AS reason WHERE OLD.sticker_code IS NOT NULL
    UNION ALL
    SELECT 'intake_bin_id' WHERE OLD.intake_bin_id IS NOT NULL
    UNION ALL
    SELECT 'intake_at' WHERE OLD.intake_at IS NOT NULL
    UNION ALL
    SELECT 'bin_assignments' WHERE EXISTS (
      SELECT 1 FROM public.bin_assignments AS b WHERE b.lot_id = OLD.id)
    UNION ALL
    SELECT 'lot_location_events' WHERE EXISTS (
      SELECT 1 FROM public.lot_location_events AS e WHERE e.lot_id = OLD.id)
    UNION ALL
    SELECT 'lot_sticker_pool' WHERE EXISTS (
      SELECT 1 FROM public.lot_sticker_pool AS s WHERE s.claimed_by_lot_id = OLD.id)
  ) AS r;

  IF cardinality(v_reasons) > 0 THEN
    RAISE EXCEPTION 'lot_has_physical_footprint: % cannot be deleted (%)',
      coalesce(OLD.lot_code, OLD.id::text), array_to_string(v_reasons, ', ')
      USING ERRCODE = 'P0001',
            DETAIL  = array_to_string(v_reasons, ','),
            HINT    = 'Use Remove from inventory on the lot page instead of deleting it.';
  END IF;

  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role');
  v_actor := auth.uid();
  IF v_actor IS NULL AND v_role = 'service_role' THEN
    v_header := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-bingo-actor';
    IF v_header ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      SELECT u.id INTO v_actor FROM auth.users AS u WHERE u.id = v_header::uuid;
    END IF;
  END IF;

  -- In an operator-delete cascade the operator row is already gone, and the
  -- audit table cascades away with it anyway.
  IF EXISTS (SELECT 1 FROM public.operators AS o WHERE o.id = OLD.operator_id) THEN
    INSERT INTO public.operator_audit_log
      (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
    VALUES
      (OLD.operator_id, v_actor, 'lot.hard_deleted', OLD.id,
       to_jsonb(OLD),
       jsonb_build_object('deleted', true, 'via', coalesce(v_role, session_user::text)),
       'hard delete of ' || coalesce(OLD.lot_code, OLD.id::text) || ' (status ' || OLD.status::text || ', no physical footprint)');
  END IF;

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.lots_guard_hard_delete() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE TRIGGER lots_guard_hard_delete_trg
  BEFORE DELETE ON public.lots
  FOR EACH ROW
  EXECUTE FUNCTION public.lots_guard_hard_delete();

COMMENT ON FUNCTION public.lots_guard_hard_delete() IS
  '0400: refuses a hard delete of a lot with its own physical evidence (sticker, shelf, intake, '
  'bin assignment, location events, claimed sticker pool) and writes operator_audit_log '
  '(lot.hard_deleted) for every delete it allows. Footprint lots go through '
  'remove_lot_from_inventory (0319) instead.';

COMMIT;
