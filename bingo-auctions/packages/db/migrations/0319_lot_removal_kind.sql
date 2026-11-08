-- 0319 — permanent removal from auction inventory, with a recorded outcome
--
-- Reported 2026-08-13 (item 3): "We need a way to remove an item from auction
-- inventory after it has entered the auction process." Two outcomes, and the
-- distinction matters to the operator:
--   * the item is damaged / trash and is DESTROYED
--   * the item goes to Been There Bought That (the bin store) instead — gone
--     from auction inventory, but NOT destroyed
--
-- Clarified by the owner: the common trigger is a customer checking out, then
-- reporting a problem — so the item is physically back and the refund has
-- already been handled.
--
-- IMPORTANT, and the owner was explicit about it: a refund does NOT mean the
-- item is finished. Most refunded items go back into a later auction, and
-- should. Removal is a SEPARATE, DELIBERATE judgement — "we have decided this
-- particular item cannot be sold" — and nothing in this migration fires off
-- the back of a refund, a return, or any other automatic signal. It only ever
-- happens when a human calls remove_lot_from_inventory. The refund flow is not
-- touched here at all.
--
-- What the owner needs from it is the one-way door: once that judgement is
-- made, the item can never be auctioned again.
--
-- ── What already worked, and what didn't ───────────────────────────────────
-- mark_lot_disposed (0146) already flips status='disposed' from any status,
-- and 'disposed' is already relist-proof: relist_lot_into_auction refuses any
-- source whose status is not unsold/in_inventory/relisted, and the worklist's
-- pull-to-inventory only accepts unsold/relisted. So the terminal *state*
-- existed. Three things were missing:
--
--   1. NO RECORD OF THE OUTCOME. Disposal reasons are free text stuffed into
--      flagged_reason ('aging: liquidate — pallet 12'). There is no way to ask
--      "what did we destroy this quarter" separately from "what did we move to
--      the bin store", which is exactly the split the owner asked for.
--
--   2. NOTHING ENFORCED THE 'PERMANENT' PART. status='disposed' is terminal
--      only because every current caller happens to exclude it. A future
--      UPDATE — or a hand-run SQL fix — could set status back to
--      'in_inventory' and the item would re-enter the rotation silently. For a
--      destroyed item that is a physical impossibility, so the database should
--      refuse it rather than rely on every future caller remembering.
--
--   3. It was never reachable from where the need arises. Only /reports/aging
--      and the worklist could dispose; the post-refund case starts on the lot.
--      (UI ships alongside this migration.)
--
-- Scale check on prod before writing this: 443 lots sit at status='won' with a
-- refunded claim, and 293 lots at status='relisted' have one — so refunded
-- items already flow back into later auctions in volume. That is the behaviour
-- to PRESERVE, and it is why removal has to be an explicit opt-in rather than
-- anything inferred from a refund: getting that backwards would silently
-- retire hundreds of perfectly sellable items.
--
-- ── Deliberately NOT a "Destroy Bin" ───────────────────────────────────────
-- The report offered "a Destroy Item option OR a designated Destroy Bin". This
-- implements the former. A destroy *bin* would be a real bins row that items
-- are scanned into, which buys a physical staging area but also means the
-- terminal state is "sitting in a bin" — recoverable by scanning back out, and
-- needing its own reconciliation. The requirement is permanence, so the
-- outcome is recorded on the lot and locked, not modelled as a location. Staff
-- can still keep a physical destroy pile; it just isn't the system of record.
--
-- ── auction_id is deliberately kept ────────────────────────────────────────
-- Removal does not null out auction_id / lot_number. The lot is 'disposed', so
-- it is already excluded from bidder-facing queries, and keeping the link
-- preserves "which auction was this in when it went wrong" for the aging
-- report and for invoice history. 0199 nulls those columns when a *canceled
-- auction* returns lots to inventory — a different case, because those lots go
-- back into the pool and must not carry a stale auction.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Outcome columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS removal_kind TEXT;

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS removed_by UUID;

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS removal_note TEXT;

-- 'destroyed'  — damaged / trash, physically gone
-- 'bin_store'  — transferred to Been There Bought That
-- 'donated'    — } the two dispositions /reports/aging already offers, given a
-- 'liquidated' — } structured home so aging triage and this share one vocabulary
-- 'other'      — escape hatch; the note carries the detail
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lots_removal_kind_check'
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_removal_kind_check
      CHECK (removal_kind IS NULL OR removal_kind IN
        ('destroyed', 'bin_store', 'donated', 'liquidated', 'other'));
  END IF;
END $$;

-- Every removed lot is disposed. The converse is NOT required: rows disposed
-- before this migration keep removal_kind NULL rather than being guessed at.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lots_removal_implies_disposed'
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_removal_implies_disposed
      CHECK (removal_kind IS NULL OR status = 'disposed');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS lots_removal_kind_idx
  ON public.lots(operator_id, removal_kind, removed_at DESC)
  WHERE removal_kind IS NOT NULL;

COMMENT ON COLUMN public.lots.removal_kind IS
  '0319: why this lot left auction inventory for good — destroyed / bin_store '
  '(Been There Bought That) / donated / liquidated / other. NULL means the lot '
  'was never removed (or was disposed before 0319 shipped). Once set it is '
  'immutable and status is pinned to disposed — see the trigger below.';

COMMENT ON COLUMN public.lots.removed_at IS '0319: when removal was recorded.';
COMMENT ON COLUMN public.lots.removed_by IS
  '0319: auth.uid() of the admin/manager who recorded the removal.';
COMMENT ON COLUMN public.lots.removal_note IS
  '0319: optional free-text detail (e.g. "water damage, box crushed").';

-- ---------------------------------------------------------------------------
-- 2. The permanence guard
-- ---------------------------------------------------------------------------
-- This is the part that makes "permanently ineligible for another auction" a
-- property of the data rather than a convention every caller must honour.
--
-- Once removal_kind is set, an UPDATE may not:
--   - change removal_kind (including clearing it), or
--   - move status off 'disposed'.
--
-- Everything else stays editable — notes, photos, titles, soft-delete — so
-- staff can still correct a description on a destroyed lot. Nothing here
-- blocks DELETE; a hard delete removes the row entirely, which is not a route
-- back into an auction.
--
-- The trigger fires for service_role too. That is intentional: a server-side
-- job resurrecting a destroyed item is precisely the accident being prevented.
-- Genuine reversals (wrong lot destroyed) are a deliberate DBA action — drop
-- the trigger, fix the row, recreate it — and should leave that trace.

CREATE OR REPLACE FUNCTION public.lots_removal_is_terminal()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.removal_kind IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.removal_kind IS DISTINCT FROM OLD.removal_kind THEN
    RAISE EXCEPTION
      'lot_removal_is_permanent: lot % was recorded as % and cannot be re-classified',
      OLD.id, OLD.removal_kind
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status <> 'disposed' THEN
    RAISE EXCEPTION
      'lot_removal_is_permanent: lot % was removed from inventory (%) and cannot return to status %',
      OLD.id, OLD.removal_kind, NEW.status
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lots_removal_is_terminal_trg ON public.lots;
CREATE TRIGGER lots_removal_is_terminal_trg
  BEFORE UPDATE ON public.lots
  FOR EACH ROW
  EXECUTE FUNCTION public.lots_removal_is_terminal();

COMMENT ON FUNCTION public.lots_removal_is_terminal() IS
  '0319: makes removal terminal. Once lots.removal_kind is set, no UPDATE may '
  'change it or move status off disposed — so a destroyed or bin-store item '
  'cannot be relisted, pulled back to inventory, or resurrected by a future '
  'code path that forgets to exclude disposed lots.';

-- ---------------------------------------------------------------------------
-- 3. remove_lot_from_inventory(lot, kind, note)
-- ---------------------------------------------------------------------------
-- Admin/manager, operator-scoped, idempotent when re-called with the SAME kind
-- (so a double-click or a retried request is harmless) and a hard error when
-- re-called with a different one (that is a real disagreement about what
-- happened to a physical item, and should surface rather than silently win).
--
-- Refuses a lot that is scheduled/live AND has bids. That case is not what
-- this action is for — per the owner it is used after checkout and refund —
-- and voiding live bids is a money-bearing decision that belongs in the cancel
-- flow, which already notifies bidders. A live lot with NO bids is allowed:
-- nothing is voided, and finding a smashed item before anyone bids is common.

CREATE OR REPLACE FUNCTION public.remove_lot_from_inventory(
  p_lot_id UUID,
  p_kind   TEXT,
  p_note   TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller   UUID := auth.uid();
  v_op_id    UUID;
  v_role     operator_user_role;
  v_lot      lots%ROWTYPE;
  v_note     TEXT := NULLIF(TRIM(COALESCE(p_note, '')), '');
  v_bids     INT;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  IF p_kind IS NULL OR p_kind NOT IN
     ('destroyed', 'bin_store', 'donated', 'liquidated', 'other') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_removal_kind');
  END IF;

  SELECT operator_id, role INTO v_op_id, v_role
    FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;
  IF v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'admin_or_manager_required');
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  IF v_lot.operator_id <> v_op_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_other_operator');
  END IF;

  -- Already removed: same kind is a no-op, different kind is a conflict.
  IF v_lot.removal_kind IS NOT NULL THEN
    IF v_lot.removal_kind = p_kind THEN
      RETURN jsonb_build_object(
        'ok', true, 'idempotent', true,
        'lot_id', p_lot_id, 'removal_kind', v_lot.removal_kind);
    END IF;
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'already_removed_as_' || v_lot.removal_kind);
  END IF;

  IF v_lot.status IN ('scheduled', 'live') THEN
    SELECT count(*)::INT INTO v_bids FROM bids WHERE lot_id = p_lot_id;
    IF v_bids > 0 THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'lot_live_with_bids', 'bids', v_bids);
    END IF;
  END IF;

  UPDATE lots
     SET status               = 'disposed',
         removal_kind         = p_kind,
         removed_at           = now(),
         removed_by           = v_caller,
         removal_note         = v_note,
         -- Keep the disposal flag consistent with 0146 so the worklist's
         -- "flagged" section and this agree on what has left the rotation.
         flagged_for_disposal = TRUE,
         flagged_at           = COALESCE(flagged_at, now()),
         flagged_reason       = COALESCE(flagged_reason, 'removed: ' || p_kind),
         updated_at           = now()
   WHERE id = p_lot_id;

  RETURN jsonb_build_object(
    'ok', true, 'lot_id', p_lot_id, 'removal_kind', p_kind);
END;
$$;

REVOKE ALL ON FUNCTION public.remove_lot_from_inventory(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_lot_from_inventory(UUID, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.remove_lot_from_inventory(UUID, TEXT, TEXT) IS
  '0319: admin/manager RPC that permanently removes a lot from auction '
  'inventory, recording WHY (destroyed / bin_store / donated / liquidated / '
  'other). Sets status=disposed; the 0319 trigger then pins it there. '
  'Idempotent on the same kind, refuses a conflicting kind, and refuses a '
  'scheduled/live lot that already has bids (cancel it first).';

COMMIT;
