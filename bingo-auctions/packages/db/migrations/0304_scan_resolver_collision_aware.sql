-- 0304 — a scanned label resolves to the DEAD ancestor, not the live item
--
-- Field report 2026-07-30 (lot PNK4858852) said one printed label reported two
-- different states depending on which screen you scanned it into. This is not
-- a one-off data glitch: it is the designed-in consequence of how relist moves
-- a physical identity, and on prod today it affects 855 lot pairs.
--
-- ── How the collision is minted ────────────────────────────────────────────
--
-- `relist_lot_into_auction` (0192 STEP 1/2, 0213) hands the physical identity
-- down to the child and leaves the parent as a tombstone:
--
--     parent: lot_code='PNK4858852'  sticker_code=NULL           status=relisted
--     child:  lot_code='BIN-001737'  sticker_code='BIN:PNK4858852' status=live
--
-- 0213 is explicit about it — when a legacy-coded source has no sticker, the
-- child's sticker is DERIVED from the source's `lot_code`. So after any relist
-- of a legacy lot, the raw label on the box is simultaneously
--   • the parent's `lot_code`, and
--   • the raw half of the child's `sticker_code`.
--
-- `claim_sticker_code` / `rebind_sticker_code` (0283) refuse a raw code that is
-- an ACTIVE lot's lot_code but deliberately allow retired ones, precisely so
-- this carryover keeps working. The collision is therefore permanent and
-- intended; what is NOT intended is that resolvers pick the wrong side of it.
--
-- Prod counts, 2026-07-31 (raw sticker half == some other lot's lot_code):
--
--     ancestor    child            pairs   linked by relisted_from_lot_id
--     relisted    won                272   256
--     canceled    unsold             154   113
--     canceled    won                136   108
--     canceled    live                87    32
--     relisted    unsold              84    68
--     relisted    live                55    42
--     … 67 more across 12 status pairs
--     ─────────────────────────────────────────────────────────────────
--     TOTAL                          855   667 linked / 188 UNLINKED
--
-- 142 of those have a LIVE child right now and 408 have a WON child. The 188
-- unlinked pairs matter for the fix: `relisted_from_lot_id` does not point at
-- the collided ancestor, so a lineage walk alone cannot repair them. Only
-- matching the scanned code against BOTH identifier columns does.
--
-- ── What was wrong ─────────────────────────────────────────────────────────
--
-- `_find_lot_by_scan` (backing `intake_lot_to_bin` and `staff_scan_lot_owner`)
-- probed identifier columns in a fixed order and returned the FIRST hit:
--
--     1. qr_token   2. lot_code   3. sticker_code   4. lpn   5. fnsku …
--
-- `lot_code` at step 2 beats `sticker_code` at step 3, so for all 855 pairs a
-- scan of the box label short-circuits on the tombstone — which reports no
-- auction and the bin the item left weeks ago. It also had no `deleted_at`
-- filter (contradicting 0057, which the client-side put-away resolver honours)
-- and no notion that `relisted`/`canceled`/`disposed` rows are history.
--
-- `batch_intake_lot_to_bin` carries its own inline copy of the same ladder with
-- the same ordering, so the bug is identical there.
--
-- ── The rule ───────────────────────────────────────────────────────────────
--
-- Stop short-circuiting. Gather EVERY row any probe matches, then rank:
--
--     1. active before retired  (canceled/relisted/disposed sort last)
--     2. then by which field matched — the physical sticker outranks the
--        canonical lot_code, because the sticker is what is stuck to the box
--     3. then newest, which is the relist child by construction
--
-- and if the winner is still retired, walk `relisted_from_lot_id` FORWARD to
-- the incarnation that is actually on the floor. This mirrors `preferActiveLot`
-- (packages/shared) and `findLotsByAnyCode` (operator-web/src/lib/lot-lineage),
-- so the scanners, the storefront, and the RPCs finally agree on one answer.
--
-- Deliberately NOT changed:
--   • the JSONB return SHAPE of `_find_lot_by_scan` — callers read `ok`, `lot`,
--     `matched_field`. Two informational keys are ADDED (`alternates`,
--     `hopped_from`); nothing is removed or renamed.
--   • operator scoping stays exactly where 0-era code put it: `qr_token` and
--     `lot_code` are globally unique so they are probed unscoped, and callers
--     keep their own `lot_other_operator` branch. Narrowing that here would
--     silently turn a diagnosable cross-tenant scan into `not_found`.
--   • `relist_lot_into_auction` and the sticker-claim guards. The collision is
--     load-bearing for identity carryover; the read side is what was broken.
--
-- Behaviour change worth calling out: soft-deleted lots no longer resolve.
-- 0057 already ruled that a trashed lot must be restored before intake, and the
-- client resolver enforced it — the RPCs simply never got the filter.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. _find_lot_by_scan — gather-then-rank, with a forward lineage hop.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._find_lot_by_scan(p_candidates TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op         UUID := public.current_operator_id();
  v_op_code    TEXT;
  v_cand       TEXT;
  v_clean      TEXT;
  v_uuid       UUID;
  v_lot        lots%ROWTYPE;
  v_lot_id     UUID;
  v_rank       INT;
  v_field      TEXT;
  v_alternates INT;
  v_hopped     TEXT;
  v_child_id   UUID;
  v_seen       UUID[];
  v_i          INT;
BEGIN
  IF v_op IS NULL THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT code INTO v_op_code FROM public.operators WHERE id = v_op;

  FOREACH v_cand IN ARRAY p_candidates LOOP
    v_clean := TRIM(COALESCE(v_cand, ''));
    IF v_clean = '' THEN
      CONTINUE;
    END IF;

    -- Parse once; a non-UUID candidate simply skips the qr_token probe rather
    -- than aborting the statement (the old code wrapped every probe in its own
    -- exception block to get this).
    BEGIN
      v_uuid := v_clean::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      v_uuid := NULL;
    END;

    -- One pass over every identifier column. `field_rank` encodes which probe
    -- matched; the ORDER BY, not the probe order, decides the winner.
    -- `total` counts every row the code is ambiguous across (window function,
    -- so it is computed before the LIMIT).
    v_lot_id     := NULL;
    v_rank       := NULL;
    v_alternates := 1;

    SELECT c.id, c.field_rank, c.total
      INTO v_lot_id, v_rank, v_alternates
    FROM (
      SELECT
        l2.id,
        CASE
          WHEN v_uuid IS NOT NULL AND l2.qr_token = v_uuid                     THEN 1
          WHEN v_op_code IS NOT NULL
               AND l2.sticker_code = v_op_code || ':' || v_clean               THEN 2
          WHEN l2.sticker_code = v_clean                                       THEN 3
          WHEN upper(l2.lot_code) = upper(v_clean)                             THEN 4
          WHEN upper(l2.legacy_lot_code) = upper(v_clean)                      THEN 5
          WHEN l2.operator_id = v_op AND l2.lpn = v_clean                      THEN 6
          WHEN l2.operator_id = v_op AND l2.fnsku = v_clean                    THEN 7
          WHEN l2.operator_id = v_op AND l2.external_code = v_clean            THEN 8
          WHEN l2.operator_id = v_op AND l2.asin = v_clean                     THEN 9
        END AS field_rank,
        -- Retired rows are history: a relisted/canceled/disposed row is never
        -- the item on the shelf when a live twin answers to the same code.
        (l2.status IN ('canceled', 'relisted', 'disposed')) AS retired,
        l2.created_at,
        COUNT(*) OVER () AS total
      FROM public.lots l2
      WHERE l2.deleted_at IS NULL
        AND (
             (v_uuid IS NOT NULL AND l2.qr_token = v_uuid)
          OR (v_op_code IS NOT NULL AND l2.sticker_code = v_op_code || ':' || v_clean)
          OR l2.sticker_code = v_clean
          OR upper(l2.lot_code) = upper(v_clean)
          OR upper(l2.legacy_lot_code) = upper(v_clean)
          OR (l2.operator_id = v_op AND l2.lpn = v_clean)
          OR (l2.operator_id = v_op AND l2.fnsku = v_clean)
          OR (l2.operator_id = v_op AND l2.external_code = v_clean)
          OR (l2.operator_id = v_op AND l2.asin = v_clean)
        )
    ) c
    ORDER BY
      c.retired ASC,       -- 1. the live incarnation wins outright
      c.field_rank ASC,    -- 2. the sticker on the box beats the lot_code
      c.created_at DESC    -- 3. newest — the relist child, by construction
    LIMIT 1;

    IF v_lot_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_lot FROM public.lots WHERE id = v_lot_id;

    v_field := CASE v_rank
      WHEN 1 THEN 'qr_token'
      WHEN 2 THEN 'sticker_code'
      WHEN 3 THEN 'sticker_code'
      WHEN 4 THEN 'lot_code'
      WHEN 5 THEN 'legacy_lot_code'
      WHEN 6 THEN 'lpn'
      WHEN 7 THEN 'fnsku'
      WHEN 8 THEN 'external_code'
      WHEN 9 THEN 'asin'
    END;

    -- Only reachable when EVERY match is retired (the 188 prod pairs whose
    -- ancestor and child are not linked are already handled above, by the
    -- sticker probe finding the child directly). Walk forward to whatever the
    -- item became. Bounded + cycle-guarded, matching MAX_LINEAGE_HOPS on the
    -- client.
    v_hopped := NULL;
    IF v_lot.status IN ('canceled', 'relisted', 'disposed') THEN
      v_seen := ARRAY[v_lot.id];
      FOR v_i IN 1..5 LOOP
        v_child_id := NULL;
        SELECT c.id INTO v_child_id
        FROM public.lots c
        WHERE c.relisted_from_lot_id = v_lot.id
          AND c.deleted_at IS NULL
          AND NOT (c.id = ANY(v_seen))
        ORDER BY
          (c.status IN ('canceled', 'relisted', 'disposed')) ASC,
          c.created_at DESC
        LIMIT 1;

        EXIT WHEN v_child_id IS NULL;

        v_hopped := COALESCE(v_hopped, v_lot.lot_code);
        v_seen   := v_seen || v_child_id;
        SELECT * INTO v_lot FROM public.lots WHERE id = v_child_id;

        EXIT WHEN v_lot.status NOT IN ('canceled', 'relisted', 'disposed');
      END LOOP;
    END IF;

    RETURN jsonb_build_object(
      'ok', true,
      'lot', to_jsonb(v_lot),
      'matched_field', v_field,
      -- >0 means the scanned code is ambiguous and this row won the ranking.
      -- Callers may surface it; none are required to.
      'alternates', GREATEST(COALESCE(v_alternates, 1) - 1, 0),
      -- Non-null when the matched row was a tombstone and we followed the
      -- relist chain forward; carries the code that was actually scanned onto.
      'hopped_from', v_hopped
    );
  END LOOP;

  RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
END;
$$;

REVOKE ALL ON FUNCTION public._find_lot_by_scan(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._find_lot_by_scan(TEXT[]) TO authenticated;

COMMENT ON FUNCTION public._find_lot_by_scan(TEXT[]) IS
  '0304: resolve a scanned/typed code to ONE lot. Probes qr_token, sticker_code '
  '(operator-prefixed and bare), lot_code, legacy_lot_code, lpn, fnsku, '
  'external_code and asin in a single pass, then ranks active-before-retired, '
  'sticker-before-lot_code, newest-last-resort, and hops forward down '
  'relisted_from_lot_id when every match is a tombstone. Replaces the 0-era '
  'first-hit ladder, which put lot_code ahead of sticker_code and so returned '
  'the retired ancestor for all 855 relist-carryover collisions on prod. '
  'Excludes soft-deleted lots (0057). Adds informational `alternates` and '
  '`hopped_from` keys; the rest of the JSONB shape is unchanged.';

-- ---------------------------------------------------------------------------
-- 2. batch_intake_lot_to_bin — drop the duplicated ladder, call the resolver.
--
-- 0175's inline probe order (qr_token → lot_code → prefixed sticker) is the
-- same first-hit ladder fixed above, so put-away-by-batch mis-resolved exactly
-- like single intake. Everything after resolution is 0273 verbatim.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.batch_intake_lot_to_bin(
  p_lot_identifiers TEXT[],
  p_bin_qr_token UUID
)
RETURNS TABLE (
  identifier    TEXT,
  ok            BOOLEAN,
  code          TEXT,
  lot_id        UUID,
  lot_code      TEXT,
  sticker_code  TEXT,
  bin_code      TEXT,
  from_bin_code TEXT,
  error         TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
  v_op_id        UUID;
  v_bin          bins%ROWTYPE;
  v_bin_op       UUID;
  v_lot          lots%ROWTYPE;
  v_old_bin_id   UUID;
  v_old_bin_code TEXT;
  v_identifier   TEXT;
  v_find         JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT operator_id INTO v_bin_op FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_op IS DISTINCT FROM v_op_id THEN
    RETURN;
  END IF;

  FOREACH v_identifier IN ARRAY p_lot_identifiers LOOP
    v_lot  := NULL;
    v_find := public._find_lot_by_scan(ARRAY[TRIM(v_identifier)]);

    IF COALESCE((v_find->>'ok')::boolean, false) THEN
      SELECT * INTO v_lot FROM lots WHERE id = (v_find->'lot'->>'id')::UUID;
    END IF;

    IF v_lot.id IS NULL THEN
      identifier    := v_identifier;
      ok            := false;
      code          := 'not_lotted_yet';
      lot_id        := NULL;
      lot_code      := NULL;
      sticker_code  := NULL;
      bin_code      := NULL;
      from_bin_code := NULL;
      error         := 'No lot matched — create a draft in Lotting first.';
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_lot.operator_id <> v_op_id THEN
      identifier    := v_identifier;
      ok            := false;
      code          := 'lot_other_operator';
      lot_id        := v_lot.id;
      lot_code      := v_lot.lot_code;
      sticker_code  := v_lot.sticker_code;
      bin_code      := NULL;
      from_bin_code := NULL;
      error         := 'Lot belongs to a different operator.';
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- 0273: status gate REMOVED. A lot's physical location is independent of
    -- its auction/invoice state (see audit_relocate_lot, mig 0248), so any
    -- status may have its bin corrected here. pending_intake still flips to
    -- in_inventory below; every other status is location-only.
    BEGIN
      IF v_lot.status = 'pending_intake' THEN
        UPDATE lots
        SET status        = 'in_inventory',
            intake_bin_id = v_bin.id,
            warehouse_id  = v_bin.warehouse_id,
            intake_at     = now(),
            updated_at    = now()
        WHERE id = v_lot.id;

        identifier    := v_identifier;
        ok            := true;
        code          := 'ok_intaked';
        lot_id        := v_lot.id;
        lot_code      := v_lot.lot_code;
        sticker_code  := v_lot.sticker_code;
        bin_code      := v_bin.code;
        from_bin_code := NULL;
        error         := NULL;
        RETURN NEXT;
      ELSIF v_lot.intake_bin_id IS NULL THEN
        -- Non-pending lot with no bin yet — place it directly. LOCATION-ONLY:
        -- status stays as-is (flipping draft → in_inventory could fight the
        -- relist pipeline; live/won/unsold keep their auction state).
        UPDATE lots
        SET intake_bin_id = v_bin.id,
            warehouse_id  = v_bin.warehouse_id,
            updated_at    = now()
        WHERE id = v_lot.id;

        -- 0273: keep the customer-facing pickup bin in lockstep — move the
        -- staged pickup assignment too (mirrors audit_relocate_lot). No-op when
        -- the lot has no staged assignment.
        UPDATE bin_assignments
           SET bin_id = v_bin.id
         WHERE lot_id = v_lot.id AND status = 'staged';

        identifier    := v_identifier;
        ok            := true;
        code          := 'ok_intaked';
        lot_id        := v_lot.id;
        lot_code      := v_lot.lot_code;
        sticker_code  := v_lot.sticker_code;
        bin_code      := v_bin.code;
        from_bin_code := NULL;
        error         := NULL;
        RETURN NEXT;
      ELSE
        v_old_bin_id := v_lot.intake_bin_id;
        IF v_old_bin_id IS NOT DISTINCT FROM v_bin.id THEN
          identifier    := v_identifier;
          ok            := true;
          code          := 'ok_already_here';
          lot_id        := v_lot.id;
          lot_code      := v_lot.lot_code;
          sticker_code  := v_lot.sticker_code;
          bin_code      := v_bin.code;
          from_bin_code := v_bin.code;
          error         := NULL;
          RETURN NEXT;
        ELSE
          -- `code` resolves to bins.code (the column) under use_column.
          SELECT code INTO v_old_bin_code FROM bins WHERE id = v_old_bin_id;
          identifier    := v_identifier;
          ok            := false;
          code          := 'pending_move';
          lot_id        := v_lot.id;
          lot_code      := v_lot.lot_code;
          sticker_code  := v_lot.sticker_code;
          bin_code      := v_bin.code;
          from_bin_code := v_old_bin_code;
          error         := 'Lot is in ' || COALESCE(v_old_bin_code, '?') || ' — confirm move.';
          RETURN NEXT;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      identifier    := v_identifier;
      ok            := false;
      code          := 'update_failed';
      lot_id        := v_lot.id;
      lot_code      := v_lot.lot_code;
      sticker_code  := v_lot.sticker_code;
      bin_code      := NULL;
      from_bin_code := NULL;
      error         := SQLERRM;
      RETURN NEXT;
    END;
  END LOOP;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.batch_intake_lot_to_bin(TEXT[], UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.batch_intake_lot_to_bin(TEXT[], UUID) TO authenticated;

COMMENT ON FUNCTION public.batch_intake_lot_to_bin(TEXT[], UUID) IS
  '0304: 0273 behaviour, but code resolution is delegated to _find_lot_by_scan '
  'instead of an inline first-hit ladder that preferred lot_code over '
  'sticker_code and so put stock away against the retired ancestor.';

-- ---------------------------------------------------------------------------
-- 3. staff_confirm_pickup — accept the code that is printed on the box.
--
-- The per-lot flip matched `l.lot_code = <scanned>` exactly. For a relisted
-- item the box carries the ANCESTOR's code while the invoice references the
-- CHILD (whose lot_code is a fresh BIN-######), so scanning the label at the
-- counter matched nothing: the lot counted as `not_found`, stayed in `missing`,
-- and the pickup refused to complete without an explicit override. 408 won lots
-- on prod are in that shape.
--
-- Both the missing-set and the flip now match a supplied code against the
-- lot_code OR the raw half of the sticker_code, case-insensitively. This can
-- only ever match MORE of the invoice's own lots — the query is still scoped to
-- `il.invoice_id = p_invoice_id`, so no other invoice's stock is reachable.
-- Everything else is 0245 verbatim.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_confirm_pickup(
  p_invoice_id       UUID,
  p_lot_codes        TEXT[],
  -- 0245's default must be repeated verbatim: CREATE OR REPLACE cannot drop an
  -- existing parameter default.
  p_allow_incomplete BOOLEAN DEFAULT FALSE
)
RETURNS staff_confirm_pickup_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user           UUID := auth.uid();
  v_operator       UUID;
  v_invoice        invoices%ROWTYPE;
  v_pickup         pickups%ROWTYPE;
  v_lot_id         UUID;
  v_lot_code       TEXT;
  v_already_picked INT := 0;
  v_not_found_ct   INT := 0;
  v_picked_ct      INT := 0;
  v_missing        TEXT[];
  v_remaining_ct   INT := 0;
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

  -- ── Missing = invoice lots not stamped yet and not in this round ──────
  -- 0217: keyed off invoice_lots.picked_up_at (round-stable) instead of
  -- bin_assignments (which never covers never-staged manual-checkout lots).
  -- 0245: refunded lots are not owed — never count them as missing.
  -- 0304: a supplied code may be the box's sticker label, not the lot_code.
  SELECT COALESCE(array_agg(l.lot_code ORDER BY l.lot_code), ARRAY[]::TEXT[])
    INTO v_missing
  FROM invoice_lots il
  JOIN lots l ON l.id = il.lot_id
  WHERE il.invoice_id = p_invoice_id
    AND il.picked_up_at IS NULL
    AND il.refunded_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM unnest(COALESCE(p_lot_codes, ARRAY[]::TEXT[])) AS scanned(code)
      WHERE upper(TRIM(scanned.code)) = upper(l.lot_code)
         OR upper(TRIM(scanned.code)) = upper(split_part(l.sticker_code, ':', 2))
    );

  IF array_length(v_missing, 1) > 0 AND NOT COALESCE(p_allow_incomplete, FALSE) THEN
    -- Money-loss guard (0147): refuse until the caller explicitly opts into
    -- a partial handover. DETAIL carries the missing codes for the client
    -- confirm dialog.
    RAISE EXCEPTION 'pickup_incomplete: %', array_to_string(v_missing, ',')
      USING DETAIL = array_to_string(v_missing, ',');
  END IF;

  -- ── Per-lot flip ──────────────────────────────────────────────────────
  FOREACH v_lot_code IN ARRAY p_lot_codes
  LOOP
    -- 0304: same two-column, case-insensitive match as the missing-set above.
    SELECT l.id INTO v_lot_id
    FROM lots l
    JOIN invoice_lots il ON il.lot_id = l.id
    WHERE il.invoice_id = p_invoice_id
      AND (
        upper(TRIM(v_lot_code)) = upper(l.lot_code)
        OR upper(TRIM(v_lot_code)) = upper(split_part(l.sticker_code, ':', 2))
      )
    LIMIT 1;

    IF NOT FOUND THEN
      v_not_found_ct := v_not_found_ct + 1;
      CONTINUE;
    END IF;

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
    UPDATE pickups
       SET checked_in_at = COALESCE(checked_in_at, now()),
           completed_at  = now(),
           completed_by  = v_user,
           status        = 'completed',
           updated_at    = now()
     WHERE id = v_pickup.id;

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
  '0304: 0245 behaviour, but a supplied code matches the invoice lot by '
  'lot_code OR by the raw half of its sticker_code, case-insensitively — the '
  'box carries the relisted ancestor''s code while the invoice references the '
  'child, so an exact lot_code match left scanned items counted as missing.';

-- ---------------------------------------------------------------------------
-- 4. lot_code_collision_audit — keep the 855 VISIBLE.
--
-- The collision is intended (identity carryover) so it cannot be constrained
-- away, and a fix on the read side is invisible to anyone eyeballing the data.
-- This reports the pairs so a regression in ranking shows up as a wrong
-- `resolves_to` rather than as a field report six weeks later.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lot_code_collision_audit()
RETURNS TABLE (
  scanned_code   TEXT,
  ancestor_id    UUID,
  ancestor_code  TEXT,
  ancestor_status TEXT,
  child_id       UUID,
  child_code     TEXT,
  child_status   TEXT,
  linked         BOOLEAN,
  resolves_to    UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    split_part(child.sticker_code, ':', 2)                       AS scanned_code,
    anc.id, anc.lot_code, anc.status::TEXT,
    child.id, child.lot_code, child.status::TEXT,
    (child.relisted_from_lot_id = anc.id)                        AS linked,
    -- Mirrors _find_lot_by_scan's ranking for this two-row population: the
    -- sticker holder outranks the lot_code holder unless it is the only
    -- retired side.
    (CASE
       WHEN (child.status IN ('canceled','relisted','disposed'))
            AND NOT (anc.status IN ('canceled','relisted','disposed'))
         THEN anc.id
       ELSE child.id
     END)                                                        AS resolves_to
  FROM lots child
  JOIN lots anc
    ON anc.lot_code = split_part(child.sticker_code, ':', 2)
   AND anc.id <> child.id
   AND anc.deleted_at IS NULL
  WHERE child.sticker_code IS NOT NULL
    AND child.deleted_at IS NULL
  ORDER BY 1;
$$;

REVOKE ALL ON FUNCTION public.lot_code_collision_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lot_code_collision_audit() TO authenticated;

COMMENT ON FUNCTION public.lot_code_collision_audit() IS
  '0304: every pair where one lot''s raw sticker label is another lot''s '
  'lot_code — the relist identity carryover (0192/0213). 855 rows on prod at '
  'time of writing. Not a defect list: it is the population _find_lot_by_scan '
  'must rank correctly, and `resolves_to` records which side wins.';

COMMIT;
