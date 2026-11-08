-- 0471 cases. Every result line starts PASS or FAIL. Seed: seed.sql.
CREATE OR REPLACE FUNCTION pg_temp.l(n int) RETURNS uuid LANGUAGE sql AS
$$ SELECT ('00000000-0000-0000-0000-00000000f' || lpad(n::text, 3, '0'))::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.u(c text) RETURNS text LANGUAGE sql AS
$$ SELECT '00000000-0000-0000-0000-0000000000' || c $$;
CREATE OR REPLACE FUNCTION pg_temp.ok(p_name text, p_cond boolean, p_detail text DEFAULT '') RETURNS text LANGUAGE sql AS
$$ SELECT CASE WHEN coalesce(p_cond, false) THEN 'PASS ' ELSE 'FAIL ' END || p_name || CASE WHEN p_detail <> '' THEN ' [' || p_detail || ']' ELSE '' END $$;
-- Run sql as role/uid, compare SQLSTATE ('ok' when no error).
CREATE OR REPLACE FUNCTION pg_temp.t(p_name text, p_role text, p_uid text, p_sql text, p_expect text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text := 'ok';
BEGIN
  BEGIN
    PERFORM set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    EXECUTE p_sql;
    RESET ROLE;
  EXCEPTION WHEN OTHERS THEN v := SQLSTATE || ' ' || left(SQLERRM, 80); RESET ROLE;
  END;
  RETURN CASE WHEN split_part(v, ' ', 1) = p_expect THEN 'PASS ' ELSE 'FAIL ' END || p_name || ' (got ' || v || ', want ' || p_expect || ')';
END $$;
CREATE TEMP TABLE out (k text PRIMARY KEY, v jsonb);
GRANT ALL ON out TO authenticated, service_role;
-- Call an RPC as staff member c (authenticated) and keep its jsonb answer.
CREATE OR REPLACE FUNCTION pg_temp.as(p_k text, p_c text, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', pg_temp.u(p_c), true);
  SET LOCAL ROLE authenticated;
  EXECUTE p_sql INTO r;
  RESET ROLE;
  INSERT INTO out VALUES (p_k, r) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
  RETURN r;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.r(p_k text) RETURNS jsonb LANGUAGE sql AS $$ SELECT v FROM out WHERE k = p_k $$;
CREATE OR REPLACE FUNCTION pg_temp.reason(p_k text) RETURNS text LANGUAGE sql AS $$ SELECT v->>'reason' FROM out WHERE k = p_k $$;

-- ── W. withdraw guards ─────────────────────────────────────────────────────
SELECT pg_temp.as('w-blank-name', 'c1', format($q$SELECT public.withdraw_lot_from_auction(%L, '  ', 'damaged')$q$, pg_temp.l(1)));
SELECT pg_temp.ok('W1 blank staff name refused', pg_temp.reason('w-blank-name') = 'staff_name_required');
SELECT pg_temp.as('w-blank-reason', 'c1', format($q$SELECT public.withdraw_lot_from_auction(%L, 'Tim', '')$q$, pg_temp.l(1)));
SELECT pg_temp.ok('W2 blank reason refused', pg_temp.reason('w-blank-reason') = 'reason_required');
SELECT pg_temp.as('w-picker', 'c3', format($q$SELECT public.withdraw_lot_from_auction(%L, 'Tim', 'damaged')$q$, pg_temp.l(1)));
SELECT pg_temp.ok('W3 picker refused', pg_temp.reason('w-picker') = 'admin_or_manager_required');
SELECT pg_temp.as('w-other-op', 'c4', format($q$SELECT public.withdraw_lot_from_auction(%L, 'Tim', 'damaged')$q$, pg_temp.l(1)));
SELECT pg_temp.ok('W4 admin of another operator refused', pg_temp.reason('w-other-op') = 'lot_other_operator');
SELECT pg_temp.as('w-won', 'c1', format($q$SELECT public.withdraw_lot_from_auction(%L, 'Tim', 'damaged')$q$, pg_temp.l(3)));
SELECT pg_temp.ok('W5 won lot refused', pg_temp.reason('w-won') = 'lot_won');
SELECT pg_temp.as('w-invoiced', 'c1', format($q$SELECT public.withdraw_lot_from_auction(%L, 'Tim', 'damaged')$q$, pg_temp.l(4)));
SELECT pg_temp.ok('W6 lot on an open invoice refused', pg_temp.reason('w-invoiced') = 'lot_on_invoice');
SELECT pg_temp.as('w-inv', 'c1', format($q$SELECT public.withdraw_lot_from_auction(%L, 'Tim', 'damaged')$q$, pg_temp.l(5)));
SELECT pg_temp.ok('W7 lot not in an open auction refused', pg_temp.reason('w-inv') = 'lot_not_in_open_auction');
SELECT pg_temp.t('W8 anon cannot withdraw', 'anon', NULL, format($q$SELECT public.withdraw_lot_from_auction(%L, 'T', 'R')$q$, pg_temp.l(1)), '42501');
SELECT pg_temp.ok('W9 refused calls changed nothing', (SELECT status = 'live' AND auction_id IS NOT NULL FROM lots WHERE id = pg_temp.l(1))
  AND NOT EXISTS (SELECT 1 FROM lot_withdrawals));

-- ── X. withdraw a live lot with bids (manager) ─────────────────────────────
SELECT pg_temp.as('w1', 'c2', format($q$SELECT public.withdraw_lot_from_auction(%L, ' Tim ', ' strap broken ')$q$, pg_temp.l(1)));
SELECT pg_temp.ok('X1 manager withdraws L1 (2 bids)', (pg_temp.r('w1')->>'ok')::boolean AND (pg_temp.r('w1')->>'bidders_notified')::int = 2, pg_temp.r('w1')::text);
SELECT pg_temp.ok('X2 lot is canceled and out of the auction, price/leader cleared',
  (SELECT status = 'canceled' AND auction_id IS NULL AND lot_number IS NULL AND close_at IS NULL AND winner_bidder_id IS NULL
          AND current_bid_id IS NULL AND canceled_at IS NOT NULL FROM lots WHERE id = pg_temp.l(1)));
SELECT pg_temp.ok('X3 bid history kept (2 bids, bid_count 2)', (SELECT count(*) = 2 FROM bids WHERE lot_id = pg_temp.l(1))
  AND (SELECT bid_count = 2 FROM lots WHERE id = pg_temp.l(1)));
SELECT pg_temp.ok('X4 each bidder told once by lot_withdrawn (push/in-app kind)',
  (SELECT count(*) = 2 AND count(DISTINCT target_user_id) = 2 FROM notifications_outbox WHERE kind = 'lot_withdrawn' AND payload->>'lot_id' = pg_temp.l(1)::text));
SELECT pg_temp.ok('X5 withdrawal row keeps auction / number / close / price / leader + typed name, trimmed',
  (SELECT auction_id = pg_temp.u('d1')::uuid AND lot_number = 1 AND close_at IS NOT NULL AND current_bid_cents = 700
          AND winner_bidder_id = pg_temp.u('e2')::uuid AND staff_name = 'Tim' AND reason = 'strap broken' AND prior_status = 'live'
     FROM lot_withdrawals WHERE lot_id = pg_temp.l(1)));
SELECT pg_temp.ok('X6 audited with the typed name', EXISTS (SELECT 1 FROM operator_audit_log WHERE action_type = 'lot.withdrawn'
  AND target_id = pg_temp.l(1) AND reason_note = 'Tim: strap broken' AND actor_user_id = pg_temp.u('c2')::uuid));
SELECT pg_temp.as('w1-again', 'c1', format($q$SELECT public.withdraw_lot_from_auction(%L, 'Tim', 'again')$q$, pg_temp.l(1)));
SELECT pg_temp.ok('X7 withdrawing again refused (no second row)', pg_temp.reason('w1-again') = 'lot_not_in_open_auction'
  AND (SELECT count(*) = 1 FROM lot_withdrawals WHERE lot_id = pg_temp.l(1)));

-- A withdrawn lot cannot be bid on, finalized, or invoiced.
SELECT pg_temp.as('bid', 'e1', format($q$SELECT to_jsonb(public.place_bid(%L, 2000))$q$, pg_temp.l(1)));
SELECT pg_temp.ok('X8 place_bid on the withdrawn lot refused (lot status, not a card problem)', (pg_temp.r('bid')->>'ok')::boolean = false
  AND pg_temp.r('bid')->>'reason' NOT IN ('no_payment_method') AND (SELECT count(*) = 2 FROM bids WHERE lot_id = pg_temp.l(1)), pg_temp.r('bid')::text);
SELECT pg_temp.t('X9 finalize_lot leaves it canceled', 'postgres', NULL, format('SELECT public.finalize_lot(%L)', pg_temp.l(1)), 'ok');
SELECT pg_temp.ok('X10 still canceled, no winner, never on an invoice', (SELECT status = 'canceled' AND winner_bidder_id IS NULL FROM lots WHERE id = pg_temp.l(1))
  AND NOT EXISTS (SELECT 1 FROM invoice_lots WHERE lot_id = pg_temp.l(1)));

-- ── Y. undo the withdrawal before the auction closes ──────────────────────
SELECT pg_temp.as('uw-blank', 'c1', format($q$SELECT public.undo_lot_withdrawal(%L, '', 'mistake')$q$, pg_temp.l(1)));
SELECT pg_temp.ok('Y1 undo with blank name refused', pg_temp.reason('uw-blank') = 'staff_name_required');
SELECT pg_temp.as('uw-picker', 'c3', format($q$SELECT public.undo_lot_withdrawal(%L, 'Tim', 'mistake')$q$, pg_temp.l(1)));
SELECT pg_temp.ok('Y2 picker cannot undo', pg_temp.reason('uw-picker') = 'admin_or_manager_required');
SELECT pg_temp.as('uw', 'c1', format($q$SELECT public.undo_lot_withdrawal(%L, 'Jared', 'wrong lot')$q$, pg_temp.l(1)));
SELECT pg_temp.ok('Y3 admin undoes it', (pg_temp.r('uw')->>'ok')::boolean, pg_temp.r('uw')::text);
SELECT pg_temp.ok('Y4 lot back: live, same auction / number / close, price + leader restored, cancel stamp cleared',
  (SELECT status = 'live' AND auction_id = pg_temp.u('d1')::uuid AND lot_number = 1 AND close_at > now() AND current_bid_cents = 700
          AND winner_bidder_id = pg_temp.u('e2')::uuid AND current_bid_id = '00000000-0000-0000-0000-0000000bb002' AND canceled_at IS NULL
     FROM lots WHERE id = pg_temp.l(1)));
SELECT pg_temp.ok('Y5 bids intact, withdrawal closed with the undo name, bidders told (lot_reinstated)',
  (SELECT count(*) = 2 FROM bids WHERE lot_id = pg_temp.l(1))
  AND (SELECT undone_at IS NOT NULL AND undo_staff_name = 'Jared' FROM lot_withdrawals WHERE lot_id = pg_temp.l(1))
  AND (SELECT count(*) = 2 FROM notifications_outbox WHERE kind = 'lot_reinstated' AND payload->>'lot_id' = pg_temp.l(1)::text));
SELECT pg_temp.as('bid2', 'e1', format($q$SELECT to_jsonb(public.place_bid(%L, 2000))$q$, pg_temp.l(1)));
SELECT pg_temp.ok('Y6 bidding works again after undo', (pg_temp.r('bid2')->>'ok')::boolean AND (SELECT count(*) >= 3 FROM bids WHERE lot_id = pg_temp.l(1)), pg_temp.r('bid2')::text);
SELECT pg_temp.as('uw-again', 'c1', format($q$SELECT public.undo_lot_withdrawal(%L, 'Jared', 'again')$q$, pg_temp.l(1)));
SELECT pg_temp.ok('Y7 undo twice refused', pg_temp.reason('uw-again') = 'not_withdrawn');

-- Undo after the close time: refused.
SELECT pg_temp.as('w8', 'c1', format($q$SELECT public.withdraw_lot_from_auction(%L, 'Tim', 'cracked')$q$, pg_temp.l(8)));
SELECT pg_temp.ok('Y8 scheduled lot with a bid withdrawn', (pg_temp.r('w8')->>'ok')::boolean AND (pg_temp.r('w8')->>'bidders_notified')::int = 1);
UPDATE lot_withdrawals SET close_at = now() - interval '1 minute' WHERE lot_id = pg_temp.l(8);
SELECT pg_temp.as('uw8', 'c1', format($q$SELECT public.undo_lot_withdrawal(%L, 'Tim', 'oops')$q$, pg_temp.l(8)));
SELECT pg_temp.ok('Y9 undo after the close time refused', pg_temp.reason('uw8') = 'auction_closed' AND (SELECT status = 'canceled' FROM lots WHERE id = pg_temp.l(8)));
UPDATE lot_withdrawals SET close_at = now() + interval '1 day' WHERE lot_id = pg_temp.l(8);
UPDATE auctions SET status = 'closed' WHERE id = pg_temp.u('d1')::uuid;
SELECT pg_temp.as('uw8b', 'c1', format($q$SELECT public.undo_lot_withdrawal(%L, 'Tim', 'oops')$q$, pg_temp.l(8)));
SELECT pg_temp.ok('Y10 undo once the auction is closed refused', pg_temp.reason('uw8b') = 'auction_closed');
UPDATE auctions SET status = 'live' WHERE id = pg_temp.u('d1')::uuid;
-- Someone else now holds #8 in that auction.
UPDATE lots SET lot_number = 8, auction_id = pg_temp.u('d1')::uuid WHERE id = pg_temp.l(4);
SELECT pg_temp.as('uw8c', 'c1', format($q$SELECT public.undo_lot_withdrawal(%L, 'Tim', 'oops')$q$, pg_temp.l(8)));
SELECT pg_temp.ok('Y11 undo when the lot number was reused refused', pg_temp.reason('uw8c') = 'lot_number_taken');
UPDATE lots SET lot_number = 4 WHERE id = pg_temp.l(4);

-- ── D. withdraw then Dispose (attributed), then admin undo within 24 h ────
SELECT pg_temp.as('w2', 'c1', format($q$SELECT public.withdraw_lot_from_auction(%L, 'Tim', 'missing parts')$q$, pg_temp.l(2)));
SELECT pg_temp.as('d2-blank', 'c1', format($q$SELECT public.dispose_lot_attributed(%L, 'destroyed', 'Tim', '  ')$q$, pg_temp.l(2)));
SELECT pg_temp.ok('D1 dispose without a reason refused', pg_temp.reason('d2-blank') = 'reason_required' AND (SELECT status = 'canceled' FROM lots WHERE id = pg_temp.l(2)));
SELECT pg_temp.as('d2-picker', 'c3', format($q$SELECT public.dispose_lot_attributed(%L, 'destroyed', 'Tim', 'trash')$q$, pg_temp.l(2)));
SELECT pg_temp.ok('D2 picker cannot dispose', pg_temp.reason('d2-picker') = 'admin_or_manager_required');
SELECT pg_temp.as('d2', 'c2', format($q$SELECT public.dispose_lot_attributed(%L, 'destroyed', 'Tim', 'missing parts, trashed')$q$, pg_temp.l(2)));
SELECT pg_temp.ok('D3 manager disposes the withdrawn lot, audited with the name',
  (pg_temp.r('d2')->>'ok')::boolean AND (SELECT status = 'disposed' AND removal_kind = 'destroyed' AND removal_note = 'Tim: missing parts, trashed' FROM lots WHERE id = pg_temp.l(2))
  AND EXISTS (SELECT 1 FROM operator_audit_log WHERE action_type = 'lot.removed_from_inventory' AND target_id = pg_temp.l(2) AND reason_note = 'Tim: missing parts, trashed'));
SELECT pg_temp.as('uw2', 'c1', format($q$SELECT public.undo_lot_withdrawal(%L, 'Tim', 'oops')$q$, pg_temp.l(2)));
SELECT pg_temp.ok('D4 a disposed lot cannot be un-withdrawn', pg_temp.reason('uw2') = 'lot_changed_since_withdrawal');
SELECT pg_temp.as('ud2-mgr', 'c2', format($q$SELECT public.undo_lot_removal(%L, 'Tim', 'wrong one')$q$, pg_temp.l(2)));
SELECT pg_temp.ok('D5 manager cannot undo a removal (admin only)', pg_temp.reason('ud2-mgr') = 'admin_required');
SELECT pg_temp.as('ud2-blank', 'c1', format($q$SELECT public.undo_lot_removal(%L, 'Tim', '')$q$, pg_temp.l(2)));
SELECT pg_temp.ok('D6 undo removal without a reason refused', pg_temp.reason('ud2-blank') = 'reason_required');
SELECT pg_temp.as('ud2-other', 'c4', format($q$SELECT public.undo_lot_removal(%L, 'Tim', 'x')$q$, pg_temp.l(2)));
SELECT pg_temp.ok('D7 admin of another operator cannot undo', pg_temp.reason('ud2-other') = 'lot_other_operator');
SELECT pg_temp.as('ud2', 'c1', format($q$SELECT public.undo_lot_removal(%L, 'Jared', 'disposed the wrong lamp')$q$, pg_temp.l(2)));
SELECT pg_temp.ok('D8 admin undo within 24 h: back to canceled (withdrawn), removal cleared',
  (pg_temp.r('ud2')->>'status') = 'canceled' AND (SELECT status = 'canceled' AND removal_kind IS NULL AND removed_at IS NULL FROM lots WHERE id = pg_temp.l(2)), pg_temp.r('ud2')::text);
SELECT pg_temp.ok('D9 undo recorded (name, reason, kind) and audited',
  EXISTS (SELECT 1 FROM lot_removal_undos WHERE lot_id = pg_temp.l(2) AND removal_kind = 'destroyed' AND staff_name = 'Jared')
  AND EXISTS (SELECT 1 FROM operator_audit_log WHERE action_type = 'lot.removal_undone' AND target_id = pg_temp.l(2) AND reason_note = 'Jared: disposed the wrong lamp'));
SELECT pg_temp.as('uw2b', 'c1', format($q$SELECT public.undo_lot_withdrawal(%L, 'Tim', 'put it back')$q$, pg_temp.l(2)));
SELECT pg_temp.ok('D10 ...and the withdrawal can then be undone (lot live again in its auction)', (pg_temp.r('uw2b')->>'ok')::boolean
  AND (SELECT status = 'live' AND lot_number = 2 FROM lots WHERE id = pg_temp.l(2)), pg_temp.r('uw2b')::text);

-- Dispose an in_inventory lot, undo -> in_inventory.
SELECT pg_temp.as('d5', 'c1', format($q$SELECT public.dispose_lot_attributed(%L, 'bin_store', 'Tim', 'to the bin store')$q$, pg_temp.l(5)));
SELECT pg_temp.as('ud5', 'c1', format($q$SELECT public.undo_lot_removal(%L, 'Tim', 'came back from the bin store')$q$, pg_temp.l(5)));
SELECT pg_temp.ok('D11 dispose + undo returns an inventory lot to in_inventory, flag cleared',
  (SELECT status = 'in_inventory' AND removal_kind IS NULL AND NOT coalesce(flagged_for_disposal, false) AND flagged_reason IS NULL FROM lots WHERE id = pg_temp.l(5)));

-- 24 h window.
SELECT pg_temp.as('d7', 'c1', format($q$SELECT public.dispose_lot_attributed(%L, 'donated', 'Tim', 'donated')$q$, pg_temp.l(7)));
UPDATE lots SET removed_at = now() - interval '25 hours' WHERE id = pg_temp.l(7);
SELECT pg_temp.as('ud7', 'c1', format($q$SELECT public.undo_lot_removal(%L, 'Tim', 'late')$q$, pg_temp.l(7)));
SELECT pg_temp.ok('D12 undo after 24 h refused, lot stays disposed', pg_temp.reason('ud7') = 'undo_window_passed'
  AND (SELECT status = 'disposed' AND removal_kind = 'donated' FROM lots WHERE id = pg_temp.l(7)));
UPDATE lots SET removed_at = now() - interval '23 hours' WHERE id = pg_temp.l(7);
SELECT pg_temp.as('ud7b', 'c1', format($q$SELECT public.undo_lot_removal(%L, 'Tim', 'in time')$q$, pg_temp.l(7)));
SELECT pg_temp.ok('D13 undo at 23 h allowed', (pg_temp.r('ud7b')->>'ok')::boolean);

-- ── K. Business use (keep) on a withdrawn lot, and undo ────────────────────
SELECT pg_temp.as('w9', 'c1', format($q$SELECT public.withdraw_lot_from_auction(%L, 'Tim', 'boss wants it')$q$, pg_temp.l(9)));
SELECT pg_temp.as('k9-blank', 'c1', format($q$SELECT public.keep_lot_for_business_attributed(%L, 1500, '', 'office kettle')$q$, pg_temp.l(9)));
SELECT pg_temp.ok('K1 keep without a name refused', pg_temp.reason('k9-blank') = 'staff_name_required');
SELECT pg_temp.as('k9', 'c1', format($q$SELECT public.keep_lot_for_business_attributed(%L, 1500, 'Tim', 'office kettle')$q$, pg_temp.l(9)));
SELECT pg_temp.ok('K2 a WITHDRAWN (canceled) lot can be kept; keep row records the name', (pg_temp.r('k9')->>'ok')::boolean
  AND (SELECT reason = 'Tim: office kettle' AND prior_status = 'canceled' FROM lot_internal_keeps WHERE lot_id = pg_temp.l(9)), pg_temp.r('k9')::text);
-- An ordinary canceled lot (never withdrawn) can be kept too (0471).
UPDATE lots SET status = 'canceled', auction_id = NULL, lot_number = NULL WHERE id = pg_temp.l(6);
SELECT pg_temp.as('k6c', 'c1', format($q$SELECT public.keep_lot_for_business(%L, 0, 'test')$q$, pg_temp.l(6)));
SELECT pg_temp.ok('K3 a canceled lot that was NOT withdrawn can now be kept', (pg_temp.r('k6c')->>'ok')::boolean, pg_temp.r('k6c')::text);
-- put L6 back for K4 (fixture reset, trigger bypassed)
SET session_replication_role = replica;
DELETE FROM lot_internal_keeps WHERE lot_id = pg_temp.l(6);
UPDATE lots SET status = 'in_inventory', removal_kind = NULL, removed_at = NULL, removed_by = NULL, removal_note = NULL,
       flagged_for_disposal = false, flagged_reason = NULL, flagged_at = NULL WHERE id = pg_temp.l(6);
SET session_replication_role = origin;
SELECT pg_temp.as('k6', 'c1', format($q$SELECT public.keep_lot_for_business_attributed(%L, 0, 'Tim', 'shop drill')$q$, pg_temp.l(6)));
SELECT pg_temp.as('uk6', 'c1', format($q$SELECT public.undo_lot_removal(%L, 'Jared', 'not keeping it')$q$, pg_temp.l(6)));
SELECT pg_temp.ok('K4 keep + undo: back to in_inventory, keep row gone, copied into the undo + audit rows',
  (SELECT status = 'in_inventory' AND removal_kind IS NULL FROM lots WHERE id = pg_temp.l(6))
  AND NOT EXISTS (SELECT 1 FROM lot_internal_keeps WHERE lot_id = pg_temp.l(6))
  AND (SELECT kept_row->>'reason' = 'Tim: shop drill' FROM lot_removal_undos WHERE lot_id = pg_temp.l(6))
  AND (pg_temp.r('uk6')->>'was_kept')::boolean);
UPDATE lots SET removed_at = now() - interval '25 hours' WHERE id = pg_temp.l(9);
SELECT pg_temp.as('uk9', 'c1', format($q$SELECT public.undo_lot_removal(%L, 'Tim', 'late')$q$, pg_temp.l(9)));
SELECT pg_temp.ok('K5 keep undo after 24 h refused', pg_temp.reason('uk9') = 'undo_window_passed' AND EXISTS (SELECT 1 FROM lot_internal_keeps WHERE lot_id = pg_temp.l(9)));

-- ── C. lots pulled with admin_cancel_lot, and won lots whose sale is undone ─
SELECT pg_temp.as('ac10', 'c1', format($q$SELECT public.admin_cancel_lot(%L, 'pulled', true)$q$, pg_temp.l(10)));
SELECT pg_temp.ok('C1 setup: admin_cancel_lot(force) pulls L10 (bids kept)', (pg_temp.r('ac10')->>'ok')::boolean
  AND (SELECT status = 'canceled' AND auction_id IS NULL FROM lots WHERE id = pg_temp.l(10)) AND (SELECT count(*) = 1 FROM bids WHERE lot_id = pg_temp.l(10)), pg_temp.r('ac10')::text);
SELECT pg_temp.as('k10', 'c1', format($q$SELECT public.keep_lot_for_business_attributed(%L, 500, 'Tim', 'kept after pulling it')$q$, pg_temp.l(10)));
SELECT pg_temp.ok('C2 a lot canceled by admin_cancel_lot can be kept', (pg_temp.r('k10')->>'ok')::boolean
  AND (SELECT status = 'disposed' FROM lots WHERE id = pg_temp.l(10)), pg_temp.r('k10')::text);
SELECT pg_temp.as('k11', 'c1', format($q$SELECT public.keep_lot_for_business_attributed(%L, 0, 'Tim', 'refunded, keeping it')$q$, pg_temp.l(11)));
SELECT pg_temp.ok('C3 a won lot whose only invoice line is refunded can be kept', (pg_temp.r('k11')->>'ok')::boolean, pg_temp.r('k11')::text);
SELECT pg_temp.as('k12', 'c1', format($q$SELECT public.keep_lot_for_business_attributed(%L, 0, 'Tim', 'invoice canceled')$q$, pg_temp.l(12)));
SELECT pg_temp.ok('C4 a won lot whose invoice is canceled can be kept', (pg_temp.r('k12')->>'ok')::boolean, pg_temp.r('k12')::text);
SELECT pg_temp.as('k13', 'c1', format($q$SELECT public.keep_lot_for_business_attributed(%L, 0, 'Tim', 'try')$q$, pg_temp.l(13)));
SELECT pg_temp.ok('C5 a won lot still on a standing invoice line is refused', pg_temp.reason('k13') = 'lot_on_invoice'
  AND (SELECT status = 'won' FROM lots WHERE id = pg_temp.l(13)));
SELECT pg_temp.as('k3', 'c1', format($q$SELECT public.keep_lot_for_business_attributed(%L, 0, 'Tim', 'try')$q$, pg_temp.l(3)));
SELECT pg_temp.ok('C6 a won lot with no invoice line yet (sale in progress) is refused', pg_temp.reason('k3') = 'lot_on_invoice');
SELECT pg_temp.as('k4', 'c1', format($q$SELECT public.keep_lot_for_business_attributed(%L, 0, 'Tim', 'try')$q$, pg_temp.l(4)));
SELECT pg_temp.ok('C7 a live lot on an open invoice is still refused', pg_temp.reason('k4') = 'lot_on_invoice');
SELECT pg_temp.as('ud11', 'c1', format($q$SELECT public.undo_lot_removal(%L, 'Jared', 'not keeping it')$q$, pg_temp.l(11)));
SELECT pg_temp.ok('C8 undo of a kept won lot returns it to inventory (never back to won)',
  (pg_temp.r('ud11')->>'status') = 'in_inventory' AND (SELECT status = 'in_inventory' AND auction_id IS NULL FROM lots WHERE id = pg_temp.l(11)), pg_temp.r('ud11')::text);
SELECT pg_temp.t('C9 remove_lot_from_inventory (staff app) still accepts a canceled lot', 'authenticated', pg_temp.u('c1'),
  format($q$SELECT public.remove_lot_from_inventory(%L, 'other', 'test')$q$, pg_temp.l(12)), 'ok');

-- ── T. the 0319 terminal rule still blocks every other path ────────────────
SELECT pg_temp.t('T1 direct status change on a disposed lot blocked', 'postgres', NULL,
  format($q$UPDATE lots SET status = 'in_inventory' WHERE id = %L$q$, pg_temp.l(9)), 'P0001');
SELECT pg_temp.t('T2 direct clear of the removal blocked', 'postgres', NULL,
  format($q$UPDATE lots SET status = 'in_inventory', removal_kind = NULL WHERE id = %L$q$, pg_temp.l(9)), 'P0001');
SELECT pg_temp.t('T3 re-classify blocked', 'postgres', NULL,
  format($q$UPDATE lots SET removal_kind = 'destroyed' WHERE id = %L$q$, pg_temp.l(9)), 'P0001');
-- A forged undo row from an EARLIER transaction does not unlock it.
INSERT INTO lot_removal_undos (lot_id, operator_id, removal_kind, restored_status, staff_name, reason, undone_by, txid)
VALUES (pg_temp.l(9), pg_temp.u('a1')::uuid, 'other', 'in_inventory', 'x', 'x', pg_temp.u('c1')::uuid, txid_current() - 1);
SELECT pg_temp.t('T4 an undo row from another transaction does not unlock the lot', 'postgres', NULL,
  format($q$UPDATE lots SET status = 'in_inventory', removal_kind = NULL WHERE id = %L$q$, pg_temp.l(9)), 'P0001');
SELECT pg_temp.t('T5 staff cannot write lot_removal_undos', 'authenticated', pg_temp.u('c1'),
  format($q$INSERT INTO lot_removal_undos (lot_id, operator_id, removal_kind, restored_status, staff_name, reason, undone_by) VALUES (%L, %L, 'other', 'in_inventory', 'x', 'x', %L)$q$,
         pg_temp.l(9), pg_temp.u('a1'), pg_temp.u('c1')), '42501');
SELECT pg_temp.t('T6 staff cannot write lot_withdrawals', 'authenticated', pg_temp.u('c1'),
  format($q$UPDATE lot_withdrawals SET undone_at = now()$q$), '42501');
SELECT pg_temp.t('T7 the staff app''s 3-argument remove still works (missing mark)', 'authenticated', pg_temp.u('c1'),
  format($q$SELECT public.remove_lot_from_inventory(%L, 'missing', NULL)$q$, pg_temp.l(5)), 'ok');
SELECT pg_temp.ok('T8 ...and it stays permanent unless an admin undoes it', (SELECT status = 'disposed' AND removal_kind = 'missing' FROM lots WHERE id = pg_temp.l(5)));
SELECT pg_temp.t('T9 nobody calls the internal staff check directly', 'authenticated', pg_temp.u('c1'),
  format($q$SELECT public.lot_staff_action_check(%L, 'a', 'b', ARRAY['admin'])$q$, pg_temp.u('a1')), '42501');
SELECT pg_temp.t('T10 anon cannot undo a removal', 'anon', NULL, format($q$SELECT public.undo_lot_removal(%L, 'a', 'b')$q$, pg_temp.l(5)), '42501');
SELECT pg_temp.ok('T11 RLS on both new tables', (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.lot_withdrawals'::regclass, 'public.lot_removal_undos'::regclass)));
