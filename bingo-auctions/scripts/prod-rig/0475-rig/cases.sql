-- 0475 cases (AFTER 0475, fresh seed). Each line prints PASS/FAIL <what>.
\set ON_ERROR_STOP 1
\pset tuples_only on
CREATE OR REPLACE FUNCTION ok(p_cond boolean, p_what text) RETURNS text LANGUAGE sql AS
$$ SELECT CASE WHEN coalesce(p_cond, false) THEN 'PASS ' ELSE 'FAIL ' END || p_what $$;
CREATE OR REPLACE FUNCTION st(p_code text) RETURNS text LANGUAGE sql AS
$$ SELECT status::text FROM lots WHERE lot_code = p_code ORDER BY created_at LIMIT 1 $$;
-- Same writes as the refund-items route, in its order: audit row with the
-- amount, invoice refunded cents, then the line stamp. Line paid = 1242c.
CREATE OR REPLACE FUNCTION refund(p_n text, p_amt int DEFAULT 1242) RETURNS void LANGUAGE sql AS $$
  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, after_state)
  VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'invoice.refund_item',
          '00000000-0000-0000-0000-0000000002a1',
          jsonb_build_object('lot_id', ('00000000-0000-0000-0000-0000000001' || p_n), 'amount_cents', p_amt));
  UPDATE invoices SET refunded_cash_cents = coalesce(refunded_cash_cents, 0) + p_amt, status = 'partially_refunded', refunded_at = coalesce(refunded_at, now())
   WHERE id = '00000000-0000-0000-0000-0000000002a1';
  UPDATE invoice_lots SET refunded_at = now()
   WHERE lot_id = ('00000000-0000-0000-0000-0000000001' || p_n)::uuid AND invoice_id = '00000000-0000-0000-0000-0000000002a1' $$;
CREATE OR REPLACE FUNCTION rr(p_code text, p_worker text, p_pin text, p_name text DEFAULT 'Jared', p_why text DEFAULT 'Box on shelf, sellable', p_auction uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.relist_refunded_lot((SELECT id FROM lots WHERE lot_code = p_code ORDER BY created_at LIMIT 1),
                                    ('00000000-0000-0000-0000-0000000000' || p_worker)::uuid, p_pin, p_name, p_why, p_auction) $$;

SELECT rig_as('00000000-0000-0000-0000-0000000000c1');

-- ---- the refund trigger
SELECT refund('01');
SELECT ok(st('L01') = 'refunded', 'TEA4842561 shape: refunded, never picked up -> refunded');
SELECT ok((SELECT winner_bidder_id IS NOT NULL FROM lots WHERE lot_code = 'L01'), '...buyer stays in history (winner kept)');
SELECT ok((SELECT refunded_at IS NOT NULL FROM invoice_lots WHERE lot_id = '00000000-0000-0000-0000-000000000101'), '...refunded line kept');
SELECT ok((SELECT count(*) = 1 FROM lot_status_history WHERE lot_id = '00000000-0000-0000-0000-000000000101' AND from_status = 'won' AND to_status::text = 'refunded'), '...status history records won -> refunded');
SELECT ok((SELECT count(*) = 1 FROM operator_audit_log WHERE action_type = 'lot.refunded' AND target_id = '00000000-0000-0000-0000-000000000101'
             AND actor_user_id = '00000000-0000-0000-0000-0000000000c1'), '...audit row with the refunding user');
SELECT refund('02');
SELECT ok(st('L02') = 'won', 'picked up then refunded: stays won (buyer took it)');
SELECT refund('03');
SELECT ok(st('L03') = 'refunded' AND st('L04') = 'won', 'one line of a multi-line invoice refunded: that lot -> refunded, other lines untouched');
SELECT ok((SELECT status::text = 'partially_refunded' AND refunded_cash_cents = 3726 FROM invoices WHERE id = '00000000-0000-0000-0000-0000000002a1'), '...trigger never touches the invoice (only the refund writes did)');
SELECT refund('04', 500);
SELECT ok(st('L04') = 'won', 'PARTIAL refund of a line ($5.00 of $12.42, never picked up): lot stays won');
SELECT refund('05');
SELECT ok(st('L05') = 'won', 'reported missing then refunded: stays won');
SELECT refund('06');
SELECT ok(st('L06') = 'won', 'another open sale of the lot: stays won');
SELECT refund('07');
SELECT ok(st('L07') = 'won', 'forfeited line refunded: trigger leaves the lot to the no-show path');
UPDATE invoice_lots SET refunded_at = refunded_at WHERE lot_id = '00000000-0000-0000-0000-000000000109';
SELECT ok(st('L09') = 'won', 're-stamping an already-refunded line does nothing (legacy lot stays won)');
UPDATE invoice_lots SET picked_up_at = now() WHERE lot_id = '00000000-0000-0000-0000-000000000110';
SELECT ok(st('L10') = 'won', 'a pickup stamp never fires the trigger');

-- ---- relist after refund (manager PIN)
SELECT ok((rr('L01', 'f1', '2468', '  ')->>'reason') = 'staff_name_required', 'relist: blank name refused');
SELECT ok((rr('L01', 'f1', '2468', 'Jared', '')->>'reason') = 'reason_required', 'relist: blank reason refused');
SELECT ok((rr('L10', 'f1', '2468')->>'reason') = 'not_refunded', 'relist: lot never refunded refused');
SELECT ok((rr('L02', 'f1', '2468')->>'reason') = 'buyer_took_it', 'relist: refunded after pickup refused (buyer took it)');
SELECT ok((rr('L01', 'f1', '0000')->>'reason') = 'pin_bad_pin', 'relist: wrong manager PIN refused');
SELECT ok((SELECT failed_attempts = 1 FROM workers WHERE id = '00000000-0000-0000-0000-0000000000f1'), '...and counted toward the PIN lockout');
SELECT ok((rr('L01', 'f2', '1357')->>'reason') = 'pin_not_manager', 'relist: picker PIN (not a manager) refused');
SELECT ok(st('L01') = 'refunded' AND (SELECT count(*) = 1 FROM lots WHERE lot_code LIKE 'L01' OR relisted_from_lot_id = '00000000-0000-0000-0000-000000000101'),
          '...nothing relisted by any refusal');
WITH r AS (SELECT rr('L01', 'f1', '2468', 'Jared', 'Box on 10-03-01, sellable') j)
SELECT ok((SELECT j->>'reason' = 'ok_relisted' AND (j->>'to_inventory')::boolean FROM r), 'relist: manager PIN + name + reason -> relot to inventory');
SELECT ok((SELECT c.status = 'in_inventory' AND c.relist_origin = 'human_relot' FROM lots c WHERE c.relisted_from_lot_id = '00000000-0000-0000-0000-000000000101'),
          '...new copy in_inventory');
SELECT ok(st('L01') = 'relisted', '...old row relisted (keeps its sale history)');
SELECT ok((SELECT array_agg(DISTINCT to_status::text) @> ARRAY['refunded', 'unsold', 'relisted'] FROM lot_status_history WHERE lot_id = '00000000-0000-0000-0000-000000000101'),
          '...history has refunded, then unsold and relisted (same transaction)');
SELECT ok((SELECT a.reason_note = 'Box on 10-03-01, sellable' AND a.after_state->>'staff_name' = 'Jared' AND a.after_state->>'manager_name' = 'Tim'
             FROM operator_audit_log a WHERE a.action_type = 'lot.relist_after_refund'), '...audit: typed name, reason, manager name');
SELECT ok((rr('L09', 'f1', '2468')->>'reason') = 'ok_relisted', 'relist: legacy won lot with every line refunded -> allowed');
SELECT ok((rr('L03', 'f1', '2468', 'Jared', 'resell', '00000000-0000-0000-0000-00000000aa01'::uuid)->>'reason') = 'relist_refused', 'relist into a CLOSED auction: refused by the relist guards');
SELECT ok(st('L03') = 'refunded', '...and the lot is still refunded (step to unsold rolled back)');
SELECT ok((rr('L03', 'f1', '2468', 'Jared', 'resell', '00000000-0000-0000-0000-00000000aa03'::uuid)->>'reason') = 'ok_relisted',
          'relist: into an auction (not inventory) also works');
SELECT ok((SELECT c.status = 'scheduled' FROM lots c WHERE c.relisted_from_lot_id = '00000000-0000-0000-0000-000000000103'), '...copy scheduled');
SELECT ok((rr('L01', 'f1', '2468')->>'reason') = 'wrong_status', 'relist: same lot twice refused');

SELECT rig_as('00000000-0000-0000-0000-0000000000c2');
SELECT ok((rr('L05', 'f1', '2468')->>'reason') = 'not_operator_staff', 'relist: non-staff caller refused');
SELECT rig_as(NULL);
SELECT ok((rr('L05', 'f1', '2468')->>'reason') = 'not_authenticated', 'relist: no user refused');
SELECT ok(NOT has_function_privilege('anon', 'public.relist_refunded_lot(uuid,uuid,text,text,text,uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.relist_refunded_lot(uuid,uuid,text,text,text,uuid)', 'EXECUTE'),
          'grants: anon no, authenticated yes');
