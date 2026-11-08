-- Rollback for PROPOSED_load_backfill.sql — standby only. Clears exactly the
-- lot ids each 'load.backfill' audit row recorded, and only where the lot
-- still points at that load (a later manual change is left alone).
BEGIN;
UPDATE lots l
   SET load_id = NULL
  FROM operator_audit_log a,
       LATERAL jsonb_array_elements_text(a.after_state->'lot_ids') AS x(lot_id)
 WHERE a.action_type = 'load.backfill'
   AND l.id = x.lot_id::uuid
   AND l.load_id = a.target_id;
INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
SELECT operator_id, NULL, 'load.backfill_rolled_back', target_id, after_state, NULL, 'Rollback of load backfill'
  FROM operator_audit_log WHERE action_type = 'load.backfill';
COMMIT;
