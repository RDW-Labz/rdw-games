-- Money must be identical with and without 0475 (owner check B, 2026-10-28).
-- Run on a seeded copy WITH 0474 applied; run.sh runs it on a copy without
-- 0475 and one with 0475 and diffs every MONEY line. LOT lines are printed
-- separately (those are meant to differ: won -> refunded).
\set ON_ERROR_STOP 1
\pset tuples_only on
SET session_replication_role = replica;
-- An offline-paid invoice (no card) for the 0474 override path: L12, $12.42.
INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at, pickup_starts_at, pickup_ends_at) VALUES
 ('00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Closed C', 'closed', now()-interval '9 day', now()-interval '8 day', now()-interval '8 day', now()+interval '3 day');
INSERT INTO lots (id, operator_id, warehouse_id, auction_id, lot_number, title, lot_code, status, close_at, winner_bidder_id, current_bid_cents) VALUES
 ('00000000-0000-0000-0000-000000000112', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000aa04', 1, 'L12', 'L12', 'won', now()-interval '8 day', '00000000-0000-0000-0000-0000000000e2', 1000);
INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, subtotal_cents, buyer_premium_cents, tax_cents, total_cents, square_payment_id, paid_at) VALUES
 ('00000000-0000-0000-0000-0000000002a3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-0000000000e2', 'paid', 1000, 150, 92, 1242, NULL, now()-interval '7 day');
INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents) VALUES
 ('00000000-0000-0000-0000-0000000002a3', '00000000-0000-0000-0000-000000000112', 1000);
SET session_replication_role = origin;
SELECT rig_as('00000000-0000-0000-0000-0000000000c1');

-- 1. Full item refund of a never-picked-up line (refund-items route writes).
INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, after_state)
VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'invoice.refund_item', '00000000-0000-0000-0000-0000000002a1',
        jsonb_build_object('lot_id', '00000000-0000-0000-0000-000000000101', 'amount_cents', 1242));
UPDATE invoices SET refunded_cash_cents = 1242, refunded_tax_cents = 92, status = 'partially_refunded', refunded_at = '2026-10-28 12:00+00'
 WHERE id = '00000000-0000-0000-0000-0000000002a1';
UPDATE invoice_lots SET refunded_at = '2026-10-28 12:00+00' WHERE lot_id = '00000000-0000-0000-0000-000000000101';
-- 2. Partial item refund ($5.00 of $12.42) on L04.
INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, after_state)
VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'invoice.refund_item', '00000000-0000-0000-0000-0000000002a1',
        jsonb_build_object('lot_id', '00000000-0000-0000-0000-000000000104', 'amount_cents', 500));
UPDATE invoices SET refunded_cash_cents = 1742, refunded_tax_cents = 129 WHERE id = '00000000-0000-0000-0000-0000000002a1';
UPDATE invoice_lots SET refunded_at = '2026-10-28 12:00+00' WHERE lot_id = '00000000-0000-0000-0000-000000000104';
-- 3. Whole-invoice refund (refund route, isFull) of the other buyer's invoice.
UPDATE invoices SET refunded_cash_cents = total_cents, refunded_tax_cents = tax_cents, status = 'refunded', refunded_at = '2026-10-28 12:00+00'
 WHERE id = '00000000-0000-0000-0000-0000000002a2';
UPDATE invoice_lots SET refunded_at = '2026-10-28 12:00+00'
 WHERE invoice_id = '00000000-0000-0000-0000-0000000002a2' AND refunded_at IS NULL AND picked_up_at IS NULL AND forfeited_at IS NULL;
-- 4. 0474 manager override, offline-paid invoice, full $12.42 as account credit.
SELECT 'OVR ' || (public.record_refund_override('00000000-0000-0000-0000-0000000002a3', '00000000-0000-0000-0000-000000000112', 1242, 'store_credit', 'Jared', 'Broken at pickup', 'no_card_payment')->>'reason');

-- MONEY lines: everything a receipt, balance or report is built from.
SELECT 'MONEY inv ' || right(id::text, 3) || ' ' || status || ' total=' || total_cents || ' sub=' || subtotal_cents || ' prem=' || buyer_premium_cents
       || ' tax=' || tax_cents || ' credit_applied=' || coalesce(credit_applied_cents, 0) || ' ref_cash=' || coalesce(refunded_cash_cents, 0)
       || ' ref_credit=' || coalesce(refunded_credit_cents, 0) || ' ref_tax=' || coalesce(refunded_tax_cents, 0)
       || ' balance_due=' || CASE WHEN status::text IN ('pending', 'payment_failed_grace') THEN total_cents ELSE 0 END
  FROM invoices ORDER BY id;
SELECT 'MONEY line ' || l.lot_code || ' ' || right(il.invoice_id::text, 3) || ' bid=' || il.winning_bid_cents || ' refunded=' || (il.refunded_at IS NOT NULL)
       || ' picked=' || (il.picked_up_at IS NOT NULL) || ' forfeited=' || (il.forfeited_at IS NOT NULL)
  FROM invoice_lots il JOIN lots l ON l.id = il.lot_id ORDER BY l.lot_code, il.invoice_id;
SELECT 'MONEY credit ' || right(bidder_id::text, 2) || ' balance=' || sum(amount_cents) FROM bidder_credits GROUP BY bidder_id ORDER BY 1;
SELECT 'MONEY overrides n=' || count(*) || ' sum=' || coalesce(sum(amount_cents), 0) FROM refund_overrides;
-- first/last_paid_at are seed timestamps (now() at seed time), not money.
SELECT 'MONEY money_summary ' || (public.operator_money_summary(now() - interval '60 day', now() + interval '1 day')::jsonb - 'first_paid_at' - 'last_paid_at')::text;
SELECT 'MONEY period_summary ' || public.operator_reports_period_summary(now() - interval '60 day', now() + interval '1 day')::text;
SELECT 'MONEY money_daily ' || coalesce(json_agg(d)::text, '[]') FROM public.operator_money_daily((now() - interval '60 day')::date, (now() + interval '1 day')::date, 'America/Chicago') d;
-- operator_auction_performance returns one json value (an array, or an
-- object holding one); take the auction rows wherever they are.
CREATE TEMP TABLE perf AS
  SELECT e FROM (SELECT public.operator_auction_performance(now() - interval '60 day', now() + interval '1 day')::jsonb AS j) x,
  LATERAL jsonb_array_elements(CASE jsonb_typeof(x.j) WHEN 'array' THEN x.j
                                    ELSE coalesce(x.j->'auctions', x.j->'rows', '[]'::jsonb) END) e;
SELECT 'MONEY auction_perf_money ' || coalesce(string_agg(
          (e->>'title') || ' gross=' || (e->>'gross_cents') || ' refunded=' || (e->>'refunded_cents') || ' sold=' || (e->>'sold') || ' msrp_sold=' || coalesce(e->>'msrp_sold_cents', '-'), ' | ' ORDER BY e->>'title'), 'none')
  FROM perf;
SELECT 'COUNT auction_perf_returned_lots ' || coalesce(string_agg((e->>'title') || '=' || (e->>'returned_lots') || ' unsold=' || (e->>'unsold'), ' ' ORDER BY e->>'title'), 'none') FROM perf;
SELECT 'LOT ' || lot_code || ' ' || status FROM lots WHERE lot_code IN ('L01', 'L04', 'L06', 'L12') ORDER BY lot_code;
