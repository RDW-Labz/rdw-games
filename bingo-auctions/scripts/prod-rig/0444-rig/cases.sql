\set ON_ERROR_STOP 1
\set inv '00000000-0000-0000-0000-000000000091'
CREATE TEMP TABLE r (label text, out jsonb);
CREATE FUNCTION pg_temp.call(who text, inv uuid, lot text, purpose text, reason text, done_by text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN PERFORM set_config('request.jwt.claim.sub', coalesce(who,''), false);
RETURN public.undo_invoice_line_forfeit(inv, ('00000000-0000-0000-0000-0000000000' || lot)::uuid, purpose, reason, done_by); END $$;
INSERT INTO r SELECT 'picker forbidden', pg_temp.call('00000000-0000-0000-0000-0000000000c2', :'inv', 'f1', 'refund', 'customer was here', 'Jourdan');
INSERT INTO r SELECT 'no session forbidden', pg_temp.call(NULL, :'inv', 'f1', 'refund', 'customer was here', 'Jourdan');
INSERT INTO r SELECT 'other operator admin -> not_found', pg_temp.call('00000000-0000-0000-0000-0000000000c3', :'inv', 'f1', 'refund', 'customer was here', 'Jourdan');
INSERT INTO r SELECT 'bad purpose', pg_temp.call('00000000-0000-0000-0000-0000000000c1', :'inv', 'f1', 'void', 'customer was here', 'Jourdan');
INSERT INTO r SELECT 'short reason', pg_temp.call('00000000-0000-0000-0000-0000000000c1', :'inv', 'f1', 'refund', ' ab ', 'Jourdan');
INSERT INTO r SELECT 'no name', pg_temp.call('00000000-0000-0000-0000-0000000000c1', :'inv', 'f1', 'refund', 'customer was here', ' ');
INSERT INTO r SELECT 'unpaid invoice', pg_temp.call('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000092', 'f1', 'refund', 'customer was here', 'Jourdan');
INSERT INTO r SELECT 'picked-up line', pg_temp.call('00000000-0000-0000-0000-0000000000c1', :'inv', 'f4', 'refund', 'customer was here', 'Jourdan');
INSERT INTO r SELECT 'relist child live (picked_up) refused', pg_temp.call('00000000-0000-0000-0000-0000000000c1', :'inv', 'f2', 'picked_up', 'customer was here', 'Jourdan');
INSERT INTO r SELECT 'relist child live (picked_up) refused, 2nd item', pg_temp.call('00000000-0000-0000-0000-0000000000c1', :'inv', 'f6', 'picked_up', 'customer was here', 'Jourdan');
INSERT INTO r SELECT 'disposed lot', pg_temp.call('00000000-0000-0000-0000-0000000000c1', :'inv', 'f5', 'refund', 'customer was here', 'Jourdan');
INSERT INTO r SELECT 'audit rows so far', to_jsonb((SELECT count(*) FROM operator_audit_log WHERE action_type = 'invoice_line.forfeit_undone'));
INSERT INTO r SELECT 'OK unsold line', pg_temp.call('00000000-0000-0000-0000-0000000000c1', :'inv', 'f1', 'refund', 'customer was at the counter', ' Jourdan ');
INSERT INTO r SELECT 'again -> not_forfeited', pg_temp.call('00000000-0000-0000-0000-0000000000c1', :'inv', 'f1', 'refund', 'customer was at the counter', 'Jourdan');
INSERT INTO r SELECT 'OK refund with live relist (relist kept)', pg_temp.call('00000000-0000-0000-0000-0000000000c1', :'inv', 'f2', 'refund', 'box is in the warehouse, customer was here', 'Jourdan');
UPDATE lots SET status = 'canceled', canceled_at = now() WHERE id = '00000000-0000-0000-0000-0000000000f7';
INSERT INTO r SELECT 'OK picked_up after child pulled', pg_temp.call('00000000-0000-0000-0000-0000000000c1', :'inv', 'f6', 'picked_up', 'box went home on 10-22', 'Jourdan');
INSERT INTO r SELECT 'state', jsonb_build_object(
  'f1_forf', (SELECT forfeited_at FROM invoice_lots WHERE lot_id = '00000000-0000-0000-0000-0000000000f1' AND invoice_id = :'inv'),
  'f2_forf', (SELECT forfeited_at FROM invoice_lots WHERE lot_id = '00000000-0000-0000-0000-0000000000f2'),
  'f5_forf_kept', (SELECT forfeited_at IS NOT NULL FROM invoice_lots WHERE lot_id = '00000000-0000-0000-0000-0000000000f5'),
  'f1_status', (SELECT status FROM lots WHERE id = '00000000-0000-0000-0000-0000000000f1'),
  'f2_status_kept_relisted', (SELECT status FROM lots WHERE id = '00000000-0000-0000-0000-0000000000f2'),
  'f2_child_still_scheduled', (SELECT status FROM lots WHERE id = '00000000-0000-0000-0000-0000000000f3'),
  'f6_forf', (SELECT forfeited_at FROM invoice_lots WHERE lot_id = '00000000-0000-0000-0000-0000000000f6'),
  'f6_status', (SELECT status FROM lots WHERE id = '00000000-0000-0000-0000-0000000000f6'),
  'f5_status', (SELECT status FROM lots WHERE id = '00000000-0000-0000-0000-0000000000f5'),
  'pickup', (SELECT status FROM pickups LIMIT 1));
INSERT INTO r SELECT 'audit', (SELECT jsonb_agg(jsonb_build_object('actor', actor_user_id, 'before', before_state, 'after', after_state, 'why', reason_note) ORDER BY created_at) FROM operator_audit_log WHERE action_type = 'invoice_line.forfeit_undone');
SELECT label || ' | ' || out::text FROM r;
