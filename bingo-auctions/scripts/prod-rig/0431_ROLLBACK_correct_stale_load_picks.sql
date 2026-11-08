-- ROLLBACK for 0431 (#533). Puts each lot back on the load its 0431
-- 'load.correction' audit row recorded, only where the lot still has no load
-- (anything changed since is left alone). Logs 'load.correction.undo'.
-- To run: copy into packages/db/migrations on a never-merge standby branch,
-- then mode=rerun --ref <standby>. Owner's go only.
SET lock_timeout = '3s';

DO $$
DECLARE v_n integer;
BEGIN
  CREATE TEMP TABLE _undo_0431 ON COMMIT DROP AS
    SELECT a.target_id AS lot_id, a.operator_id, (a.before_state->>'load_id')::uuid AS old_load_id
      FROM operator_audit_log a
     WHERE a.action_type = 'load.correction'
       AND a.reason_note = '#533: stale load pick on a station device (10-20); data migration 0431';

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  SELECT u.operator_id, NULL, 'load.correction.undo', u.lot_id,
         jsonb_build_object('load_id', NULL), jsonb_build_object('load_id', u.old_load_id),
         '#533: undo of data migration 0431'
    FROM _undo_0431 u JOIN lots l ON l.id = u.lot_id
   WHERE l.load_id IS NULL;

  UPDATE lots l SET load_id = u.old_load_id
    FROM _undo_0431 u
   WHERE l.id = u.lot_id AND l.load_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '0431 rollback: % lots back on their old load', v_n;
END
$$;
