-- ============================================================================
-- Migration 0473 — warehouse transfer: named, audited, never silent.
--
-- Why (read-only prod check, 2026-10-27): staff at Harrison put away
-- BRN4983203 (BIN-033984, a Crandall lot) at 4:51 PM. The staff app warned
-- "This item belongs to Crandall inventory. Putting it away here will move it
-- into the location you are working in." and then failed with
-- "lot.warehouse_id (Harrison) must match auction.warehouse_id (Crandall)".
-- The lot was won and paid, then went back to the house as a pickup no-show
-- (won -> unsold, 10-18). It is still attached to its CLOSED Crandall auction,
-- and 0101's trigger refuses any lot whose warehouse differs from its
-- auction's. Every put-away RPC re-homes warehouse_id from the shelf, so the
-- only lots that could move between buildings were ones with no auction; in
-- the whole location history (0328) that has never happened (0 moves).
--
-- What this adds:
--
--   transfer_lot_to_bin(lot, bin_qr, staff_name, reason)  jsonb
--     The one way to move a lot to a shelf in ANOTHER building. Typed staff
--     name and a reason are required (staff share logins) and land in
--     operator_audit_log ('lot.warehouse_transferred'). Refused when the lot
--     is scheduled, live or won; relisted/canceled/disposed; in an auction
--     that is not closed or canceled; on an invoice that is still being
--     collected (pending / payment_failed_grace, not refunded); or staged for
--     pickup. A lot still attached to its CLOSED auction is first relotted
--     to inventory exactly as Relist -> inventory does today
--     (relist_lot_into_auction(lot, NULL): a new in_inventory copy takes the
--     sticker, the old row becomes 'relisted' and keeps its sale record), and
--     the copy is the one that moves.
--
--   lots_0473_transfer_guard (BEFORE UPDATE OF intake_bin_id ON lots)
--     Replaces the held 0468. A lot that is already shelved in one building
--     can no longer be re-shelved in another by the ordinary put-away, move,
--     audit or bulk paths: they get a plain "transfer_needed: ..." error
--     instead of a silent re-home (or 0101's cryptic message; the name sorts
--     first so this message wins). A pending_intake lot recorded at another
--     building is refused too (owner 2026-10-27: name + reason needed; prod
--     10-27: 19 pending_intake lots have a building, 1,880 have none). Not
--     refused: lots with no warehouse, a never-shelved lot that is not
--     pending_intake, the same building, clearing a shelf, and
--     transfer_lot_to_bin itself (transaction-local flag bingo.lot_transfer).
--
-- Owner decisions 2026-10-27: paid no-show lots may be transferred; only an
-- invoice still being paid (pending / payment_failed_grace) refuses.
--
-- Prod today: 0 cross-building moves ever recorded, 0 lots on another
-- building's shelf, so the guard refuses nothing that happens today except
-- the case above, which already fails.
--
-- LOCKS / WINDOW
--   CREATE TRIGGER on lots takes SHARE ROW EXCLUSIVE on lots for
--   milliseconds (blocks lot writes, e.g. bids, while it holds). lock_timeout
--   3s. Database-lock window: 05:00-07:00 CT (Rule 9). The trigger fires only
--   when intake_bin_id changes (WHEN clause), never on bids.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE.
-- Rollback: scripts/prod-rig/0473_ROLLBACK_lot_warehouse_transfer.sql
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. The guard (replaces 0468)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lots_0473_transfer_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_bin_wh   UUID;
  v_bin_code TEXT;
  v_from     TEXT;
  v_to       TEXT;
BEGIN
  IF NEW.intake_bin_id IS NULL OR NEW.intake_bin_id IS NOT DISTINCT FROM OLD.intake_bin_id THEN
    RETURN NEW;
  END IF;
  -- No building yet: it belongs nowhere, so it is not a transfer.
  IF OLD.warehouse_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Never shelved and not arriving through intake: first placement. A
  -- pending_intake lot recorded at another building is NOT exempt (owner
  -- 2026-10-27): it arrives here only by a named transfer.
  IF OLD.intake_bin_id IS NULL AND OLD.status <> 'pending_intake' THEN
    RETURN NEW;
  END IF;
  -- transfer_lot_to_bin sets this for its own UPDATE only.
  IF current_setting('bingo.lot_transfer', true) = 'on' THEN
    RETURN NEW;
  END IF;
  SELECT b.warehouse_id, b.code INTO v_bin_wh, v_bin_code FROM bins b WHERE b.id = NEW.intake_bin_id;
  IF v_bin_wh IS NULL OR v_bin_wh = OLD.warehouse_id THEN
    RETURN NEW;
  END IF;
  SELECT w.name INTO v_from FROM warehouses w WHERE w.id = OLD.warehouse_id;
  SELECT w.name INTO v_to FROM warehouses w WHERE w.id = v_bin_wh;
  RAISE EXCEPTION 'transfer_needed: this item belongs to % inventory. Putting it on shelf % in % is a transfer: use Transfer in the updated staff app, with your name and a reason.',
    coalesce(v_from, 'another building''s'), v_bin_code, coalesce(v_to, 'another building')
    USING ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION public.lots_0473_transfer_guard() FROM PUBLIC;

COMMENT ON FUNCTION public.lots_0473_transfer_guard() IS
  '0473: a shelved lot moves to another building only through '
  'transfer_lot_to_bin (named + audited). Replaces the held 0468.';

DROP TRIGGER IF EXISTS lots_0473_transfer_guard ON public.lots;
CREATE TRIGGER lots_0473_transfer_guard
  BEFORE UPDATE OF intake_bin_id ON public.lots
  FOR EACH ROW
  WHEN (NEW.intake_bin_id IS DISTINCT FROM OLD.intake_bin_id)
  EXECUTE FUNCTION public.lots_0473_transfer_guard();

-- ---------------------------------------------------------------------------
-- 2. The transfer
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transfer_lot_to_bin(
  p_lot_id        UUID,
  p_bin_qr_token  UUID,
  p_staff_name    TEXT,
  p_reason        TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op        UUID;
  v_name      TEXT := nullif(btrim(coalesce(p_staff_name, '')), '');
  v_why       TEXT := nullif(btrim(coalesce(p_reason, '')), '');
  v_lot       lots%ROWTYPE;
  v_bin       bins%ROWTYPE;
  v_auc       auctions%ROWTYPE;
  v_bin_op    UUID;
  v_target    UUID;
  v_child     UUID;
  v_from_wh   TEXT;
  v_to_wh     TEXT;
  v_from_bin  TEXT;
  v_code      TEXT;
  v_audit     BIGINT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  v_op := current_operator_id();
  IF v_op IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;
  IF v_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'staff_name_required');
  END IF;
  IF v_why IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reason_required');
  END IF;

  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token AND qr_revoked_at IS NULL LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bin_not_found_or_revoked');
  END IF;
  IF v_bin.retired_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bin_retired');
  END IF;
  SELECT operator_id INTO v_bin_op FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_op IS DISTINCT FROM v_op THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bin_other_operator');
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF NOT FOUND OR v_lot.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  IF v_lot.operator_id <> v_op THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_other_operator');
  END IF;
  IF v_lot.warehouse_id IS NULL OR v_lot.warehouse_id = v_bin.warehouse_id THEN
    -- Nothing to transfer: the ordinary put-away handles this.
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_transfer');
  END IF;

  IF v_lot.status IN ('scheduled', 'live') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'in_sale', 'status', v_lot.status);
  END IF;
  IF v_lot.status = 'won' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'sold', 'status', v_lot.status);
  END IF;
  IF v_lot.status NOT IN ('pending_intake', 'in_inventory', 'draft', 'unsold') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_stock', 'status', v_lot.status);
  END IF;
  IF v_lot.auction_id IS NOT NULL THEN
    SELECT * INTO v_auc FROM auctions WHERE id = v_lot.auction_id;
    IF v_auc.status NOT IN ('closed', 'canceled') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'in_open_auction', 'auction_status', v_auc.status);
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM invoice_lots il JOIN invoices i ON i.id = il.invoice_id
     WHERE il.lot_id = v_lot.id AND il.refunded_at IS NULL
       AND i.status IN ('pending', 'payment_failed_grace')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'open_invoice');
  END IF;
  IF EXISTS (SELECT 1 FROM bin_assignments ba WHERE ba.lot_id = v_lot.id AND ba.status = 'staged') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'staged_for_pickup');
  END IF;

  SELECT name INTO v_from_wh FROM warehouses WHERE id = v_lot.warehouse_id;
  SELECT name INTO v_to_wh FROM warehouses WHERE id = v_bin.warehouse_id;
  SELECT code INTO v_from_bin FROM bins WHERE id = v_lot.intake_bin_id;

  v_target := v_lot.id;
  IF v_lot.auction_id IS NOT NULL THEN
    -- Detach from the closed auction the way Relist -> inventory does: the
    -- old row keeps its auction, bids and invoice history as 'relisted'; a
    -- fresh in_inventory copy takes the sticker and is the one that moves.
    BEGIN
      v_child := public.relist_lot_into_auction(v_lot.id, NULL);
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'relot_refused', 'detail', SQLERRM);
    END;
    IF v_child IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'relot_refused');
    END IF;
    UPDATE lots SET relist_origin = 'human_relot' WHERE id = v_child;
    v_target := v_child;
  END IF;

  PERFORM set_config('bingo.lot_transfer', 'on', true);
  UPDATE lots
     SET warehouse_id  = v_bin.warehouse_id,
         intake_bin_id = v_bin.id,
         status        = CASE WHEN status = 'pending_intake' THEN 'in_inventory'::lot_status ELSE status END,
         intake_at     = CASE WHEN status = 'pending_intake' THEN now() ELSE intake_at END,
         updated_at    = now()
   WHERE id = v_target
  RETURNING lot_code INTO v_code;
  PERFORM set_config('bingo.lot_transfer', '', true);

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES (
    v_op, auth.uid(), 'lot.warehouse_transferred', v_target,
    jsonb_build_object('lot_id', v_lot.id, 'lot_code', v_lot.lot_code, 'status', v_lot.status,
                       'warehouse', v_from_wh, 'warehouse_id', v_lot.warehouse_id, 'bin', v_from_bin,
                       'auction_id', v_lot.auction_id),
    jsonb_build_object('lot_id', v_target, 'lot_code', v_code, 'warehouse', v_to_wh,
                       'warehouse_id', v_bin.warehouse_id, 'bin', v_bin.code,
                       'relotted_from', CASE WHEN v_child IS NOT NULL THEN v_lot.id END,
                       'staff_name', v_name),
    v_why
  )
  RETURNING id INTO v_audit;

  RETURN jsonb_build_object(
    'ok', true, 'reason', 'ok_transferred', 'lot_id', v_target, 'lot_code', v_code,
    'bin_code', v_bin.code, 'from_warehouse', v_from_wh, 'to_warehouse', v_to_wh,
    'relotted_from', CASE WHEN v_child IS NOT NULL THEN v_lot.id END, 'audit_id', v_audit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_lot_to_bin(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transfer_lot_to_bin(UUID, UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.transfer_lot_to_bin(UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.transfer_lot_to_bin(UUID, UUID, TEXT, TEXT) IS
  '0473: move a lot to a shelf in another building. Staff name + reason '
  'required, audited as lot.warehouse_transferred. Refuses lots in a sale, '
  'sold, open invoice or staged for pickup; relots a lot off its closed '
  'auction first.';

COMMIT;
