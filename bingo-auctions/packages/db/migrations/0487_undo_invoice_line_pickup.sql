-- 0487 — undo_invoice_line_pickup(): a console "Undo pickup" for one line,
--        ADMIN only, reason required, audited. Moves no money.
--
-- WHY
--
-- The console can only ever MARK a line picked up: manager_pickup_override
-- (0256) and the scan path both set invoice_lots.picked_up_at and never clear
-- it. The one thing that ever cleared the stamp was a hard-coded one-off
-- migration per lot (0399). So when someone marks the wrong line, the floor is
-- stuck: the customer's item disappears from the owed list, the no-show sweep
-- and the pickup emails stop making sense, and the only tool is a bespoke
-- migration. #702 (TEA3828564) is exactly that: marked picked up by mistake,
-- the box still on the shelf.
--
-- Owner decision 2026-11-03 (Braden, via #706): an "undo pickup" action in the
-- console, admin only, reason required, logged, with a rollback and a RED TEAM
-- pass. #707 asked for staff+admin; #706 (approved later, same day) narrows it
-- to admin, and this migration follows #706.
--
-- WHAT
--
-- public.undo_invoice_line_pickup(p_invoice_id, p_lot_id, p_reason) RETURNS jsonb
--
--   p_reason  why, at least 5 characters after trimming
--
-- In ONE transaction:
--   1. clears invoice_lots.picked_up_at for that one line;
--   2. puts the line's bin_assignment back to 'staged' — but only the lot's
--      LATEST assignment, and only while that row is still 'picked_up' (the
--      exact row 0256/0217 flipped). An older picked_up row, or a lot that has
--      since been re-staged or moved, is left alone. The exact prior row state
--      is recorded in the audit row so a later restore can put it back;
--   3. removes the wrong "collected" outcome (0243) and the customer's pickup
--      pass tick (0241 collected_lot_ids) for this line. Leaving either behind
--      would keep the item out of the pickup pass (and the tick would still
--      block a relist through 0356) even though the line is owed again;
--   4. reopens the pickups row: 'completed' -> 'checked_in', completed_at
--      cleared, checked_in_at kept (the customer did show up; the line did not
--      go home). The 0356 completion trigger only fires on the transition INTO
--      'completed', so demoting the row cannot re-stamp other lines;
--   5. writes operator_audit_log 'invoice_line.pickup_undone' (target_id =
--      invoice id, like refunds, forfeits and the override): who (account),
--      when, why, and the old picked_up_at, pickup status/timestamps, bin
--      assignment, removed outcomes and removed session ticks.
--
-- REFUSES (returns {ok:false, code}, changes nothing):
--   forbidden          caller is not an ADMIN of the invoice's operator
--                      (unlike 0256/0444 there is no manager path — #706)
--   reason_required    reason shorter than 5 characters
--   not_found          no such line on this invoice
--   invoice_not_paid   invoice not paid / partially_refunded
--   refunded           the line was refunded — the money already went back.
--                      Correcting the HISTORY of a refunded line (the #702
--                      invoice) is deliberately not this tool: it needs a
--                      separate Braden/Jared-approved workflow, because the
--                      line is no longer owed and its money is settled.
--   lot_status         the lot is not 'won' (relisted, in inventory, scheduled,
--                      canceled, sold to someone else)
--   relist_child_live  the item was relisted and a relist lot (any generation)
--                      is still alive, so the box is listed again
--   pickup_closed      the visit is already 'no_show' or 'forfeited'. Those
--                      rows are terminal/history (0351/0444) and a line put
--                      back on one would not return to the pickup pass. Undo
--                      the line's forfeit instead, or ask for a human decision.
--   pickup_expired     the pickup window (auction pickup_ends_at or the
--                      scheduled time, operator grace, membership extension —
--                      exactly the 0183 deadline) has already passed. Reopening
--                      it would hand the line straight to the no-show sweep
--                      (0337 now includes 'checked_in'), which can forfeit it,
--                      send no-show notices and enqueue refunds without a
--                      person deciding. A later/held-window decision is needed.
--
-- ALREADY UNDONE (returns {ok:true, already_undone:true}, writes nothing)
--   picked_up_at IS NULL. A double click is a no-op, not an error.
--
-- FORFEITED LINES ARE ALLOWED (returns forfeit_remains:true)
--   A line can be both forfeited (no-show sweep) and picked up (0256's
--   forfeited-not-resold path). #707 said refuse those, but 0444's undo
--   forfeit refuses a line that is already picked up, so refusing here as well
--   would leave the pair with no way out in either direction. Clearing the
--   wrong stamp first puts the line back to 'Forfeited', and the existing
--   Undo forfeit panel then handles the forfeit itself.
--
-- Not changed: invoice totals, payment state, refunded_cash_cents, or the
-- credit ledger. Undoing a pickup never moves money; a refund still goes
-- through /api/invoices/[id]/refund-items and its own checks. No notification
-- is sent — nothing was handed over, so there is nothing to un-confirm.
--
-- CONCURRENCY
--   A pickup can complete while this runs (the counter scanning a sibling
--   line). A BEFORE UPDATE trigger on pickups re-checks any line this function
--   put back: if such a line is still owed when a writer tries to mark the
--   pickup 'completed', the trigger keeps the pickup 'checked_in' instead of
--   silently re-stamping it through 0356. The trigger and this function share a
--   transaction advisory lock keyed by invoice id so the check runs after the
--   undo has committed.
--
-- ROLLBACK: scripts/prod-rig/0487_ROLLBACK_undo_invoice_line_pickup.sql drops
-- the function. It also accepts `-v restore_audit_id=<audit id>` to restore one
-- undone line, its exact bin row/timestamp, removed outcomes/session ticks and
-- (only when nothing else is owed) the pickup's prior completed state from the
-- audit row, all guarded and in one transaction.

SET lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.undo_invoice_line_pickup(
  p_invoice_id uuid,
  p_lot_id     uuid,
  p_reason     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid          uuid := auth.uid();
  v_staff        record;
  v_line         record;
  v_lot          record;
  v_pickup       record;
  v_child        record;
  v_bin          record;
  v_reason       text := btrim(coalesce(p_reason, ''));
  v_pickup_after text;
  v_bin_reverted boolean := false;
  v_removed_outcomes jsonb := '[]'::jsonb;
  v_removed_sessions jsonb := '[]'::jsonb;
  v_outcome_n    int := 0;
  v_session_n    int := 0;
  v_n            int;
BEGIN
  SELECT operator_id, role::text AS role INTO v_staff
    FROM operator_users WHERE user_id = v_uid LIMIT 1;
  IF v_uid IS NULL OR NOT FOUND OR v_staff.role <> 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;
  IF length(v_reason) < 5 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'reason_required');
  END IF;

  SELECT il.forfeited_at, il.refunded_at, il.picked_up_at,
         i.operator_id, i.bidder_id, i.status::text AS inv_status, i.paid_at
    INTO v_line
    FROM invoice_lots il JOIN invoices i ON i.id = il.invoice_id
   WHERE il.invoice_id = p_invoice_id AND il.lot_id = p_lot_id
   FOR UPDATE OF il;
  IF NOT FOUND OR v_line.operator_id IS DISTINCT FROM v_staff.operator_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF v_line.paid_at IS NULL OR v_line.inv_status NOT IN ('paid', 'partially_refunded') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invoice_not_paid');
  END IF;
  IF v_line.refunded_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'refunded');
  END IF;

  -- Double click / stale page: nothing to clear, nothing written.
  IF v_line.picked_up_at IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_undone', true, 'reverted', false);
  END IF;

  SELECT id, lot_code, status::text AS status INTO v_lot
    FROM lots WHERE id = p_lot_id FOR UPDATE;

  -- Any relist descendant still alive means the box is listed again: it
  -- cannot be "still owed" to this customer while it is up for sale.
  WITH RECURSIVE kin AS (
    SELECT c.id, c.lot_code, c.status::text AS status, c.auction_id, c.deleted_at, 1 AS depth
      FROM lots c WHERE c.relisted_from_lot_id = p_lot_id
    UNION ALL
    SELECT g.id, g.lot_code, g.status::text, g.auction_id, g.deleted_at, k.depth + 1
      FROM lots g JOIN kin k ON g.relisted_from_lot_id = k.id
     WHERE k.depth < 10
  )
  SELECT lot_code, status, auction_id INTO v_child
    FROM kin
   WHERE deleted_at IS NULL AND status <> 'canceled'
   ORDER BY depth
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'relist_child_live',
      'child_lot_code', v_child.lot_code, 'child_status', v_child.status,
      'child_auction_id', v_child.auction_id);
  END IF;

  IF v_lot.status <> 'won' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'lot_status', 'lot_status', v_lot.status);
  END IF;

  -- Lock the visit BEFORE reading its status; the 0183 deadline is computed
  -- with the same grace + membership terms the no-show sweep uses.
  SELECT p.id, p.status::text AS status, p.scheduled_at, p.checked_in_at,
         p.completed_at, p.completed_by, p.warehouse_id,
         COALESCE(p.scheduled_at, a.pickup_ends_at)
           + (COALESCE(o.pickup_grace_extension_hours, 24) * INTERVAL '1 hour')
           + (COALESCE((
                SELECT max(COALESCE(opp.extended_pickup_days, 0))
                  FROM bidder_subscriptions bs
                  JOIN operator_pro_plans opp ON opp.id = bs.plan_id
                 WHERE bs.bidder_id = i.bidder_id
                   AND bs.operator_id = i.operator_id
                   AND bs.status IN ('active', 'trialing')
                   AND (bs.current_period_end IS NULL OR bs.current_period_end > now())
              ), 0) * 24) * INTERVAL '1 hour' AS effective_deadline
    INTO v_pickup
    FROM pickups p
    JOIN invoices i ON i.id = p.invoice_id
    JOIN auctions a ON a.id = i.auction_id
    JOIN operators o ON o.id = i.operator_id
   WHERE p.invoice_id = p_invoice_id
   ORDER BY p.created_at DESC
   LIMIT 1
   FOR UPDATE OF p;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pickup_missing');
  END IF;

  -- Share the invoice-scoped advisory lock with the completion guard trigger,
  -- so a concurrent completion cannot stamp this line back after we clear it.
  -- Taken after the pickups row lock, matching the trigger's lock order.
  PERFORM pg_advisory_xact_lock(hashtextextended('0487_pickup:' || p_invoice_id::text, 0));

  IF v_pickup.status IN ('no_show', 'forfeited') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pickup_closed',
      'pickup_status', v_pickup.status);
  END IF;
  IF v_pickup.effective_deadline IS NOT NULL AND v_pickup.effective_deadline < now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pickup_expired',
      'pickup_status', v_pickup.status,
      'pickup_deadline', v_pickup.effective_deadline);
  END IF;

  v_pickup_after := v_pickup.status;

  -- Capture the exact bin row before flipping it, so a restore can put the
  -- same row and timestamp back instead of reconstructing one.
  SELECT id, status::text AS status, picked_up_at INTO v_bin
    FROM bin_assignments
   WHERE lot_id = p_lot_id
   ORDER BY assigned_at DESC
   LIMIT 1;

  UPDATE invoice_lots SET picked_up_at = NULL
   WHERE invoice_id = p_invoice_id AND lot_id = p_lot_id
     AND picked_up_at = v_line.picked_up_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0487: expected 1 line, updated %', v_n;
  END IF;

  -- Flip ONLY the lot's latest assignment, and only while it is still the
  -- pickup row — the mirror image of 0256's staged -> picked_up flip.
  UPDATE bin_assignments ba
     SET status = 'staged', picked_up_at = NULL
   WHERE ba.id = (
           SELECT a.id FROM bin_assignments a
            WHERE a.lot_id = p_lot_id
            ORDER BY a.assigned_at DESC
            LIMIT 1
         )
     AND ba.status = 'picked_up';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_bin_reverted := v_n > 0;

  -- The wrong hand-over records must go with the stamp: a 'collected' outcome
  -- hides the item on the pickup pass, and a session tick still blocks a
  -- relist (0356). Only THIS lot's collected outcome is removed; a sibling's
  -- stays.
  WITH removed AS (
    DELETE FROM pickup_lot_outcomes o
     USING pickups pu
     WHERE pu.invoice_id = p_invoice_id
       AND o.pickup_id = pu.id
       AND o.lot_id = p_lot_id
       AND o.outcome = 'collected'
    RETURNING o.pickup_id, o.lot_id, o.outcome, o.note, o.decided_by,
              o.created_at, o.decided_at
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(removed)), '[]'::jsonb), count(*)
    INTO v_removed_outcomes, v_outcome_n
    FROM removed;

  WITH unticked AS (
    UPDATE pickup_sessions ps
       SET collected_lot_ids = array_remove(ps.collected_lot_ids, p_lot_id)
     WHERE ps.bidder_id = v_line.bidder_id
       AND ps.collected_lot_ids @> ARRAY[p_lot_id]
    RETURNING ps.id, ps.status::text AS status
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(unticked)), '[]'::jsonb), count(*)
    INTO v_removed_sessions, v_session_n
    FROM unticked;

  IF v_pickup.status = 'completed' THEN
    UPDATE pickups
       SET status        = 'checked_in',
           completed_at  = NULL,
           completed_by  = NULL,
           checked_in_at = COALESCE(checked_in_at, now()),
           updated_at    = now()
     WHERE id = v_pickup.id;
    v_pickup_after := 'checked_in';
  END IF;

  INSERT INTO operator_audit_log
    (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note, created_at)
  VALUES
    (v_line.operator_id, v_uid, 'invoice_line.pickup_undone', p_invoice_id,
     jsonb_build_object('lot_id', p_lot_id, 'lot_code', v_lot.lot_code,
                        'picked_up_at', v_line.picked_up_at,
                        'pickup_id', v_pickup.id,
                        'pickup_status', v_pickup.status,
                        'pickup_scheduled_at', v_pickup.scheduled_at,
                        'pickup_checked_in_at', v_pickup.checked_in_at,
                        'pickup_completed_at', v_pickup.completed_at,
                        'pickup_completed_by', v_pickup.completed_by,
                        'pickup_deadline', v_pickup.effective_deadline,
                        'forfeited_at', v_line.forfeited_at,
                        'lot_status', v_lot.status,
                        'bin_assignment', CASE WHEN v_bin.id IS NULL THEN NULL ELSE
                          jsonb_build_object('id', v_bin.id, 'status', v_bin.status,
                                             'picked_up_at', v_bin.picked_up_at) END,
                        'removed_collected_outcomes', v_removed_outcomes,
                        'removed_session_ticks', v_removed_sessions),
     jsonb_build_object('lot_id', p_lot_id, 'picked_up_at', NULL,
                        'pickup_status', v_pickup_after,
                        'bin_assignment_reverted', v_bin_reverted,
                        'collected_outcomes_removed', v_outcome_n,
                        'session_ticks_removed', v_session_n,
                        'lot_status', v_lot.status),
     v_reason,
     -- Event time, not transaction-start time: a session that began earlier
     -- but undid later must still rank as the newer undo (#798).
     clock_timestamp());

  RETURN jsonb_build_object(
    'ok', true,
    'reverted', true,
    'already_undone', false,
    'lot_code', v_lot.lot_code,
    'old_picked_up_at', v_line.picked_up_at,
    'pickup_status', v_pickup_after,
    'pickup_deadline', v_pickup.effective_deadline,
    'bin_assignment_reverted', v_bin_reverted,
    'collected_outcomes_removed', v_outcome_n,
    'session_ticks_removed', v_session_n,
    'forfeit_remains', v_line.forfeited_at IS NOT NULL
  );
END;
$function$;

COMMENT ON FUNCTION public.undo_invoice_line_pickup(uuid, uuid, text) IS
  '0487: clears one line''s pickup stamp so the item is owed again. ADMIN only '
  '(#706), reason of at least 5 characters required, audited as '
  'invoice_line.pickup_undone with the prior bin row, pickup timestamps, '
  'removed collected outcome and removed pickup-pass ticks. Puts the lot''s '
  'latest bin assignment back to staged and reopens a completed pickup as '
  'checked_in. Refuses refunded lines, lots that are no longer ''won'', lots '
  'with a live relist, closed (no_show/forfeited) visits, and visits whose '
  '0183 pickup deadline has already passed. A forfeited line is allowed so '
  '0444''s undo forfeit can run next. Moves no money and sends no notification.';

-- ── WHEN was an outcome decided? ─────────────────────────────────────────
--
-- 0243's pickup_lot_outcomes only had created_at, and the console's
-- setLotOutcome UPSERTs on (pickup_id, lot_id): changing an existing
-- 'missing'/'left_behind' row to 'collected' keeps the original created_at.
-- The completion guard below needs to know whether a collected outcome is a
-- LATER handover than the undo, so a decision timestamp that moves on every
-- real change is required (#796).
--
-- decided_at is backfilled from created_at for existing rows. The stamping
-- trigger lives in the database, not only in the app: the deployed JS keeps
-- UPSERTing without this column until its OTA ships, and a future writer
-- must not be able to reintroduce the stale-timestamp bug. An idempotent
-- UPSERT that repeats the same outcome/decider/note is not a new handover
-- and does not move the stamp.
ALTER TABLE public.pickup_lot_outcomes
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

UPDATE public.pickup_lot_outcomes
   SET decided_at = created_at
 WHERE decided_at IS NULL;

ALTER TABLE public.pickup_lot_outcomes
  ALTER COLUMN decided_at SET DEFAULT clock_timestamp();

ALTER TABLE public.pickup_lot_outcomes
  ALTER COLUMN decided_at SET NOT NULL;

CREATE OR REPLACE FUNCTION public.pickup_lot_outcomes_stamp_decided_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.decided_at := COALESCE(NEW.decided_at, clock_timestamp());
  ELSIF NEW.outcome   IS DISTINCT FROM OLD.outcome
     OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
     OR NEW.note       IS DISTINCT FROM OLD.note THEN
    -- Event time, not transaction-start time: two sessions can begin in an
    -- order opposite to the order in which they actually decide things (#798).
    NEW.decided_at := clock_timestamp();
  ELSE
    -- Identical UPSERT (same outcome/decider/note). The database is the
    -- authority: ignore any caller-supplied timestamp so a repeated write
    -- cannot refresh a stale decision and fool the completion guard (#798).
    NEW.decided_at := OLD.decided_at;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS pickup_lot_outcomes_stamp_decided_at_trg ON public.pickup_lot_outcomes;
CREATE TRIGGER pickup_lot_outcomes_stamp_decided_at_trg
  BEFORE INSERT OR UPDATE ON public.pickup_lot_outcomes
  FOR EACH ROW
  EXECUTE FUNCTION public.pickup_lot_outcomes_stamp_decided_at();

COMMENT ON COLUMN public.pickup_lot_outcomes.decided_at IS
  '0487: when this outcome was (last) actually decided, from clock_timestamp() '
  '(event time, not transaction start). created_at is the row''s first insert '
  'and an UPSERT does not move it; decided_at is bumped by '
  'pickup_lot_outcomes_stamp_decided_at() whenever outcome/decided_by/note '
  'change, and restored to the old value on an identical UPSERT, so 0487''s '
  'completion guard can tell a later handover from a stale record (#798).';

-- A concurrent completion must not silently re-stamp a line that this
-- function just put back. The guard is scoped to lines that still carry an
-- 'invoice_line.pickup_undone' audit row and are owed right now, so ordinary
-- completion (0356, console, legacy bidder confirm) is untouched.
--
-- A FRESH explicit 'collected' outcome is the exception: the undo deletes the
-- wrong one, so any collected outcome DECIDED on this visit after that undo
-- is a person saying the box did leave the counter on a later handover. The
-- completion must be allowed to proceed, and 0356's AFTER trigger then stamps
-- the line, so the sweep cannot reclaim it afterwards.
CREATE OR REPLACE FUNCTION public.pickups_guard_undone_lines_on_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owed int;
BEGIN
  IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') THEN
    -- Wait for an in-flight undo on this invoice to commit (same key as 0487).
    PERFORM pg_advisory_xact_lock(hashtextextended('0487_pickup:' || NEW.invoice_id::text, 0));

    SELECT count(*) INTO v_owed
      FROM invoice_lots il
     WHERE il.invoice_id = NEW.invoice_id
       AND il.picked_up_at IS NULL
       AND il.refunded_at IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM pickup_lot_outcomes o
              WHERE o.pickup_id = NEW.id
                AND o.lot_id = il.lot_id
                AND o.outcome IN ('missing', 'left_behind')
           )
       -- A collected outcome DECIDED after the most recent undo of THIS line
       -- is a later, deliberate handover: not owed, let completion stamp it.
       AND NOT EXISTS (
             SELECT 1 FROM pickup_lot_outcomes o
              WHERE o.pickup_id = NEW.id
                AND o.lot_id = il.lot_id
                AND o.outcome = 'collected'
                AND o.decided_at >= (
                      SELECT a.created_at FROM operator_audit_log a
                       WHERE a.action_type = 'invoice_line.pickup_undone'
                         AND a.target_id = NEW.invoice_id
                         AND a.before_state->>'lot_id' = il.lot_id::text
                       ORDER BY a.created_at DESC, a.id DESC
                       LIMIT 1
                    )
           )
       AND EXISTS (
             SELECT 1 FROM operator_audit_log a
              WHERE a.action_type = 'invoice_line.pickup_undone'
                AND a.target_id = NEW.invoice_id
                AND a.before_state->>'lot_id' = il.lot_id::text
           );

    IF v_owed > 0 THEN
      NEW.status       := 'checked_in';
      NEW.completed_at := NULL;
      NEW.completed_by := NULL;
      RAISE NOTICE
        '0487: pickup % kept checked_in — % undone line(s) are still owed',
        NEW.id, v_owed;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.pickups_guard_undone_lines_on_complete() IS
  '0487: refuses to leave a pickup completed while a line reopened by '
  'undo_invoice_line_pickup() is still owed. Scoped to lines carrying an '
  'invoice_line.pickup_undone audit row; keeps the row checked_in instead of '
  'letting 0356''s completion trigger re-stamp them. A fresh explicit '
  'collected outcome recorded after that undo is a later handover and does not '
  'block completion.';

DROP TRIGGER IF EXISTS pickups_guard_undone_lines_trg ON public.pickups;
CREATE TRIGGER pickups_guard_undone_lines_trg
  BEFORE UPDATE OF status ON public.pickups
  FOR EACH ROW
  EXECUTE FUNCTION public.pickups_guard_undone_lines_on_complete();

REVOKE ALL ON FUNCTION public.undo_invoice_line_pickup(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.undo_invoice_line_pickup(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.undo_invoice_line_pickup(uuid, uuid, text) TO authenticated, service_role;

-- ── The two completion RPCs must not announce a completion that the guard
--    refused ───────────────────────────────────────────────────────────────
--
-- Both RPCs count owed lines, then UPDATE pickups to 'completed', then queue
-- 'pickup_confirmed'. The guard above is a BEFORE trigger: it can keep the row
-- 'checked_in' (a line undone from this visit is still owed), so the RPC's
-- cached "remaining = 0" is not the persisted outcome. A concurrent undo that
-- commits between the count and the UPDATE is exactly that race (#796): the
-- RPC used to return completed and queue a "your pickup is complete" notice
-- while the counter still owed items.
--
-- Both now read the persisted status back and only queue the notification when
-- it really became 'completed'. A blocked completion is reported as a partial
-- round instead (warning / remaining_count), matching the console action.

CREATE OR REPLACE FUNCTION staff_confirm_pickup(
  p_invoice_id        UUID,
  p_lot_codes         TEXT[],
  p_allow_incomplete  BOOLEAN DEFAULT FALSE
)
RETURNS staff_confirm_pickup_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user           UUID := auth.uid();
  v_operator       UUID;
  v_invoice        invoices%ROWTYPE;
  v_pickup         pickups%ROWTYPE;
  v_lot_id         UUID;
  v_lot_code       TEXT;
  v_already_picked INT := 0;
  v_not_found_ct   INT := 0;
  v_picked_ct      INT := 0;
  v_missing        TEXT[];
  v_remaining_ct   INT := 0;
  v_pickup_after   TEXT;
  v_warning        TEXT := NULL;
  v_result         staff_confirm_pickup_result;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT operator_id INTO v_operator
    FROM operator_users WHERE user_id = v_user LIMIT 1;
  IF v_operator IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff';
  END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found';
  END IF;
  IF v_invoice.operator_id <> v_operator THEN
    RAISE EXCEPTION 'invoice_other_operator';
  END IF;
  -- 0245: partially_refunded = paid invoice with some items refunded; the
  -- rest are still owed and must remain collectable at the counter.
  IF v_invoice.status NOT IN ('paid', 'partially_refunded') THEN
    RAISE EXCEPTION 'invoice_not_paid';
  END IF;

  SELECT * INTO v_pickup FROM pickups WHERE invoice_id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pickup_not_found';
  END IF;

  -- Idempotency (unchanged from 0147).
  IF v_pickup.status = 'completed' THEN
    v_result := (
      v_pickup.id,
      (SELECT count(*) FROM bin_assignments ba
       JOIN invoice_lots il ON il.lot_id = ba.lot_id
       WHERE il.invoice_id = p_invoice_id AND ba.status = 'picked_up'),
      'already_completed',
      ARRAY[]::TEXT[]
    );
    RETURN v_result;
  END IF;

  -- ── Missing = invoice lots not stamped yet and not in this round ──────
  -- 0217: keyed off invoice_lots.picked_up_at (round-stable) instead of
  -- bin_assignments (which never covers never-staged manual-checkout lots).
  -- 0245: refunded lots are not owed — never count them as missing.
  -- 0304: a supplied code may be the box's sticker label, not the lot_code.
  SELECT COALESCE(array_agg(l.lot_code ORDER BY l.lot_code), ARRAY[]::TEXT[])
    INTO v_missing
  FROM invoice_lots il
  JOIN lots l ON l.id = il.lot_id
  WHERE il.invoice_id = p_invoice_id
    AND il.picked_up_at IS NULL
    AND il.refunded_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM unnest(COALESCE(p_lot_codes, ARRAY[]::TEXT[])) AS scanned(code)
      WHERE upper(TRIM(scanned.code)) = upper(l.lot_code)
         OR upper(TRIM(scanned.code)) = upper(split_part(l.sticker_code, ':', 2))
    );

  IF array_length(v_missing, 1) > 0 AND NOT COALESCE(p_allow_incomplete, FALSE) THEN
    -- Money-loss guard (0147): refuse until the caller explicitly opts into
    -- a partial handover. DETAIL carries the missing codes for the client
    -- confirm dialog.
    RAISE EXCEPTION 'pickup_incomplete: %', array_to_string(v_missing, ',')
      USING DETAIL = array_to_string(v_missing, ',');
  END IF;

  -- ── Per-lot flip ──────────────────────────────────────────────────────
  FOREACH v_lot_code IN ARRAY p_lot_codes
  LOOP
    -- 0304: same two-column, case-insensitive match as the missing-set above.
    SELECT l.id INTO v_lot_id
    FROM lots l
    JOIN invoice_lots il ON il.lot_id = l.id
    WHERE il.invoice_id = p_invoice_id
      AND (
        upper(TRIM(v_lot_code)) = upper(l.lot_code)
        OR upper(TRIM(v_lot_code)) = upper(split_part(l.sticker_code, ':', 2))
      )
    LIMIT 1;

    IF NOT FOUND THEN
      v_not_found_ct := v_not_found_ct + 1;
      CONTINUE;
    END IF;

    -- 0217: the authoritative per-lot handover stamp (idempotent).
    -- 0245: also record WHO confirmed the handover.
    UPDATE invoice_lots
       SET picked_up_at = now(),
           picked_up_by = v_user
     WHERE invoice_id = p_invoice_id
       AND lot_id = v_lot_id
       AND picked_up_at IS NULL;

    IF FOUND THEN
      v_picked_ct := v_picked_ct + 1;
    ELSE
      v_already_picked := v_already_picked + 1;
    END IF;

    -- Staging-board state (unchanged from 0147): flip the latest STAGED
    -- assignment; never-staged lots simply have no row to flip.
    WITH latest AS (
      SELECT ba.id
      FROM bin_assignments ba
      WHERE ba.lot_id = v_lot_id
      ORDER BY ba.assigned_at DESC
      LIMIT 1
    )
    UPDATE bin_assignments ba
       SET status = 'picked_up', picked_up_at = now()
      FROM latest
     WHERE ba.id = latest.id
       AND ba.status = 'staged';
  END LOOP;

  -- ── Complete or keep open ─────────────────────────────────────────────
  -- 0245: refunded lots are resolved, not owed.
  SELECT count(*) INTO v_remaining_ct
  FROM invoice_lots
  WHERE invoice_id = p_invoice_id
    AND picked_up_at IS NULL
    AND refunded_at IS NULL;

  IF v_remaining_ct = 0 THEN
    -- #796: read the persisted row back. 0487's BEFORE trigger can keep this
    -- 'checked_in' when a line undone from this visit is still owed (a
    -- concurrent undo can commit after the count above).
    UPDATE pickups
       SET checked_in_at = COALESCE(checked_in_at, now()),
           completed_at  = now(),
           completed_by  = v_user,
           status        = 'completed',
           updated_at    = now()
     WHERE id = v_pickup.id
    RETURNING status::text INTO v_pickup_after;

    IF v_pickup_after = 'completed' THEN
      -- Notification only on FULL completion — a partial handover happened
      -- face-to-face; pinging "pickup confirmed" while lots are still owed
      -- misled bidders (and my-bids keys off the completed pickup).
      PERFORM enqueue_notification(
        'pickup_confirmed',
        v_invoice.bidder_id,
        jsonb_build_object(
          'invoice_id', p_invoice_id,
          'lots_picked', v_picked_ct,
          'lots_missing', 0
        ),
        'pickup_confirmed:staff:' || p_invoice_id::TEXT
      );
    ELSE
      -- The guard refused: an undone line is owed again. Report the round as
      -- partial and audit it exactly like one; no completion notification.
      SELECT count(*) INTO v_remaining_ct
      FROM invoice_lots
      WHERE invoice_id = p_invoice_id
        AND picked_up_at IS NULL
        AND refunded_at IS NULL;

      INSERT INTO operator_audit_log (
        operator_id, actor_user_id, action_type, target_id, before_state, after_state
      ) VALUES (
        v_operator, v_user, 'pickup.partial_handover', p_invoice_id, NULL,
        jsonb_build_object(
          'handed_over_codes', to_jsonb(p_lot_codes),
          'handed_over_count', v_picked_ct,
          'remaining_count', v_remaining_ct,
          'completion_blocked', true
        )
      );

      v_warning := format('partial: %s lot(s) still owed — invoice stays open', v_remaining_ct);
    END IF;
  ELSE
    -- 0217: partial handover — keep the pickup ALIVE so the QR keeps
    -- resolving and the remaining lots stay owed. checked_in marks "the
    -- bidder has been here"; the 0183 no-show sweep only touches
    -- 'pending'/'scheduled' so an open partial is never forfeited.
    UPDATE pickups
       SET checked_in_at = COALESCE(checked_in_at, now()),
           status        = 'checked_in',
           updated_at    = now()
     WHERE id = v_pickup.id;

    -- Audit each partial round (definer insert; log has no client policy).
    INSERT INTO operator_audit_log (
      operator_id, actor_user_id, action_type, target_id, before_state, after_state
    ) VALUES (
      v_operator, v_user, 'pickup.partial_handover', p_invoice_id, NULL,
      jsonb_build_object(
        'handed_over_codes', to_jsonb(p_lot_codes),
        'handed_over_count', v_picked_ct,
        'remaining_count', v_remaining_ct
      )
    );

    v_warning := format('partial: %s lot(s) still owed — invoice stays open', v_remaining_ct);
  END IF;

  IF v_not_found_ct > 0 OR v_already_picked > 0 THEN
    v_warning := COALESCE(v_warning || '; ', '') || format(
      '%s lot(s) not in invoice; %s already picked up',
      v_not_found_ct, v_already_picked
    );
  END IF;

  v_result := (v_pickup.id, v_picked_ct, v_warning, COALESCE(v_missing, ARRAY[]::TEXT[]));
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_confirm_pickup(UUID, TEXT[], BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_confirm_pickup(UUID, TEXT[], BOOLEAN) TO authenticated;

COMMENT ON FUNCTION staff_confirm_pickup(UUID, TEXT[], BOOLEAN) IS
  '0245 behavior + 0487 (#796): a completion the 0487 guard keeps checked_in '
  'is reported as a partial round with no pickup_confirmed notification. '
  'Stamps invoice_lots.picked_up_at per confirmed code, completes the pickups '
  'row ONLY when every un-refunded lot is stamped, attributes the handover, '
  'and audits partial rounds.';

CREATE OR REPLACE FUNCTION manager_pickup_override(
  p_invoice_id UUID,
  p_lot_ids    UUID[] DEFAULT NULL,
  p_reason     TEXT   DEFAULT NULL,
  p_note       TEXT   DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user         UUID := auth.uid();
  v_staff        RECORD;
  v_invoice      invoices%ROWTYPE;
  v_pickup       pickups%ROWTYPE;
  v_targets      UUID[];
  v_picked       UUID[];
  v_already_ct   INT := 0;
  v_remaining_ct INT := 0;
  v_pickup_after TEXT;
  v_completed    BOOLEAN := FALSE;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  SELECT operator_id, role INTO v_staff
    FROM operator_users WHERE user_id = v_user LIMIT 1;
  IF v_staff IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_operator_staff');
  END IF;
  IF v_staff.role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'manager_or_admin_only');
  END IF;

  IF p_reason IS NULL
     OR p_reason NOT IN ('system_glitch', 'scanner_issue', 'support_approved', 'other') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_reason');
  END IF;
  IF p_reason = 'other' AND (p_note IS NULL OR btrim(p_note) = '') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'note_required_for_other');
  END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invoice_not_found');
  END IF;
  IF v_invoice.operator_id <> v_staff.operator_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invoice_other_operator');
  END IF;
  -- paid OR partially_refunded — a per-item refund leaves the rest owed
  -- (0253); an unpaid/refunded/canceled invoice must never be stamped.
  IF v_invoice.status NOT IN ('paid', 'partially_refunded') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invoice_not_paid');
  END IF;

  -- Resolve targets: explicit lot ids (validated against the invoice), or
  -- every still-owed lot. Refunded lots are never stamped — they were
  -- credited back, not handed over.
  IF p_lot_ids IS NULL OR COALESCE(array_length(p_lot_ids, 1), 0) = 0 THEN
    SELECT COALESCE(array_agg(il.lot_id), ARRAY[]::UUID[]) INTO v_targets
    FROM invoice_lots il
    WHERE il.invoice_id = p_invoice_id
      AND il.picked_up_at IS NULL
      AND il.refunded_at IS NULL;
  ELSE
    SELECT COALESCE(array_agg(il.lot_id), ARRAY[]::UUID[]) INTO v_targets
    FROM invoice_lots il
    WHERE il.invoice_id = p_invoice_id
      AND il.lot_id = ANY(p_lot_ids)
      AND il.refunded_at IS NULL;
    IF COALESCE(array_length(v_targets, 1), 0) < COALESCE(array_length(p_lot_ids, 1), 0) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'lot_not_on_invoice_or_refunded');
    END IF;
  END IF;

  -- Per-lot stamp (idempotent) — mirrors 0245 staff_confirm_pickup.
  WITH flipped AS (
    UPDATE invoice_lots
       SET picked_up_at = now()
     WHERE invoice_id = p_invoice_id
       AND lot_id = ANY(v_targets)
       AND picked_up_at IS NULL
    RETURNING lot_id
  )
  SELECT COALESCE(array_agg(lot_id), ARRAY[]::UUID[]) INTO v_picked FROM flipped;
  v_already_ct := COALESCE(array_length(v_targets, 1), 0)
                - COALESCE(array_length(v_picked, 1), 0);

  -- Staging-board state: flip each stamped lot's latest STAGED assignment.
  UPDATE bin_assignments ba
     SET status = 'picked_up', picked_up_at = now()
   WHERE ba.status = 'staged'
     AND ba.id IN (
       SELECT DISTINCT ON (a2.lot_id) a2.id
       FROM bin_assignments a2
       WHERE a2.lot_id = ANY(v_picked)
       ORDER BY a2.lot_id, a2.assigned_at DESC
     );

  -- Complete or keep open — same rule as 0245 (refunded lots don't count).
  SELECT count(*) INTO v_remaining_ct
  FROM invoice_lots
  WHERE invoice_id = p_invoice_id
    AND picked_up_at IS NULL
    AND refunded_at IS NULL;

  SELECT * INTO v_pickup FROM pickups WHERE invoice_id = p_invoice_id LIMIT 1;
  IF FOUND AND v_pickup.status <> 'completed' THEN
    IF v_remaining_ct = 0 THEN
      -- #796: read the persisted row back. The 0487 BEFORE trigger can keep
      -- this 'checked_in' when an undo committed after the count above.
      UPDATE pickups
         SET checked_in_at = COALESCE(checked_in_at, now()),
             completed_at  = now(),
             status        = 'completed',
             updated_at    = now()
       WHERE id = v_pickup.id
      RETURNING status::text INTO v_pickup_after;

      IF v_pickup_after = 'completed' THEN
        v_completed := TRUE;
        -- Same dedupe key as staff_confirm_pickup, so the bidder never gets a
        -- second "pickup confirmed" if the scan path already fired one.
        PERFORM enqueue_notification(
          'pickup_confirmed',
          v_invoice.bidder_id,
          jsonb_build_object(
            'invoice_id', p_invoice_id,
            'lots_picked', COALESCE(array_length(v_picked, 1), 0),
            'lots_missing', 0
          ),
          'pickup_confirmed:staff:' || p_invoice_id::TEXT
        );
      ELSE
        -- Guard refused: report the actual remaining count, no notification.
        SELECT count(*) INTO v_remaining_ct
        FROM invoice_lots
        WHERE invoice_id = p_invoice_id
          AND picked_up_at IS NULL
          AND refunded_at IS NULL;
      END IF;
    ELSE
      UPDATE pickups
         SET checked_in_at = COALESCE(checked_in_at, now()),
             status        = 'checked_in',
             updated_at    = now()
       WHERE id = v_pickup.id;
    END IF;
  ELSIF FOUND AND v_pickup.status = 'completed' THEN
    v_completed := TRUE;
  END IF;

  -- Audit — the whole point of this override. Definer insert; the log has
  -- no client INSERT policy (0157).
  INSERT INTO operator_audit_log (
    operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note
  ) VALUES (
    v_staff.operator_id, v_user, 'pickup.manager_override', p_invoice_id,
    jsonb_build_object('invoice_status', v_invoice.status),
    jsonb_build_object(
      'lot_ids', to_jsonb(v_picked),
      'requested_count', COALESCE(array_length(v_targets, 1), 0),
      'stamped_count', COALESCE(array_length(v_picked, 1), 0),
      'already_picked_count', v_already_ct,
      'remaining_count', v_remaining_ct,
      'pickup_completed', v_completed,
      'reason', p_reason
    ),
    COALESCE(NULLIF(btrim(p_note), ''), 'Manager pickup override: ' || p_reason)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'picked_count', COALESCE(array_length(v_picked, 1), 0),
    'already_count', v_already_ct,
    'remaining_count', v_remaining_ct,
    'pickup_completed', v_completed
  );
END;
$$;

REVOKE ALL ON FUNCTION manager_pickup_override(UUID, UUID[], TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION manager_pickup_override(UUID, UUID[], TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION manager_pickup_override(UUID, UUID[], TEXT, TEXT) IS
  '0256 manager/admin override + 0487 (#796): a completion the 0487 guard '
  'keeps checked_in returns pickup_completed=false, the real remaining_count '
  'and no pickup_confirmed notification. Stamps invoice_lots.picked_up_at, '
  'flips staged bin_assignments, completes when nothing is owed, and audits '
  'with the required reason.';
