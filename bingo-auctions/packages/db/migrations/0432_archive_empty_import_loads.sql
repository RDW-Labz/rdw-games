-- 0432 — #533: archive the 85 empty auto-import loads (data only).
--
-- The daily Wayfair import made one load per file, and most files dedupe to
-- 0 new rows, so the staff load picker (50 newest unarchived loads) filled up
-- with identical empty wayfair-d2l loads. The import now archives its own
-- empty load (PR #537); this archives the ones already there.
--
-- Fixed list of 85 ids, frozen from prod 2026-10-20 (84 wayfair-d2l + one
-- 21358222(Manifest).csv). Each must still be: auto-import, unarchived, no
-- import_rows for its import, no lots pointing at it; otherwise the whole
-- file rolls back. Only archived_at changes (plus updated_at, if present).
-- None of the 85 here (fresh/CI database): NOTICE, skip. All 85 already
-- archived with their 0432 audit row (rerun): NOTICE, nothing to do.
-- One operator_audit_log 'load.archive_empty' row per load.
-- Dry run (read-only): scripts/prod-rig/0432-dry-run.sql via mode=query.
-- Undo: scripts/prod-rig/0432_ROLLBACK_archive_empty_loads.sql.
-- Locks: row locks on 85 loads rows (not lots/bids/invoices); lock_timeout 3s.
-- Window: 05:00–07:00 CT, after the morning import (owner, 2026-10-20).
SET lock_timeout = '3s';

DO $$
DECLARE
  v_ids     uuid[] := ARRAY[
    'b2ef9750-6d0a-4bd4-80ad-edc0cab16e2b',
    '36f80a73-67b2-465e-9f5b-e7960ad37c2c',
    '38cae8a1-b20d-4c74-aeb2-1d6303f318b5',
    'c3dcf457-ff96-4b82-b6de-6f28c4c28ab7',
    'e84a7506-1336-471b-ac9f-75584dd5c2bb',
    '553c7512-cf9e-47fa-bd5a-03e32f6845c2',
    '31698344-4079-4ae0-ba98-82567075a70c',
    '8849b5e0-74c6-4dbf-bf4a-92bdc6a0c049',
    '31e77c31-aab6-45ab-82fd-fbbe1627d24c',
    'ff966f5e-2a81-46c2-a782-8a925ee46d1a',
    '409dfff7-63a1-404d-ba4c-3d4cf8a64cde',
    'fdbe1ab4-35a4-4faf-8b52-afdb0a42a80b',
    '8356882b-9a77-407a-b5d9-da61f4a3c284',
    '58cf64bf-f90a-4d98-b3fa-57dd4d50e691',
    'c6130d6c-75f3-4f55-a6da-67e8fcb78f89',
    '804191da-987b-4a46-b3cb-25c086d9219f',
    '7b7b84ec-c0ed-475b-ad34-ff2ce2c8049b',
    'a07a7648-e0b1-459a-865e-d962d218c040',
    '6cabd6fe-01cd-4bf0-b972-7c7466aef0a6',
    '08117324-2e7b-4b28-b2c4-1f21b2b6e310',
    'b6e4bd01-d062-4c60-84aa-5e87326b43e6',
    '3691053d-d37e-4254-8ef8-cb915928dd64',
    '03d3ecbd-1ac7-44a5-8c88-9efc4cd2a407',
    '1a50d3ac-d8c6-46e7-bf9b-7bd4122e19ed',
    '7abe414a-7c93-48ce-b608-baa16c2136aa',
    '5c2d938d-d712-4889-905e-b2202a7cd8e1',
    'd74502e4-38cb-455f-9082-52224a5952d8',
    'b74a80c5-a2cb-490f-8cf1-bfc9cca1de68',
    'b57c6c0c-8eb4-4afd-be3d-1f235998ae15',
    'dfb12cc7-a903-4a34-9299-0896955de118',
    '73d2b321-e5dd-4512-98ef-b8c3bccae987',
    '23a443d1-5379-45d4-9877-5907bb7c0eaa',
    '52949ec0-8608-4769-979c-9d8ef2afce1a',
    'dfa171a8-33fb-413d-9907-0435b2bc1ee0',
    '12e3043f-7283-46d7-ba6f-f081c2785c94',
    '58105764-826f-4aa4-a69f-4562d03dd164',
    'dc96c446-105f-4b17-870b-91e08d0e69ac',
    '7c22f2a3-1e4b-4ba0-ad4e-549244d61692',
    '5b850402-e04c-4d44-9a15-c2734c437ff0',
    '0d182993-3ee9-495a-b9b3-4a1711e7ec51',
    'c66415be-a946-4671-b968-e15d8fd3fee9',
    '5671be23-06b7-46a6-8fab-9ceaf7024a69',
    'ec410b7e-935c-4547-94c3-50ab0538ec1c',
    '91d50fdb-4965-4ab3-97d4-4a645a6791d1',
    '28298d9e-3cf3-438c-943a-ea5a7df4224b',
    '8b605278-1b58-4c47-9d77-260b03a31ab9',
    '8ba3a16e-2396-400a-be9a-7a7fc7bdb220',
    'b15088f4-006b-4203-bed3-fd1e6369307f',
    '0a010539-3e40-4098-8d41-9875d144554f',
    'bc898855-3f6e-4c06-8b19-c9d097336f8a',
    '4bd68be3-00db-4f03-8693-19e4451dbc27',
    '12628919-1769-4d3c-9ac9-4213a1a55db6',
    '7fac925f-2e7b-43cc-a430-4ae765654d31',
    'b96976da-c3f6-4494-b77b-e66ac36516fc',
    '53384027-0861-48ec-8a99-6e2e543e0a66',
    '339a97e1-8354-43e5-af11-2cf4536bb0af',
    '324c67ef-b0d0-4d5b-b198-787502fd2198',
    'd0092808-01e6-4909-ba9d-61a6f0bb34d7',
    '64619014-bb5c-4f9a-b421-adf73c644592',
    'cc42b43b-2c39-4fa9-822f-e382d18ec966',
    '1ab973c8-2709-4732-b76a-c1cf05b43a0e',
    'd0854807-5ac7-4a09-9b8b-e33befd93fab',
    'af1cc015-4937-48a2-97aa-5739cbd0ebc0',
    'a12e2b9b-7960-4b00-9257-009d03839bc0',
    'cc9b6b0f-dc4a-442b-b372-fdd1b725804e',
    '413e7ca5-d61d-430e-aba0-e1ca30d19ae4',
    '7d901c65-3505-4c03-9422-be4697f3aada',
    'c108a3e6-ad83-4460-bbb2-25d32bb8985c',
    'e97a672d-364c-49a3-b703-dd7db7501b9f',
    '1a7d1f0c-7d1c-451b-b08b-6d45d8524b3f',
    '14281b34-a5da-403e-b1d0-7aed61eca3a4',
    'd149d726-e3d8-42b5-887e-86ac7427cf98',
    '16f0710c-097e-4969-a4ac-6ae4f1df5f95',
    '219d00d6-5250-4a2f-8b29-f4db99dec538',
    '37cc8317-738e-4755-8f6a-ad7706839786',
    '27471f1a-7f10-4564-b10e-671faeb1cbcd',
    '4888bd08-84b5-4e0e-bf28-f17c9ec48e89',
    '11bcce12-62ff-4b1b-ae4b-7c82928cb61c',
    '6a28ca5f-8e84-436e-bd2b-b903f29d26f9',
    '2a199438-499d-4ab8-b9c6-66aa072a2cec',
    '0a05ded6-c5b5-4384-aacd-ab4846916311',
    '12b6f33d-ab09-448d-bc43-5409d9dd4fc8',
    '6fb60500-1f49-49fe-8845-eb868c420d69',
    '85f27057-493b-4d9b-a69a-27673cff0ebe',
    '99786924-dfc6-47a9-bdd4-3ca17043a0e0'
  ]::uuid[];
  v_changed integer;
  v_logged  integer;
BEGIN
  IF cardinality(v_ids) <> 85 THEN
    RAISE EXCEPTION '0432: expected 85 ids, got %', cardinality(v_ids);
  END IF;

  PERFORM 1 FROM loads ld WHERE ld.id = ANY (v_ids) FOR UPDATE;

  IF NOT EXISTS (SELECT 1 FROM loads ld WHERE ld.id = ANY (v_ids)) THEN
    RAISE NOTICE '0432: none of the 85 loads are here, skipping';
    RETURN;
  END IF;
  IF (SELECT count(*) FROM loads ld
       WHERE ld.id = ANY (v_ids)
         AND ld.operator_id = '05775af4-adb7-4f0f-943e-94a91e17f60d'::uuid
         AND ld.archived_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM operator_audit_log a
                      WHERE a.action_type = 'load.archive_empty'
                        AND a.target_id = ld.id
                        AND a.reason_note = '#533: empty auto-import load archived by data migration 0432')) = 85 THEN
    RAISE NOTICE '0432: already applied, nothing to do';
    RETURN;
  END IF;

  IF (SELECT count(*) FROM loads ld
       WHERE ld.id = ANY (v_ids)
         AND ld.operator_id = '05775af4-adb7-4f0f-943e-94a91e17f60d'::uuid
         AND ld.type::text = 'auto-import'
         AND ld.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM import_rows r WHERE r.import_id = ld.import_id)
         AND NOT EXISTS (SELECT 1 FROM lots l WHERE l.load_id = ld.id)) <> 85 THEN
    RAISE EXCEPTION '0432: precondition failed: a load is no longer empty, unarchived and auto-import';
  END IF;

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  SELECT ld.operator_id, NULL, 'load.archive_empty', ld.id,
         jsonb_build_object('archived_at', NULL, 'source_name', ld.source_name),
         jsonb_build_object('archived_at', now(), 'source_name', ld.source_name),
         '#533: empty auto-import load archived by data migration 0432'
    FROM loads ld WHERE ld.id = ANY (v_ids);
  GET DIAGNOSTICS v_logged = ROW_COUNT;

  UPDATE loads SET archived_at = now() WHERE id = ANY (v_ids) AND archived_at IS NULL;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  IF v_changed <> 85 OR v_logged <> 85 THEN
    RAISE EXCEPTION '0432: expected 85 archives and 85 audit rows, got % and %', v_changed, v_logged;
  END IF;
  RAISE NOTICE '0432: % empty loads archived, % logged', v_changed, v_logged;
END
$$;
