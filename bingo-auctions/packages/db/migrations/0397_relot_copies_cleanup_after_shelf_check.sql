-- footprint-exempt: disposes stickerless double-relot copies and records Jared's 10/6 shelf check (missing, one disposal, two shelves); every lot is guarded below and the copies inherited real shelves, so the assert would refuse; owner-approved 2026-10-06
-- 0397 — clean up the double-relot copies after Jared's shelf check (2026-10-06).
--
-- Background: HANDOFF-2026-10-06 §7. A double tap on Relot (fixed by 0392)
-- minted a second, stickerless lot for the same box. The real lot is the one
-- with the sticker; nothing physical sits behind the copy. Jared checked every
-- shelf on 10/6. Data only: no schema, no new locks beyond the rows touched.
--
-- WHAT IT DOES (lot codes; "copy" = stickerless twin)
--   A. Dispose the copy, keep the stickered lot (21 copies; items 4–17, 19, 20,
--      21, 22 (both copies), 25, 26):
--        BIN-019326 019239 019356 025076 019452 019366 024828 021111 030846
--        020917 020887 028942 019353 021084 019441 028999 029014 029015 021093
--        020985 020907
--      Item 27's copy BIN-028904 is NOT here: it was hard-deleted from the
--      console on 10/6 (row gone, no audit row); Jared confirmed its real box
--      BIN-028903 is on its shelf. Nothing to do.
--   B. Shelves (the lots_log_intake_move trigger records each move):
--      item 15: BIN-028941 (PNK4820677), no shelf → Right-01-06;
--      item 19: BIN-020984 (PNK4859407), 10-02-01 → 10-03-01 (box found there).
--   C. Item 24: dispose the copy BIN-020870 AND record the stickered lot
--      BIN-019489 (TEA3821566) as missing (removal_kind 'missing', 0352).
--      Item 23 (rev. 2026-10-08, box FOUND): the copy BIN-031006 was
--      desk-relisted on 10/7 16:39 CT into BIN-031438 (no sticker), scheduled in
--      "Deals to Die For" (opens 10/11 07:00 CT) with 1 pre-bid. The console
--      cannot cancel a lot with bids, so this file takes BIN-031438 out of the
--      sale itself, the way admin_cancel_lot(force) does (auction_id,
--      lot_number, close_at cleared; the pre-bid is void because the lot is out
--      of the sale; its row stays as history; no charge, no notice is sent),
--      and disposes it, then disposes BIN-031006. The stickered BIN-031005
--      (TEA4841964) is NOT touched: it stays in inventory, and Jared adds it to
--      an auction himself afterwards. Must run before 10/11 07:00.
--      Item 19 (rev. 2026-10-08): the copy BIN-020985 (no sticker, but it
--      inherited display code PNK4859407) is lot #41 in "Boo, Bid & Buy" (opens
--      10/12 07:00 CT), and the console has no way to remove it. This file takes
--      it out of the sale itself, the same way as BIN-031438 (auction_id,
--      lot_number, close_at cleared), only while it has no bids and the auction
--      is still scheduled, then disposes it. BIN-020984 (the stickered lot, box
--      found on 10-03-01) gets shelf 10-03-01 (section B) and stays in
--      inventory; Jared adds it to an auction himself afterwards. Neither is on an
--      invoice, so no invoice line is touched and nothing is forfeited (0393's
--      rule is not in play).
--   D. Item 18: dispose both BIN-019230 (TEA5008345) and its copy BIN-019231.
--   Not here: A2 (BIN-021730) and B3 (BIN-021034) moved to 0398, held until
--   Jared confirms the boxes.
--   Every lot written gets one operator_audit_log row with the reason.
--
-- GUARDS (re-checked inside this transaction; any failure aborts the whole
-- file and names the BINs):
--   copies (24): exists, not deleted, status in_inventory, NO sticker, 0 bids
--     (bids table and bid_count), not in any auction, no invoice line, no
--     relist child, and same relist parent as its stickered twin, which still
--     carries a sticker.
--   stickered lots in C and D (3): exists, not deleted, status in_inventory,
--     sticker present, 0 bids, not in any auction, no invoice line, no child.
--   B: each lot in_inventory with its sticker, currently on the expected shelf
--     (none / 10-02-01); target bin exists, active, same warehouse.
--   Counts must be exactly 22 copies + 3 pulled/relisted copies (BIN-031438, BIN-031006, BIN-020985) + 1 missing + 1 disposed + 2 shelves.
-- Rerun after a successful apply: NOTICE, no change.
--
-- ROLLBACK: removals are permanent by design (0319 trigger
-- lots_removal_is_terminal: a removed lot cannot change kind or leave
-- 'disposed'). A copy has nothing physical behind it. A "missing" box that
-- turns up is re-lotted, the normal found path (0352/0354). The only reversible
-- writes are the two shelves in B: 0397_ROLLBACK_relot_copies_cleanup_after_shelf_check.sql
-- puts both back.
--
-- WINDOW (Rule 9): staff-visible inventory rows, no customer surface, nothing
-- in a sale. Any time outside 18:00–22:00; best before staff arrive.

BEGIN;

DO $$
DECLARE
  -- copy code, its stickered twin
  v_copies text[][] := ARRAY[
    ['BIN-019326','BIN-019300'],['BIN-019239','BIN-019238'],['BIN-019356','BIN-019354'],
    ['BIN-025076','BIN-025075'],['BIN-019452','BIN-019448'],['BIN-019366','BIN-019363'],
    ['BIN-024828','BIN-024827'],['BIN-021111','BIN-021110'],['BIN-030846','BIN-030845'],
    ['BIN-020917','BIN-020916'],['BIN-020887','BIN-020885'],['BIN-028942','BIN-028941'],
    ['BIN-019353','BIN-019351'],['BIN-021084','BIN-021083'],['BIN-019441','BIN-019439'],
    ['BIN-028999','BIN-028998'],['BIN-029014','BIN-029013'],['BIN-029015','BIN-029013'],
    ['BIN-021093','BIN-021092'],['BIN-020907','BIN-020906'],
    ['BIN-020870','BIN-019489'],
    ['BIN-019231','BIN-019230']];
  v_missing  text[] := ARRAY['BIN-019489'];
  v_dispose  text[] := ARRAY['BIN-019230'];
  -- lot, sticker, current shelf (NULL = none), new shelf
  v_shelves  text[][] := ARRAY[
    ['BIN-028941','PNK4820677','','Right-01-06'],
    ['BIN-020984','PNK4859407','10-02-01','10-03-01']];
  v_from     uuid;
  v_note_tag text := 'mig 0397';
  v_bad      text[] := ARRAY[]::text[];
  v_done     int;
  v_bin      uuid;
  v_n        int;
  i          int;
  r          record;
BEGIN
  -- Already applied? Every target carries the 0397 tag.
  SELECT count(*) INTO v_done FROM lots
   WHERE removal_note LIKE '%' || v_note_tag || '%'
     AND lot_code = ANY (ARRAY(SELECT v_copies[k][1] FROM generate_subscripts(v_copies, 1) k) || v_missing || v_dispose || ARRAY['BIN-031438','BIN-031006','BIN-020985']);
  IF v_done = 27 THEN
    RAISE NOTICE '0397: already applied, nothing to do';
    RETURN;
  ELSIF v_done > 0 THEN
    RAISE EXCEPTION '0397: % of 27 lots already carry the 0397 tag; state is mixed, aborting', v_done;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lots WHERE lot_code = 'BIN-019300') THEN
    RAISE NOTICE '0397: these lots are not in this database, skipping';
    RETURN;
  END IF;

  -- ── guards: copies ────────────────────────────────────────────────────────
  FOR i IN 1 .. array_length(v_copies, 1) LOOP
    SELECT c.id, c.status, c.sticker_code, c.bid_count, c.auction_id, c.deleted_at, c.removal_kind,
           c.relisted_from_lot_id AS parent, m.relisted_from_lot_id AS mate_parent, m.sticker_code AS mate_sticker
      INTO r
      FROM lots c LEFT JOIN lots m ON m.lot_code = v_copies[i][2]
     WHERE c.lot_code = v_copies[i][1]
     FOR UPDATE OF c;
    IF r.id IS NULL
       OR r.deleted_at IS NOT NULL
       OR r.status <> 'in_inventory'
       OR r.removal_kind IS NOT NULL
       OR r.sticker_code IS NOT NULL
       OR coalesce(r.bid_count, 0) <> 0
       OR r.auction_id IS NOT NULL
       OR r.parent IS NULL OR r.parent IS DISTINCT FROM r.mate_parent
       OR r.mate_sticker IS NULL
       OR EXISTS (SELECT 1 FROM bids b WHERE b.lot_id = r.id)
       OR EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = r.id)
       OR EXISTS (SELECT 1 FROM lots k WHERE k.relisted_from_lot_id = r.id AND k.deleted_at IS NULL)
    THEN
      v_bad := v_bad || v_copies[i][1];
    END IF;
  END LOOP;

  -- ── guards: stickered lots to mark missing / dispose ──────────────────────
  FOR r IN
    SELECT w.code, l.id, l.status, l.sticker_code, l.bid_count, l.auction_id, l.deleted_at, l.removal_kind
      FROM unnest(v_missing || v_dispose) AS w(code)
      LEFT JOIN lots l ON l.lot_code = w.code
  LOOP
    IF r.id IS NULL
       OR r.deleted_at IS NOT NULL
       OR r.status <> 'in_inventory'
       OR r.removal_kind IS NOT NULL
       OR r.sticker_code IS NULL
       OR coalesce(r.bid_count, 0) <> 0
       OR r.auction_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM bids b WHERE b.lot_id = r.id)
       OR EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = r.id)
       OR EXISTS (SELECT 1 FROM lots k WHERE k.relisted_from_lot_id = r.id AND k.deleted_at IS NULL)
    THEN
      v_bad := v_bad || r.code;
    END IF;
  END LOOP;
  PERFORM 1 FROM lots WHERE lot_code = ANY (v_missing || v_dispose) FOR UPDATE;

  -- ── guards: item 19 (copy BIN-020985, lot #41 in a scheduled auction) ──────
  IF NOT EXISTS (
       SELECT 1 FROM lots c JOIN lots m ON m.lot_code = 'BIN-020984' AND m.relisted_from_lot_id = c.relisted_from_lot_id
                                       AND m.sticker_raw_upper = 'PNK4859407'
        WHERE c.lot_code = 'BIN-020985'
          AND c.deleted_at IS NULL AND c.sticker_code IS NULL AND c.removal_kind IS NULL
          AND c.status IN ('scheduled', 'canceled', 'in_inventory')
          AND coalesce(c.bid_count, 0) = 0
          AND NOT EXISTS (SELECT 1 FROM bids b WHERE b.lot_id = c.id)
          AND (c.auction_id IS NULL OR EXISTS (SELECT 1 FROM auctions a WHERE a.id = c.auction_id AND a.status IN ('draft', 'scheduled')))
          AND NOT EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM lots g WHERE g.relisted_from_lot_id = c.id AND g.deleted_at IS NULL)) THEN
    v_bad := v_bad || 'BIN-020985 (not a stickerless copy of BIN-020984 with no bids, no invoice line, in no live auction)'::text;
  END IF;
  PERFORM 1 FROM lots WHERE lot_code = 'BIN-020985' FOR UPDATE;

  -- ── guards: item 23 (BIN-031438 relist of copy BIN-031006) ─────────────────
  IF NOT EXISTS (
       SELECT 1 FROM lots k JOIN lots c ON c.id = k.relisted_from_lot_id
        WHERE k.lot_code = 'BIN-031438' AND c.lot_code = 'BIN-031006'
          AND k.deleted_at IS NULL AND k.sticker_code IS NULL AND k.removal_kind IS NULL
          AND k.status IN ('scheduled', 'canceled', 'in_inventory')
          AND (k.auction_id IS NULL OR EXISTS (SELECT 1 FROM auctions a WHERE a.id = k.auction_id AND a.status IN ('draft', 'scheduled')))
          AND NOT EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = k.id)
          AND NOT EXISTS (SELECT 1 FROM lots g WHERE g.relisted_from_lot_id = k.id AND g.deleted_at IS NULL)) THEN
    v_bad := v_bad || 'BIN-031438 (not a stickerless, unsold, not-live relist of BIN-031006)'::text;
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM lots c JOIN lots m ON m.lot_code = 'BIN-031005' AND m.relisted_from_lot_id = c.relisted_from_lot_id AND m.sticker_code IS NOT NULL
        WHERE c.lot_code = 'BIN-031006' AND c.deleted_at IS NULL AND c.sticker_code IS NULL AND c.removal_kind IS NULL
          AND c.status = 'relisted'
          AND NOT EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = c.id)
          AND (SELECT count(*) FROM lots g WHERE g.relisted_from_lot_id = c.id AND g.deleted_at IS NULL) = 1) THEN
    v_bad := v_bad || 'BIN-031006 (not the relisted copy of BIN-031005 with exactly one child)'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lots WHERE lot_code = 'BIN-031005' AND status = 'in_inventory' AND sticker_raw_upper = 'TEA4841964'
                    AND deleted_at IS NULL AND removal_kind IS NULL) THEN
    v_bad := v_bad || 'BIN-031005 (expected in inventory with sticker TEA4841964)'::text;
  END IF;
  PERFORM 1 FROM lots WHERE lot_code IN ('BIN-031438', 'BIN-031006') FOR UPDATE;

  -- ── guards: shelves ──────────────────────────────────────────────────────
  FOR i IN 1 .. array_length(v_shelves, 1) LOOP
    v_bin := NULL; v_from := NULL;
    SELECT b.id INTO v_bin
      FROM bins b JOIN lots l ON l.lot_code = v_shelves[i][1] AND l.warehouse_id = b.warehouse_id
     WHERE b.code = v_shelves[i][4] AND b.is_active;
    IF v_shelves[i][3] <> '' THEN
      SELECT b.id INTO v_from
        FROM bins b JOIN lots l ON l.lot_code = v_shelves[i][1] AND l.warehouse_id = b.warehouse_id
       WHERE b.code = v_shelves[i][3];
    END IF;
    IF v_bin IS NULL OR NOT EXISTS (
         SELECT 1 FROM lots WHERE lot_code = v_shelves[i][1] AND status = 'in_inventory' AND deleted_at IS NULL
            AND sticker_raw_upper = v_shelves[i][2] AND removal_kind IS NULL
            AND intake_bin_id IS NOT DISTINCT FROM v_from)
       OR (v_shelves[i][3] <> '' AND v_from IS NULL) THEN
      v_bad := v_bad || (v_shelves[i][1] || ' (shelf ' || coalesce(nullif(v_shelves[i][3], ''), 'none') || ' -> ' || v_shelves[i][4] || ')');
    END IF;
  END LOOP;
  PERFORM 1 FROM lots WHERE lot_code IN (SELECT v_shelves[k][1] FROM generate_subscripts(v_shelves, 1) k) FOR UPDATE;

  IF array_length(v_bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION '0397: precheck failed for %; nothing changed', array_to_string(v_bad, ', ');
  END IF;

  -- ── A + C + D copies: dispose ─────────────────────────────────────────────
  FOR i IN 1 .. array_length(v_copies, 1) LOOP
    INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
    SELECT l.operator_id, NULL, 'lot.disposed_duplicate_copy', l.id,
           jsonb_build_object('lot_code', l.lot_code, 'status', l.status, 'intake_bin_id', l.intake_bin_id, 'flagged_for_disposal', l.flagged_for_disposal),
           jsonb_build_object('status', 'disposed', 'removal_kind', 'other', 'real_lot', v_copies[i][2]),
           'mig 0397: stickerless double-relot copy of ' || v_copies[i][2] || '; shelf check 2026-10-06 (Jared). Approved by Braden 2026-10-06.'
      FROM lots l WHERE l.lot_code = v_copies[i][1];
    UPDATE lots
       SET status               = 'disposed',
           removal_kind         = 'other',
           removed_at           = now(),
           removal_note         = 'duplicate relot copy of ' || v_copies[i][2] || ' (double relot); shelf check 2026-10-06. ' || v_note_tag,
           flagged_for_disposal = TRUE,
           flagged_at           = COALESCE(flagged_at, now()),
           flagged_reason       = COALESCE(flagged_reason, 'removed: duplicate relot copy'),
           updated_at           = now()
     WHERE lot_code = v_copies[i][1] AND status = 'in_inventory';
  END LOOP;

  -- ── items 19 + 23: take BIN-031438 and BIN-020985 out of their sales and dispose them, and BIN-031006 ──
  FOR r IN SELECT * FROM (VALUES
      ('BIN-031438', 'stickerless relist of copy BIN-031006 (item 23); the box was found and stays on the stickered BIN-031005; taken out of the sale before it opened, its pre-bid void, no charge'),
      ('BIN-031006', 'duplicate relot copy of BIN-031005 (item 23), relisted 2026-10-07 as BIN-031438; the real lot BIN-031005 stays in inventory'),
      ('BIN-020985', 'stickerless relot copy of BIN-020984 (item 19, display code PNK4859407), lot #41 in Boo, Bid & Buy; taken out of the sale before it opened, no bids; the box (found on 10-03-01) stays on the stickered BIN-020984')
    ) AS d(code, why)
  LOOP
    INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
    SELECT l.operator_id, NULL, 'lot.disposed_duplicate_copy', l.id,
           jsonb_build_object('lot_code', l.lot_code, 'status', l.status, 'auction_id', l.auction_id, 'lot_number', l.lot_number,
                              'close_at', l.close_at, 'bid_count', l.bid_count, 'intake_bin_id', l.intake_bin_id),
           jsonb_build_object('status', 'disposed', 'removal_kind', 'other', 'auction_id', NULL),
           'mig 0397: ' || r.why || '. Approved by Braden 2026-10-08.'
      FROM lots l WHERE l.lot_code = r.code;
    UPDATE lots
       SET status               = 'disposed',
           removal_kind         = 'other',
           removed_at           = now(),
           removal_note         = r.why || '. ' || v_note_tag,
           auction_id           = CASE WHEN lot_code IN ('BIN-031438', 'BIN-020985') THEN NULL ELSE auction_id END,
           lot_number           = CASE WHEN lot_code IN ('BIN-031438', 'BIN-020985') THEN NULL ELSE lot_number END,
           close_at             = CASE WHEN lot_code IN ('BIN-031438', 'BIN-020985') THEN NULL ELSE close_at END,
           flagged_for_disposal = TRUE,
           flagged_at           = COALESCE(flagged_at, now()),
           flagged_reason       = COALESCE(flagged_reason, 'removed: duplicate relot copy'),
           updated_at           = now()
     WHERE lot_code = r.code AND status IN ('scheduled', 'canceled', 'in_inventory', 'relisted');
  END LOOP;

  -- ── C: stickered lots not on the shelf → missing ──────────────────────────
  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  SELECT l.operator_id, NULL, 'lot.marked_missing', l.id,
         jsonb_build_object('lot_code', l.lot_code, 'status', l.status, 'intake_bin_id', l.intake_bin_id, 'sticker', l.sticker_raw_upper),
         jsonb_build_object('status', 'disposed', 'removal_kind', 'missing'),
         'mig 0397: not on its shelf at the 2026-10-06 shelf check (Jared). Approved by Braden 2026-10-06.'
    FROM lots l WHERE l.lot_code = ANY (v_missing);
  UPDATE lots
     SET status               = 'disposed',
         removal_kind         = 'missing',
         removed_at           = now(),
         removal_note         = 'not found on shelf at the 2026-10-06 shelf check. ' || v_note_tag,
         flagged_for_disposal = TRUE,
         flagged_at           = COALESCE(flagged_at, now()),
         flagged_reason       = COALESCE(flagged_reason, 'removed: missing'),
         updated_at           = now()
   WHERE lot_code = ANY (v_missing) AND status = 'in_inventory';

  -- ── D: stickered lot disposed ────────────────────────────────────────
  FOR r IN
    SELECT * FROM (VALUES
      ('BIN-019230', 'disposed with its copy BIN-019231 after the 2026-10-06 shelf check')
    ) AS d(code, why)
  LOOP
    INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
    SELECT l.operator_id, NULL, 'lot.disposed', l.id,
           jsonb_build_object('lot_code', l.lot_code, 'status', l.status, 'intake_bin_id', l.intake_bin_id, 'sticker', l.sticker_raw_upper, 'sticker_code', l.sticker_code),
           jsonb_build_object('status', 'disposed', 'removal_kind', 'other'),
           'mig 0397: ' || r.why || ' (Jared). Approved by Braden 2026-10-06.'
      FROM lots l WHERE l.lot_code = r.code;
    UPDATE lots
       SET status               = 'disposed',
           removal_kind         = 'other',
           removed_at           = now(),
           removal_note         = r.why || '. ' || v_note_tag,
           flagged_for_disposal = TRUE,
           flagged_at           = COALESCE(flagged_at, now()),
           flagged_reason       = COALESCE(flagged_reason, 'removed: other'),
           updated_at           = now()
     WHERE lot_code = r.code AND status = 'in_inventory';
  END LOOP;

  -- ── B: shelves ────────────────────────────────────────────────────────────
  FOR i IN 1 .. array_length(v_shelves, 1) LOOP
    SELECT b.id INTO v_bin
      FROM bins b JOIN lots l ON l.lot_code = v_shelves[i][1] AND l.warehouse_id = b.warehouse_id
     WHERE b.code = v_shelves[i][4];
    INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
    SELECT l.operator_id, NULL, 'lot.shelf_set', l.id,
           jsonb_build_object('lot_code', l.lot_code, 'intake_bin_id', l.intake_bin_id, 'bin', nullif(v_shelves[i][3], '')),
           jsonb_build_object('intake_bin_id', v_bin, 'bin', v_shelves[i][4]),
           'mig 0397: box found on ' || v_shelves[i][4] || ' at the 2026-10-06 shelf check (Jared). Approved by Braden 2026-10-06.'
      FROM lots l WHERE l.lot_code = v_shelves[i][1];
    UPDATE lots SET intake_bin_id = v_bin, updated_at = now()
     WHERE lot_code = v_shelves[i][1];
  END LOOP;

  -- ── post-check ────────────────────────────────────────────────────────────
  SELECT count(*) INTO v_n FROM lots
   WHERE removal_note LIKE '%' || v_note_tag || '%' AND status = 'disposed';
  IF v_n <> 27 THEN
    RAISE EXCEPTION '0397: expected 27 lots disposed/missing, got %; aborting', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM lots l JOIN bins b ON b.id = l.intake_bin_id
   WHERE (l.lot_code, b.code) IN (('BIN-028941', 'Right-01-06'), ('BIN-020984', '10-03-01'));
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0397: expected 2 shelves set, got %; aborting', v_n;
  END IF;
END $$;

COMMIT;
