-- 0300 — clear_sticker_code(): remove a wrongly-bound sticker code
--
-- Request (2026-07-29): "Lotters need the ability to correct mistakes made
-- during lot creation. For example, if someone accidentally scans an LPN, a
-- SKU, or the wrong pre-sticker code, there is currently no way to remove or
-- replace the bound sticker code... Please add the ability for authorized
-- lotters to remove an incorrect pre-bound sticker code, replace it with the
-- correct one, and delete an accidentally created lot before it enters an
-- auction."
--
-- Two of those three already existed and simply were not reachable from the
-- screen where staff notice the mistake:
--   replace -> rebind_sticker_code (0249)
--   delete  -> discard_lot
-- Both were only wired into the post-save panel on the quick-lotting screen, so
-- once the lotter navigated away the capability was gone. That is surfaced in
-- the app alongside this migration.
--
-- REMOVE had no implementation at all, which is this function. It is the case
-- that matters when the scanned value is not a sticker in the first place -- an
-- LPN or a retail SKU -- because there is no correct code to rebind to yet: the
-- lotter needs the bad value off the lot now and will bind the real sticker
-- when they find it.
--
-- Mirrors rebind_sticker_code exactly on: staff auth via current_operator_id(),
-- the floor-recovery status gate (pending_intake / in_inventory / draft -- a lot
-- that reached an auction or a buyer goes through the console, not a lotting
-- fix), idempotency, operator_audit_log, and the jsonb {ok, reason} shape.
--
-- Releasing the pool row is the part that is easy to get wrong. claim_sticker_code
-- and rebind_sticker_code stamp lot_sticker_pool.claimed_at/claimed_by_lot_id
-- when the code matches a pre-printed sticker. If a clear left that stamp
-- behind, the physical sticker would be permanently unclaimable -- the whole
-- point of clearing is usually that this lot never should have held it. So the
-- pool row is released, but ONLY where it is still claimed by THIS lot.

BEGIN;

CREATE OR REPLACE FUNCTION public.clear_sticker_code(p_lot_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_op_id UUID;
  v_lot   lots%ROWTYPE;
BEGIN
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id;
  IF v_lot.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  IF v_lot.operator_id <> v_op_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_other_operator');
  END IF;

  -- Same floor-recovery scope as rebind_sticker_code and discard_lot.
  IF v_lot.status NOT IN ('pending_intake', 'in_inventory', 'draft') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_editable',
      'status', v_lot.status);
  END IF;

  -- Nothing bound: succeed rather than error, so a double-tap is harmless.
  IF v_lot.sticker_code IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id, 'idempotent', true,
      'previous_sticker_code', NULL);
  END IF;

  -- Release the pre-printed pool row so the physical sticker can be claimed by
  -- the lot it actually belongs to. Scoped to this lot's own claim so we can
  -- never free a sticker another lot legitimately holds.
  UPDATE lot_sticker_pool
     SET claimed_at = NULL, claimed_by_lot_id = NULL
   WHERE sticker_code = v_lot.sticker_code
     AND operator_id = v_op_id
     AND claimed_by_lot_id = p_lot_id;

  UPDATE lots
     SET sticker_code = NULL, updated_at = now()
   WHERE id = p_lot_id;

  INSERT INTO operator_audit_log
    (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES
    (v_op_id, auth.uid(), 'lot_sticker_cleared', p_lot_id,
     jsonb_build_object('sticker_code', v_lot.sticker_code),
     jsonb_build_object('sticker_code', NULL),
     'cleared from lotting scan recovery');

  RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id, 'idempotent', false,
    'previous_sticker_code', v_lot.sticker_code);
END;
$function$;

REVOKE ALL ON FUNCTION public.clear_sticker_code(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_sticker_code(UUID) TO authenticated;

COMMENT ON FUNCTION public.clear_sticker_code(UUID) IS
  '0300: remove a wrongly-bound sticker_code from a lot (LPN/SKU/wrong sticker '
  'scanned during lotting). Floor-recovery scope only — pending_intake, '
  'in_inventory, draft. Releases this lot''s lot_sticker_pool claim so the '
  'physical sticker can be re-claimed, audit-logs as lot_sticker_cleared, and '
  'is idempotent when nothing is bound. Returns jsonb {ok, reason}.';

COMMIT;
