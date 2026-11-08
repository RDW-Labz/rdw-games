-- ROLLBACK for 0432 (#533): un-archive exactly the loads 0432 archived, read
-- from its 'load.archive_empty' audit rows, and only where archived_at is still
-- the value 0432 set. Logs 'load.archive_empty.undo'.
-- To run: copy into packages/db/migrations on a never-merge standby branch,
-- then mode=rerun --ref <standby>. Owner's go only.
SET lock_timeout = '3s';

DO $$
DECLARE v_n integer;
BEGIN
  CREATE TEMP TABLE _undo_0432 ON COMMIT DROP AS
    SELECT a.target_id AS load_id, a.operator_id, (a.after_state->>'archived_at')::timestamptz AS archived_at
      FROM operator_audit_log a
     WHERE a.action_type = 'load.archive_empty'
       AND a.reason_note = '#533: empty auto-import load archived by data migration 0432';

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  SELECT u.operator_id, NULL, 'load.archive_empty.undo', u.load_id,
         jsonb_build_object('archived_at', ld.archived_at), jsonb_build_object('archived_at', NULL),
         '#533: undo of data migration 0432'
    FROM _undo_0432 u JOIN loads ld ON ld.id = u.load_id
   WHERE ld.archived_at = u.archived_at;

  UPDATE loads ld SET archived_at = NULL
    FROM _undo_0432 u
   WHERE ld.id = u.load_id AND ld.archived_at = u.archived_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '0432 rollback: % loads un-archived', v_n;
END
$$;
