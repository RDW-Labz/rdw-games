-- footprint-exempt: only sets load_id to NULL on 9 listed lots; nothing deleted, disposed, hidden or re-coded, sticker and shelf still point at the same lot, so the assert's refusal and lots table lock do not apply
-- 0431 — #533: take 9 lots off a stale load pick (data only).
--
-- BIN-036548..555 (10-20 15:46–15:48 CT) and BIN-036566 (17:06) were made on
-- Web lotting by a station device whose saved load pick was weeks old
-- (07-09 "wayfair-d2l", e82bc44a). Owner added 036566 on 10-21.
-- None has a manifest row, so the manifest can't vouch for that load. The
-- right truck is unknown, so the owner approved "none" (load_id NULL).
--
-- Fixed list. Aborts (whole file rolls back) unless every lot still carries
-- the old load, is not deleted, and has no manifest row. Only load_id changes
-- (plus updated_at). One operator_audit_log 'load.correction' row per lot.
-- None of the 9 here (fresh/CI database): NOTICE, skip. All 9 already off
-- the load with their 0431 audit row (rerun): NOTICE, nothing to do.
-- Dry run (read-only): scripts/prod-rig/0431-dry-run.sql via mode=query.
-- Undo: scripts/prod-rig/0431_ROLLBACK_correct_stale_load_picks.sql.
-- Locks: row locks on 9 lots rows; lock_timeout 3s.
SET lock_timeout = '3s';

DO $$
DECLARE
  v_changed integer;
  v_logged  integer;
BEGIN
  CREATE TEMP TABLE _fix_0431 (lot_id uuid PRIMARY KEY, lot_code text) ON COMMIT DROP;
  INSERT INTO _fix_0431 VALUES
  ('7a76ab40-84ce-40e7-b41f-4f0db48b3a81'::uuid, 'BIN-036548'),
  ('6e174fbb-514c-4ed2-a007-abc7e96b7963'::uuid, 'BIN-036549'),
  ('df9695c0-cffb-4c4e-a563-094f5b06a8ef'::uuid, 'BIN-036550'),
  ('9c04e2fb-ba2e-4d85-9584-93025de77da1'::uuid, 'BIN-036551'),
  ('ab31717c-008c-4d59-a6ab-ba0cd0d259a9'::uuid, 'BIN-036552'),
  ('5b0122ef-c52b-47b9-ad98-1d230d82e14e'::uuid, 'BIN-036553'),
  ('12d91d4f-f54b-4603-a6d9-3f2474fc9d65'::uuid, 'BIN-036554'),
  ('24a59a35-9d04-47ac-97f4-3e91a961dbb1'::uuid, 'BIN-036555'),
  ('a8a5e550-05bc-4dc3-92cf-74c11126e0d9'::uuid, 'BIN-036566');

  PERFORM 1 FROM lots l JOIN _fix_0431 f ON f.lot_id = l.id FOR UPDATE OF l;

  IF NOT EXISTS (SELECT 1 FROM lots l JOIN _fix_0431 f ON f.lot_id = l.id) THEN
    RAISE NOTICE '0431: none of the 9 lots are here, skipping';
    RETURN;
  END IF;
  IF (SELECT count(*) FROM lots l JOIN _fix_0431 f ON f.lot_id = l.id
       WHERE l.lot_code = f.lot_code
         AND l.operator_id = '05775af4-adb7-4f0f-943e-94a91e17f60d'::uuid
         AND l.load_id IS NULL
         AND l.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM operator_audit_log a
                      WHERE a.action_type = 'load.correction'
                        AND a.target_id = f.lot_id
                        AND a.reason_note = '#533: stale load pick on a station device (10-20); data migration 0431')) = 9 THEN
    RAISE NOTICE '0431: already applied, nothing to do';
    RETURN;
  END IF;

  IF (SELECT count(*) FROM lots l JOIN _fix_0431 f ON f.lot_id = l.id
       WHERE l.lot_code = f.lot_code
         AND l.operator_id = '05775af4-adb7-4f0f-943e-94a91e17f60d'::uuid
         AND l.load_id = 'e82bc44a-774b-4bb1-ab68-a0b67f15a5b3'::uuid
         AND l.deleted_at IS NULL) <> 9 THEN
    RAISE EXCEPTION '0431: precondition failed: a lot no longer carries the reviewed old load';
  END IF;
  IF EXISTS (SELECT 1 FROM import_rows ir JOIN _fix_0431 f ON f.lot_id = ir.lot_id) THEN
    RAISE EXCEPTION '0431: precondition failed: a lot now has a manifest row';
  END IF;

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  SELECT '05775af4-adb7-4f0f-943e-94a91e17f60d'::uuid, NULL, 'load.correction', f.lot_id,
         jsonb_build_object('load_id', 'e82bc44a-774b-4bb1-ab68-a0b67f15a5b3', 'lot_code', f.lot_code),
         jsonb_build_object('load_id', NULL, 'lot_code', f.lot_code),
         '#533: stale load pick on a station device (10-20); data migration 0431'
    FROM _fix_0431 f;
  GET DIAGNOSTICS v_logged = ROW_COUNT;

  UPDATE lots l SET load_id = NULL FROM _fix_0431 f WHERE l.id = f.lot_id;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  IF v_changed <> 9 OR v_logged <> 9 THEN
    RAISE EXCEPTION '0431: expected 9 updates and 9 audit rows, got % and %', v_changed, v_logged;
  END IF;
  RAISE NOTICE '0431: % lots taken off load e82bc44a, % logged', v_changed, v_logged;
END
$$;
