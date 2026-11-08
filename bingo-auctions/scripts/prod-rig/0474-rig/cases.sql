-- 0474 cases. Each line prints PASS/FAIL <what>. Manager c1 unless noted.
\set ON_ERROR_STOP 1
\pset tuples_only on
CREATE OR REPLACE FUNCTION r(p_inv text, p_lot text, p_amt int, p_method text, p_name text DEFAULT 'Jared', p_why text DEFAULT 'Item broken at pickup') RETURNS jsonb
LANGUAGE sql AS $$
  SELECT public.record_refund_override(('00000000-0000-0000-0000-0000000002' || p_inv)::uuid, ('00000000-0000-0000-0000-000000000' || p_lot)::uuid,
                                       p_amt, p_method, p_name, p_why, 'no_card_payment')
$$;
CREATE OR REPLACE FUNCTION ok(p_cond boolean, p_what text) RETURNS text LANGUAGE sql AS
$$ SELECT CASE WHEN p_cond THEN 'PASS ' ELSE 'FAIL ' END || p_what $$;
CREATE OR REPLACE FUNCTION inv(p text) RETURNS invoices LANGUAGE sql AS
$$ SELECT * FROM invoices WHERE id = ('00000000-0000-0000-0000-0000000002' || p)::uuid $$;

SELECT rig_as('00000000-0000-0000-0000-0000000000c1');

-- Who / what is required
SELECT ok((r('a1', '111', 500, 'cash', '  ')->>'reason') = 'staff_name_required', 'blank staff name: refused');
SELECT ok((r('a1', '111', 500, 'cash', 'Jared', '')->>'reason') = 'reason_required', 'blank reason: refused');
SELECT ok((r('a1', '111', 500, 'check')->>'reason') = 'bad_method', 'unknown method: refused');
SELECT rig_as('00000000-0000-0000-0000-0000000000c2');
SELECT ok((r('a1', '111', 500, 'cash')->>'reason') = 'manager_only', 'lead (not manager): refused');
SELECT rig_as('00000000-0000-0000-0000-0000000000c4');
SELECT ok((r('a1', '111', 500, 'cash')->>'reason') = 'manager_only', 'admin of another operator: refused');
SELECT rig_as(NULL);
SELECT ok((r('a1', '111', 500, 'cash')->>'reason') = 'not_authenticated', 'no user: refused');
SELECT ok(NOT has_function_privilege('anon', 'public.record_refund_override(uuid,uuid,int,text,text,text,text)', 'EXECUTE'), 'anon cannot call it');
SELECT rig_as('00000000-0000-0000-0000-0000000000c1');

-- Never around Square, never on the wrong line
SELECT ok((r('a3', '131', 500, 'cash')->>'reason') = 'use_card_refund', 'card-paid invoice: refused (Square only)');
SELECT ok((r('a6', '161', 500, 'cash')->>'reason') = 'not_paid', 'unpaid invoice: refused');
SELECT ok((r('a5', '151', 500, 'cash')->>'reason') = 'lot_forfeited', 'forfeited line: refused');
SELECT ok((r('a1', '121', 100, 'cash')->>'reason') = 'lot_not_in_invoice', 'line from another invoice: refused');

-- Never more than the line was paid; credit-paid money only as credit
SELECT ok((r('a1', '111', 1243, 'cash')->>'reason') = 'over_line_paid' AND (r('a1', '111', 1243, 'cash')->>'line_paid_cents') = '1242',
          'over what the line was paid ($12.42): refused');
SELECT ok((r('a2', '121', 252, 'cash')->>'reason') = 'cash_over_paid_offline', 'credit-paid line as cash: refused');

-- Caps (defaults $25 per use, $100 a day)
SELECT ok((r('a4', '141', 2484, 'cash')->>'reason') = 'ok_recorded', 'offline line $24.84 (under $25 cap) as cash: recorded');
UPDATE invoice_lots SET refunded_at = NULL WHERE lot_id = '00000000-0000-0000-0000-000000000142';
SELECT rig_as('00000000-0000-0000-0000-0000000000c3');
SELECT ok((public.refund_override_settings_set(2000, 3000, 'Braden')->>'ok') = 'true', 'admin sets caps $20 / $30 (named)');
SELECT rig_as('00000000-0000-0000-0000-0000000000c1');
SELECT ok((public.refund_override_settings_set(9000, 9000, 'Jared')->>'reason') = 'admin_only', 'manager cannot change caps');
SELECT ok((r('a4', '142', 2100, 'cash')->>'reason') = 'over_per_use_cap', 'over per-use cap: refused');
SELECT ok((r('a4', '142', 600, 'cash')->>'reason') = 'over_daily_cap', 'today $24.84 + $6.00 > $30 daily: refused');
SELECT ok((SELECT count(*) = 1 FROM refund_overrides), 'refused uses leave no override row');

-- The TEA3828564 shape: credit-paid line back as store credit
SELECT rig_as('00000000-0000-0000-0000-0000000000c3');
SELECT ok((public.refund_override_settings_set(2500, 10000, 'Braden')->>'ok') = 'true', 'caps back to $25 / $100');
SELECT rig_as('00000000-0000-0000-0000-0000000000c1');
SELECT ok((r('a2', '121', 252, 'store_credit')->>'reason') = 'ok_recorded', 'credit-paid $2.52 as store credit: recorded');
SELECT ok((SELECT amount_cents = 252 AND reason = 'refund_return' FROM bidder_credits WHERE invoice_id = '00000000-0000-0000-0000-0000000002a2' AND reason = 'refund_return'),
          '...a $2.52 credit row goes back to the buyer');
SELECT ok(((inv('a2')).status = 'refunded' AND (inv('a2')).refunded_credit_cents = 252 AND (inv('a2')).refunded_cash_cents = 0 AND (inv('a2')).refunded_at IS NOT NULL),
          '...invoice refunded, $2.52 as credit');
SELECT ok((SELECT refunded_at IS NOT NULL FROM invoice_lots WHERE lot_id = '00000000-0000-0000-0000-000000000121'), '...line stamped refunded');
SELECT ok((r('a2', '121', 1, 'store_credit')->>'reason') = 'invoice_already_refunded', 'same (fully refunded) invoice again: refused');
SELECT ok((r('a4', '141', 1, 'cash')->>'reason') = 'lot_already_refunded', 'already-refunded line on a part-refunded invoice: refused');

-- Offline invoice partial cash, then the audit and the report
SELECT ok((r('a1', '111', 1000, 'cash')->>'reason') = 'ok_recorded', 'offline line $10.00 cash (partial): recorded');
SELECT ok(((inv('a1')).status = 'partially_refunded' AND (inv('a1')).refunded_cash_cents = 1000 AND (inv('a1')).refunded_tax_cents = 74),
          '...invoice partially refunded, $10 cash, tax share 74c');
SELECT ok((SELECT count(*) = 0 FROM bidder_credits WHERE invoice_id = '00000000-0000-0000-0000-0000000002a1'), '...cash writes no credit row');
SELECT ok((SELECT count(*) = 3 FROM operator_audit_log WHERE action_type = 'invoice.refund_override'), 'one audit row per recorded use');
SELECT ok((SELECT bool_and(a.after_state->>'staff_name' = 'Jared' AND a.reason_note = 'Item broken at pickup' AND a.actor_user_id = '00000000-0000-0000-0000-0000000000c1')
             FROM operator_audit_log a WHERE a.action_type = 'invoice.refund_override'), '...with staff name, reason and actor');
SELECT ok((SELECT count(*) = 3 AND sum(amount_cents) = 2484 + 252 + 1000 AND bool_and(cause = 'no_card_payment' AND staff_name = 'Jared') FROM refund_overrides),
          'report table has every use with amount, method, name, cause');
SELECT ok((SELECT count(*) = 2 FROM operator_audit_log WHERE action_type = 'refund_override.settings'), 'cap changes are audited');
SELECT ok(NOT has_table_privilege('authenticated', 'public.refund_overrides', 'SELECT') AND NOT has_table_privilege('anon', 'public.refund_override_settings', 'SELECT'),
          'tables are server-only');
