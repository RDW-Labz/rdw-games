-- 0509 — staff_confirm_pickup(): resolve every scanned code to exactly ONE
--        invoice line before stamping anything (#808).
--
-- WHY
--
-- 0304 taught the counter to accept the code printed on the box (the raw half
-- of `lots.sticker_code`) as well as `lots.lot_code`. 0487 re-created
-- staff_confirm_pickup with that two-column, case-insensitive match.
--
-- But the match was not unique:
--
--   * the "missing" set treated a line as scanned if ANY supplied code matched
--     it, while the per-lot loop selected the first match with `LIMIT 1` and no
--     ORDER BY;
--   * nothing forbade a canonical lot_code on line A from equalling a sticker
--     code on line B, or two case-distinct stickers.
--
-- With one ambiguous code the gate could therefore call every matching line
-- "scanned" (so no pickup_incomplete refusal) and then stamp ONE arbitrary
-- line — handing over the wrong box and marking the wrong line collected.
-- #803's RED TEAM PASS filed this as #808; the ambiguity predates 0304.
--
-- WHAT
--
-- Re-creates public.staff_confirm_pickup(invoice, codes, allow_incomplete)
-- unchanged EXCEPT for code resolution:
--
--   1. Every DISTINCT supplied code is resolved against this invoice ONCE.
--      A code that matches exactly one lot contributes that lot id to a
--      resolved set; a code that matches nothing is counted as not-found.
--   2. If ANY supplied code matches more than one lot on the invoice, the
--      whole round is refused with 'pickup_code_ambiguous: <codes>' BEFORE any
--      line, bin_assignment, pickup, audit or notification write. Nothing is
--      guessed.
--   3. The missing set and the per-lot flip both use that SAME resolved set,
--      so completeness and mutation cannot disagree about which line a code
--      means.
--
-- Duplicate scans of one code resolve once. Two different codes (lot_code and
-- sticker) resolving to the same lot dedupe to one lot. NULL/empty input is
-- handled as "nothing scanned".
--
-- No money, totals, refunds, notifications or audit shape change. A complete
-- round still queues pickup_confirmed; a partial round still stays
-- 'checked_in' and audits pickup.partial_handover exactly as 0487 does.
--
-- ROLLBACK: re-run the staff_confirm_pickup CREATE OR REPLACE block from
-- packages/db/migrations/0487_undo_invoice_line_pickup.sql (or `git revert`
-- the PR commit). This migration only replaces that one function; no data is
-- touched, so no data restore is needed.

SET lock_timeout = '3s';

CREATE OR REPLACE FUNCTION staff_confirm_pickup(
  p_invoice_id        UUID,
  p_lot_codes         TEXT[],
  p_allow_incomplete  BOOLEAN DEFAULT FALSE
)
RETURNS staff_confirm_pickup_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user           UUID := auth.uid();
  v_operator       UUID;
  v_invoice        invoices%ROWTYPE;
  v_pickup         pickups%ROWTYPE;
  v_lot_id         UUID;
  v_code           TEXT;
  v_lot_ids        UUID[];
  v_resolved       UUID[] := ARRAY[]::UUID[];
  v_ambiguous      TEXT[] := ARRAY[]::TEXT[];
  v_already_picked INT := 0;
  v_not_found_ct   INT := 0;
  v_picked_ct      INT := 0;
  v_missing        TEXT[];
  v_remaining_ct   INT := 0;
  v_pickup_after   TEXT;
  v_warning        TEXT := NULL;
  v_result         staff_confirm_pickup_result;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT operator_id INTO v_operator
    FROM operator_users WHERE user_id = v_user LIMIT 1;
  IF v_operator IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff';
  END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice_not_found';
  END IF;
  IF v_invoice.operator_id <> v_operator THEN
    RAISE EXCEPTION 'invoice_other_operator';
  END IF;
  -- 0245: partially_refunded = paid invoice with some items refunded; the
  -- rest are still owed and must remain collectable at the counter.
  IF v_invoice.status NOT IN ('paid', 'partially_refunded') THEN
    RAISE EXCEPTION 'invoice_not_paid';
  END IF;

  SELECT * INTO v_pickup FROM pickups WHERE invoice_id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pickup_not_found';
  END IF;

  -- Idempotency (unchanged from 0147).
  IF v_pickup.status = 'completed' THEN
    v_result := (
      v_pickup.id,
      (SELECT count(*) FROM bin_assignments ba
       JOIN invoice_lots il ON il.lot_id = ba.lot_id
       WHERE il.invoice_id = p_invoice_id AND ba.status = 'picked_up'),
      'already_completed',
      ARRAY[]::TEXT[]
    );
    RETURN v_result;
  END IF;

  -- ── Resolve every supplied code ONCE (#808) ───────────────────────────
  -- 0304/0487 matched per line with LIMIT 1, so an ambiguous code could look
  -- "scanned" for several lines while only one was stamped. Resolve first and
  -- refuse the round if any code is not unique on this invoice.
  FOR v_code IN
    SELECT DISTINCT upper(TRIM(c.code))
      FROM unnest(COALESCE(p_lot_codes, ARRAY[]::TEXT[])) AS c(code)
  LOOP
    SELECT COALESCE(array_agg(l.id ORDER BY l.id), ARRAY[]::UUID[])
      INTO v_lot_ids
    FROM lots l
    JOIN invoice_lots il ON il.lot_id = l.id
    WHERE il.invoice_id = p_invoice_id
      AND (
        v_code = upper(l.lot_code)
        OR v_code = upper(split_part(l.sticker_code, ':', 2))
      );

    IF array_length(v_lot_ids, 1) IS NULL THEN
      -- No line on this invoice; the not-found count below uses the same
      -- predicate, so an unknown code is reported but not stamped.
      NULL;
    ELSIF array_length(v_lot_ids, 1) > 1 THEN
      v_ambiguous := array_append(v_ambiguous, v_code);
    ELSE
      v_resolved := array_append(v_resolved, v_lot_ids[1]);
    END IF;
  END LOOP;

  IF array_length(v_ambiguous, 1) > 0 THEN
    -- Refuse before the missing-set check or any write: no line, bin, audit or
    -- notification moves when the counter scanned something ambiguous.
    RAISE EXCEPTION 'pickup_code_ambiguous: %', array_to_string(v_ambiguous, ',')
      USING DETAIL = array_to_string(v_ambiguous, ',');
  END IF;

  -- lot_code and sticker of the same line may both be scanned; stamp it once.
  SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::UUID[])
    INTO v_resolved
  FROM unnest(v_resolved) AS x;

  -- Count supplied codes that matched no line on this invoice (the same
  -- two-column predicate as the resolution above, so it cannot disagree).
  SELECT count(*) INTO v_not_found_ct
  FROM unnest(COALESCE(p_lot_codes, ARRAY[]::TEXT[])) AS c(code)
  WHERE NOT EXISTS (
    SELECT 1
    FROM lots l
    JOIN invoice_lots il ON il.lot_id = l.id
    WHERE il.invoice_id = p_invoice_id
      AND (
        upper(TRIM(c.code)) = upper(l.lot_code)
        OR upper(TRIM(c.code)) = upper(split_part(l.sticker_code, ':', 2))
      )
  );

  -- ── Missing = invoice lots not stamped yet and not in this round ──────
  -- 0217: keyed off invoice_lots.picked_up_at (round-stable) instead of
  -- bin_assignments (which never covers never-staged manual-checkout lots).
  -- 0245: refunded lots are not owed — never count them as missing.
  -- 0509: membership in the RESOLVED set, not a re-match per line.
  SELECT COALESCE(array_agg(l.lot_code ORDER BY l.lot_code), ARRAY[]::TEXT[])
    INTO v_missing
  FROM invoice_lots il
  JOIN lots l ON l.id = il.lot_id
  WHERE il.invoice_id = p_invoice_id
    AND il.picked_up_at IS NULL
    AND il.refunded_at IS NULL
    AND NOT (l.id = ANY (v_resolved));

  IF array_length(v_missing, 1) > 0 AND NOT COALESCE(p_allow_incomplete, FALSE) THEN
    -- Money-loss guard (0147): refuse until the caller explicitly opts into
    -- a partial handover. DETAIL carries the missing codes for the client
    -- confirm dialog.
    RAISE EXCEPTION 'pickup_incomplete: %', array_to_string(v_missing, ',')
      USING DETAIL = array_to_string(v_missing, ',');
  END IF;

  -- ── Per-lot flip (resolved lots only) ─────────────────────────────────
  FOREACH v_lot_id IN ARRAY v_resolved
  LOOP
    -- 0217: the authoritative per-lot handover stamp (idempotent).
    -- 0245: also record WHO confirmed the handover.
    UPDATE invoice_lots
       SET picked_up_at = now(),
           picked_up_by = v_user
     WHERE invoice_id = p_invoice_id
       AND lot_id = v_lot_id
       AND picked_up_at IS NULL;

    IF FOUND THEN
      v_picked_ct := v_picked_ct + 1;
    ELSE
      v_already_picked := v_already_picked + 1;
    END IF;

    -- Staging-board state (unchanged from 0147): flip the latest STAGED
    -- assignment; never-staged lots simply have no row to flip.
    WITH latest AS (
      SELECT ba.id
      FROM bin_assignments ba
      WHERE ba.lot_id = v_lot_id
      ORDER BY ba.assigned_at DESC
      LIMIT 1
    )
    UPDATE bin_assignments ba
       SET status = 'picked_up', picked_up_at = now()
      FROM latest
     WHERE ba.id = latest.id
       AND ba.status = 'staged';
  END LOOP;

  -- ── Complete or keep open ─────────────────────────────────────────────
  -- 0245: refunded lots are resolved, not owed.
  SELECT count(*) INTO v_remaining_ct
  FROM invoice_lots
  WHERE invoice_id = p_invoice_id
    AND picked_up_at IS NULL
    AND refunded_at IS NULL;

  IF v_remaining_ct = 0 THEN
    -- #796: read the persisted row back. 0487's BEFORE trigger can keep this
    -- 'checked_in' when a line undone from this visit is still owed (a
    -- concurrent undo can commit after the count above).
    UPDATE pickups
       SET checked_in_at = COALESCE(checked_in_at, now()),
           completed_at  = now(),
           completed_by  = v_user,
           status        = 'completed',
           updated_at    = now()
     WHERE id = v_pickup.id
    RETURNING status::text INTO v_pickup_after;

    IF v_pickup_after = 'completed' THEN
      -- Notification only on FULL completion — a partial handover happened
      -- face-to-face; pinging "pickup confirmed" while lots are still owed
      -- misled bidders (and my-bids keys off the completed pickup).
      PERFORM enqueue_notification(
        'pickup_confirmed',
        v_invoice.bidder_id,
        jsonb_build_object(
          'invoice_id', p_invoice_id,
          'lots_picked', v_picked_ct,
          'lots_missing', 0
        ),
        'pickup_confirmed:staff:' || p_invoice_id::TEXT
      );
    ELSE
      -- The guard refused: an undone line is owed again. Report the round as
      -- partial and audit it exactly like one; no completion notification.
      SELECT count(*) INTO v_remaining_ct
      FROM invoice_lots
      WHERE invoice_id = p_invoice_id
        AND picked_up_at IS NULL
        AND refunded_at IS NULL;

      INSERT INTO operator_audit_log (
        operator_id, actor_user_id, action_type, target_id, before_state, after_state
      ) VALUES (
        v_operator, v_user, 'pickup.partial_handover', p_invoice_id, NULL,
        jsonb_build_object(
          'handed_over_codes', to_jsonb(p_lot_codes),
          'handed_over_count', v_picked_ct,
          'remaining_count', v_remaining_ct,
          'completion_blocked', true
        )
      );

      v_warning := format('partial: %s lot(s) still owed — invoice stays open', v_remaining_ct);
    END IF;
  ELSE
    -- 0217: partial handover — keep the pickup ALIVE so the QR keeps
    -- resolving and the remaining lots stay owed. checked_in marks "the
    -- bidder has been here"; the 0183 no-show sweep only touches
    -- 'pending'/'scheduled' so an open partial is never forfeited.
    UPDATE pickups
       SET checked_in_at = COALESCE(checked_in_at, now()),
           status        = 'checked_in',
           updated_at    = now()
     WHERE id = v_pickup.id;

    -- Audit each partial round (definer insert; log has no client policy).
    INSERT INTO operator_audit_log (
      operator_id, actor_user_id, action_type, target_id, before_state, after_state
    ) VALUES (
      v_operator, v_user, 'pickup.partial_handover', p_invoice_id, NULL,
      jsonb_build_object(
        'handed_over_codes', to_jsonb(p_lot_codes),
        'handed_over_count', v_picked_ct,
        'remaining_count', v_remaining_ct
      )
    );

    v_warning := format('partial: %s lot(s) still owed — invoice stays open', v_remaining_ct);
  END IF;

  IF v_not_found_ct > 0 OR v_already_picked > 0 THEN
    v_warning := COALESCE(v_warning || '; ', '') || format(
      '%s lot(s) not in invoice; %s already picked up',
      v_not_found_ct, v_already_picked
    );
  END IF;

  v_result := (v_pickup.id, v_picked_ct, v_warning, COALESCE(v_missing, ARRAY[]::TEXT[]));
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.staff_confirm_pickup(UUID, TEXT[], BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_confirm_pickup(UUID, TEXT[], BOOLEAN) TO authenticated;

COMMENT ON FUNCTION public.staff_confirm_pickup(UUID, TEXT[], BOOLEAN) IS
  '0245 behavior + 0487 (#796) completion guard + 0509 (#808): every supplied '
  'code is resolved to exactly one invoice line before any write; a code that '
  'matches more than one line raises pickup_code_ambiguous and changes nothing. '
  'A completion the 0487 guard keeps checked_in is reported as a partial round '
  'with no pickup_confirmed notification.';
