-- 0352 — "missing" as a removal reason.
--
-- Owner, 2026-09-10, on the shelf check for items the checkout says were
-- already collected: staff need somewhere honest to record "I looked and it is
-- not there."
--
-- Today remove_lot_from_inventory accepts destroyed / bin_store / donated /
-- liquidated / other. A box that cannot be found is none of those. The only
-- fit is 'other' plus a typed note, which no report reads — so a not-found
-- result would be invisible within a month, which is the same failure that
-- produced this whole investigation.
--
-- There is also no other route for it. The 'missing' pickup outcome staff use
-- at the counter requires a pickup session and an invoice; an unsold or
-- cancelled lot sitting on a shelf has neither.
--
-- ── WHAT IT DOES TO THE LOT ─────────────────────────────────────────────────
-- The same as every other removal kind: status becomes 'disposed', enforced by
-- the existing lots_removal_implies_disposed constraint. That is the behaviour
-- we want — 'disposed' is in the terminal set (0344), so the lot leaves the
-- rotation, cannot be relisted, and cannot pin an auction open.
--
-- It is not irreversible. If the box turns up later, staff re-lot it the way
-- they would any found item; nothing here destroys the record or the history.
--
-- The change is deliberately only the whitelist and the CHECK. The function's
-- guards (admin-or-manager, same-operator, refuses a live lot with bids,
-- idempotent per kind, conflicting-kind detection) are all correct as they
-- stand and are left untouched.

BEGIN;

ALTER TABLE public.lots DROP CONSTRAINT IF EXISTS lots_removal_kind_check;

-- NOT VALID then VALIDATE: adding it outright rescans every row in lots under
-- an ACCESS EXCLUSIVE lock, and an ALTER on this table during trading hours
-- has already deadlocked once against live traffic (0349's first attempt).
-- This split keeps the exclusive lock to a metadata flip and does the row
-- check under SHARE UPDATE EXCLUSIVE, which does not block reads or writes.
ALTER TABLE public.lots
  ADD CONSTRAINT lots_removal_kind_check
  CHECK (removal_kind IS NULL
         OR removal_kind = ANY (ARRAY['destroyed','bin_store','donated',
                                      'liquidated','missing','other']))
  NOT VALID;

ALTER TABLE public.lots VALIDATE CONSTRAINT lots_removal_kind_check;

-- Widen the RPC's own whitelist to match. Surgical single-line patch so the
-- guards around it cannot drift.
DO $do$
DECLARE v_src text; v_new text;
BEGIN
  v_src := pg_get_functiondef('public.remove_lot_from_inventory(uuid,text,text)'::regprocedure);

  IF v_src ILIKE '%''missing''%' THEN
    RAISE NOTICE '0352: missing kind already accepted, nothing to do';
    RETURN;
  END IF;

  v_new := replace(v_src,
    '(''destroyed'', ''bin_store'', ''donated'', ''liquidated'', ''other'')',
    '(''destroyed'', ''bin_store'', ''donated'', ''liquidated'', ''missing'', ''other'')');

  IF v_new = v_src THEN
    RAISE EXCEPTION '0352: kind whitelist not found in remove_lot_from_inventory — refusing to guess';
  END IF;

  EXECUTE v_new;
END
$do$;

COMMENT ON FUNCTION public.remove_lot_from_inventory(uuid, text, text) IS
  '0319/0352: takes a lot out of auction rotation with a recorded reason — destroyed, bin_store, donated, liquidated, missing, other. Sets status disposed. Admin or manager only; refuses a live lot carrying bids.';

COMMIT;
