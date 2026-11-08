-- 0376 — finalize_lot closes only live lots, and only the database may call it.
--
-- ── WHAT WAS WRONG (prod, 2026-09-29) ────────────────────────────────────────
-- 1. finalize_lot skipped only won / unsold / canceled. A lot in any other
--    status with winner_bidder_id set would be closed as 'won' (and its winner
--    notified). The close job only hands it live lots, but the function did
--    not enforce that itself — and the planned "keep for the business" status
--    must never be closable.
-- 2. finalize_lot, finalize_due_lots and finalize_scheduled_no_bid_lots were
--    EXECUTE-able by PUBLIC, anon and authenticated: anyone with the app's
--    public key could call them through PostgREST. Their only callers are the
--    pg_cron jobs, which run as postgres (finalize-due-lots every 5 s; the
--    scheduled-lot closer through advance-auction-lifecycle). No app code
--    calls any of them.
--
-- Checked before this change: pg_stat_statements since 2026-09-21 shows no
-- call to finalize_lot from anon/authenticated; lot_status_history (90 days)
-- shows no live -> won/unsold change made by a person; the only closes more
-- than 2 minutes late are 4 lots closed together by the job on 2026-09-07.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────
-- finalize_lot: an early return 'not_live' (ok = false) for any status other
-- than live, after the existing 'already_closed' branch. Everything else is
-- the prod definition verbatim. finalize_due_lots only counts reason 'won', so
-- a 'not_live' result changes nothing there.
-- Grants: EXECUTE revoked from PUBLIC, anon, authenticated on all three;
-- postgres (owner, pg_cron) and service_role keep it.
--
-- Rollback: re-grant EXECUTE to anon, authenticated; re-create finalize_lot
-- without the not_live branch (0006 / prod definition).

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.finalize_lot(p_lot_id uuid)
 RETURNS finalize_lot_result
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lot lots%ROWTYPE;
  v_result finalize_lot_result;
BEGIN
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;

  IF NOT FOUND THEN
    v_result := (false, 'lot_not_found', p_lot_id, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  IF v_lot.status IN ('won', 'unsold', 'canceled') THEN
    v_result := (true, 'already_closed', p_lot_id, v_lot.status, v_lot.close_at,
                 v_lot.winner_bidder_id, v_lot.current_bid_cents);
    RETURN v_result;
  END IF;

  -- 0376: only a live lot closes. Anything else (draft, scheduled, relisted,
  -- in_inventory, pending_intake, disposed, and any status added later such
  -- as a lot kept for the business) is left exactly as it is. Before this, a
  -- lot in such a status that still carried winner_bidder_id would have been
  -- flipped to 'won' and its winner told they won.
  IF v_lot.status <> 'live' THEN
    v_result := (false, 'not_live', p_lot_id, v_lot.status, v_lot.close_at,
                 v_lot.winner_bidder_id, v_lot.current_bid_cents);
    RETURN v_result;
  END IF;

  IF now() < v_lot.close_at THEN
    v_result := (false, 'reschedule', p_lot_id, v_lot.status, v_lot.close_at,
                 v_lot.winner_bidder_id, v_lot.current_bid_cents);
    RETURN v_result;
  END IF;

  IF v_lot.winner_bidder_id IS NOT NULL THEN
    UPDATE lots SET status = 'won', closed_at = now(), updated_at = now() WHERE id = p_lot_id;

    PERFORM enqueue_notification(
      'won',
      v_lot.winner_bidder_id,
      jsonb_build_object(
        'lot_id', p_lot_id,
        'lot_title', v_lot.title,
        'winning_bid_cents', v_lot.current_bid_cents,
        'auction_id', v_lot.auction_id
      ),
      'won:' || v_lot.winner_bidder_id || ':' || p_lot_id
    );

    v_result := (true, 'won', p_lot_id, 'won'::lot_status, v_lot.close_at,
                 v_lot.winner_bidder_id, v_lot.current_bid_cents);
  ELSE
    UPDATE lots SET status = 'unsold', closed_at = now(), updated_at = now() WHERE id = p_lot_id;
    v_result := (true, 'unsold', p_lot_id, 'unsold'::lot_status, v_lot.close_at, NULL, NULL);
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.finalize_lot(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.finalize_due_lots(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.finalize_scheduled_no_bid_lots(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_lot(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_due_lots(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_scheduled_no_bid_lots(integer) TO service_role;
