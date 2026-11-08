-- 0354 — putting an item back on the shelf it is already recorded on must
--        count as having found it.
--
-- ── THE REPORT ──────────────────────────────────────────────────────────────
-- Owner, 2026-09-11, example lot BRN4981674: "Staff physically put the item
-- away through the Putaway screen, but the missing flag does not clear. When
-- they return to Relot, the same error appears and still blocks the item."
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- 0345 blocks relisting an item refunded as MISSING until somebody finds it,
-- and clears on any of three signals: lots.intake_at moving past the missing
-- mark, a lot_location_events row after it, or a bin_assignments row after it.
--
-- All three are unreachable for the item staff are actually holding.
--
--   1. intake_at is only written on the `pending_intake` branch of
--      intake_lot_to_bin. 0273 removed the status gate so any lot can have its
--      location corrected, and made every other status LOCATION-ONLY —
--      deliberately, since intake_at means "when this first entered stock".
--      A 'won' lot put away therefore never advances it.
--
--   2. lot_location_events is written by the lots_log_intake_move TRIGGER,
--      which returns early when intake_bin_id IS NOT DISTINCT FROM the old
--      value. No bin change, no event.
--
--   3. bin_assignments is only UPDATEd by put-away (syncing a staged row), and
--      only INSERTed when staging for pickup. Put-away never creates one.
--
-- And the case that matters most hits none of them: when the box is put back
-- on the shelf it was always recorded on, all three put-away RPCs take the
-- `ok_already_here` early return, which reports success and writes NOTHING —
-- no UPDATE, so not even the trigger fires.
--
-- BRN4981674 is exactly that: intake_at 2026-05-27, called missing
-- 2026-07-07, no location event, no bin assignment, and a bin already on file.
-- Staff scan it, the screen says done, and the flag cannot move.
--
-- Not an edge case. Of 238 lots ever marked missing, 227 are still blocked,
-- and 225 of those already have a bin recorded — so for essentially every
-- affected item, the guard cannot be cleared from the floor at all.
--
-- 0345's own header set the standard this failed: "a guard staff cannot clear
-- from the floor is worse than the bug it prevents."
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- Record the physical act. A staffer standing at the shelf with the box in
-- hand, scanning it to the bin it belongs in, is the event 0345 wants to hear
-- about — the bin simply did not change, which is not the same as nothing
-- having happened. So the `ok_already_here` branch of all three put-away RPCs
-- now writes a lot_location_events row before returning.
--
-- kind = 'intake' because the CHECK allows only 'intake' and 'staged', and
-- because that is what it is: the item is on its intake shelf, confirmed by a
-- person. This also repairs Lot Lookup's location history, which until now
-- silently omitted every put-away that did not move a box.
--
-- Deliberately NOT done: retroactively clearing the 227. Nobody has laid hands
-- on those items; writing a "found" record for them would be inventing the one
-- fact the guard exists to establish. They clear when somebody scans them,
-- which now works. BRN4981674 needs one re-scan.
--
-- Surgical patch rather than a re-paste: these three functions carry put-away
-- rules amended repeatedly (0273 and the duplicate-put-away work), and
-- re-pasting from a migration file risks reverting a later fix. Each anchor
-- must match exactly once or the migration aborts having changed nothing.

DO $mig$
DECLARE
  v_src TEXT;
  v_new TEXT;
  v_n   INT;

  -- The event every path now writes. v_lot / v_bin are named identically in
  -- all three functions, so one snippet serves.
  c_log CONSTANT TEXT :=
'          -- 0354: the bin did not change, but a person physically confirmed
          -- this box is on its shelf. That is what clears 0345''s missing
          -- guard, and it belongs in the location history either way.
          INSERT INTO lot_location_events (lot_id, bin_id, kind, actor_id)
          VALUES (v_lot.id, v_bin.id, ''intake'', auth.uid());
';

  -- (function signature, anchor line) — anchor is the first line of the
  -- ok_already_here branch body in each.
  c_targets CONSTANT TEXT[][] := ARRAY[
    ARRAY['public.intake_lot_to_bin(text,uuid)',
          '    v_result := (true, ''ok_already_here'', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, v_bin.code);'],
    ARRAY['public.confirm_move_lot_to_bin(uuid,uuid)',
          '    v_result := (true, ''ok_already_here'', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, v_bin.code);'],
    ARRAY['public.batch_intake_lot_to_bin(text[],uuid)',
          '          code          := ''ok_already_here'';']
  ];
  v_sig    TEXT;
  v_anchor TEXT;
  i INT;
BEGIN
  FOR i IN 1 .. array_length(c_targets, 1) LOOP
    v_sig    := c_targets[i][1];
    v_anchor := c_targets[i][2];

    v_src := pg_get_functiondef(v_sig::regprocedure);

    IF v_src LIKE '%0354%' THEN
      RAISE NOTICE '0354 already applied to %; skipping.', v_sig;
      CONTINUE;
    END IF;

    v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
    IF v_n <> 1 THEN
      RAISE EXCEPTION
        '0354 aborted: anchor for % matched % times, expected exactly 1. '
        'The deployed body has drifted — re-derive the anchor.', v_sig, v_n;
    END IF;

    v_new := replace(v_src, v_anchor, c_log || v_anchor);
    EXECUTE v_new;
    RAISE NOTICE '0354 patched %', v_sig;
  END LOOP;
END
$mig$;

COMMENT ON FUNCTION public.intake_lot_to_bin(text, uuid) IS
  '0273/0354: put one lot away. Any status may have its location corrected; '
  'only pending_intake flips to in_inventory and advances intake_at. Scanning '
  'a lot to the bin it is already on now records a lot_location_events row — '
  'the box was physically handled, which is what clears 0345''s missing guard.';
