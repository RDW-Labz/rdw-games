-- 0306 — retire the phantom relist children of PNK4858937
--
-- Asked for after 0305: "fix the PNK4858937 tangle". 0305 deliberately skipped
-- it because its ancestor is `canceled` rather than a `relisted` tombstone, so
-- the location repair's predicate did not cover it and the right answer was not
-- a blanket copy.
--
-- ── What the tangle actually is ────────────────────────────────────────────
--
-- One physical item — a nesting side table set — with SIX rows:
--
--   PNK4858937  canceled      bin 14-07-01   invoice PAID, FORFEITED 07-13
--   BIN-002250  canceled      bin 13-14-01   sticker BIN:PNK4858937, no invoice
--   BIN-002570  in_inventory  bin 13-14-01   no auction, no invoice, 0 bids
--   BIN-002627  in_inventory  bin 13-14-01   no auction, no invoice, 0 bids
--   BIN-002649  canceled      bin 13-14-01   no invoice
--   BIN-003084  won           bin 14-07-01   auction + invoice, sold $13.00
--
-- The original buyer paid $5, never collected, and the lot was forfeited on
-- 2026-07-13. It was then relisted FIVE times: once on 07-14, three times
-- within three minutes on 07-15 (13:48:52, 13:50:09, 13:51:50), and once on
-- 07-16. Only the last — BIN-003084 — reached an auction, where it sold.
--
-- So BIN-002570 and BIN-002627 are duplicate rows minted by repeated relist
-- clicks. They claim `in_inventory`, which shows the box as available stock,
-- for an item that has already been sold to someone else.
--
-- ── Why the dedupe guard did not catch them ────────────────────────────────
--
-- `lots_one_active_relist_child` (0294) is a partial unique index on
-- `relisted_from_lot_id` predicated on
-- `status = ANY (draft, scheduled, live) AND sticker_code IS NULL`.
-- `in_inventory` is not in that list, so two in_inventory siblings off one
-- parent do not violate it. The index is behaving as written; the status set
-- just does not cover this shape.
--
-- ── Scope: the whole class ─────────────────────────────────────────────────
--
-- PNK4858937 was the reported tangle, but it is one instance of a pattern: 18
-- parents on prod have more than one active child (53 active children in
-- total), and the phantoms cluster in two tight code ranges —
-- BIN-002564..002585 and BIN-002621..002642 — i.e. two bulk relist events on
-- 07-14/15 that each minted a duplicate child.
--
-- The reported tangle was fixed first and the remaining 17 surfaced to the
-- owner, who asked for them in the same pass. So this retires the class, not
-- one lineage. The repair still takes a parent code for one-off use; passing
-- nothing targets every parent.
--
-- Each row is judged on its own merits by the predicate below — being part of
-- a batch is not the reason any of them is retired. Anything holding an
-- auction, a bid, an invoice or a bin assignment is left alone, and no lineage
-- is touched unless a sibling demonstrably holds the real sale.
--
-- ── The write ──────────────────────────────────────────────────────────────
--
-- Exactly what `admin_cancel_lot` (0291) does, minus `canceled_by`: that
-- function stamps `auth.uid()`, and a migration is not a user. 0290 set the
-- same precedent when it backfilled the pre-0199 cancels.
--
-- Scoped by predicate rather than by hard-coded ids, so it is self-verifying —
-- if the data has moved on it simply matches fewer rows — and it re-checks
-- every fact that makes these rows safe to retire. `admin_cancel_lot` would
-- refuse a won or bidded lot; the predicate refuses the same things and more.

BEGIN;

-- Parameterised by parent code rather than written as a one-shot UPDATE, for
-- the same two reasons as 0305's repair function: the predicate can be tested
-- against fixtures, and the other 17 tangles can be retired by calling it again
-- instead of hand-writing SQL against prod.
CREATE OR REPLACE FUNCTION public.retire_phantom_relist_children(
  p_parent_lot_code TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_retired INTEGER;
BEGIN
  UPDATE lots c
     SET status      = 'canceled',
         auction_id  = NULL,
         lot_number  = NULL,
         close_at    = NULL,
         canceled_at = now(),
         updated_at  = now()
    FROM lots a
   WHERE c.relisted_from_lot_id = a.id
     -- NULL targets every parent; a code targets just that lineage
     AND (p_parent_lot_code IS NULL OR a.lot_code = p_parent_lot_code)
     AND a.deleted_at IS NULL
     AND c.deleted_at IS NULL
     -- the phantom shape: sitting in stock, never listed, never owed to anyone
     AND c.status = 'in_inventory'
     AND c.auction_id IS NULL
     AND c.bid_count = 0
     AND NOT EXISTS (SELECT 1 FROM bids b            WHERE b.lot_id  = c.id)
     AND NOT EXISTS (SELECT 1 FROM invoice_lots il   WHERE il.lot_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM bin_assignments ba WHERE ba.lot_id = c.id)
     -- and only when a REAL sibling carries the item: something that actually
     -- reached an auction. Without this the last row standing could be canceled
     -- and the item would vanish from inventory entirely.
     AND EXISTS (
       SELECT 1 FROM lots sib
        WHERE sib.relisted_from_lot_id = a.id
          AND sib.id <> c.id
          AND sib.deleted_at IS NULL
          AND sib.auction_id IS NOT NULL
     );

  GET DIAGNOSTICS v_retired = ROW_COUNT;
  RETURN v_retired;
END;
$$;

REVOKE ALL ON FUNCTION public.retire_phantom_relist_children(TEXT) FROM PUBLIC;

COMMENT ON FUNCTION public.retire_phantom_relist_children(TEXT) IS
  '0306: cancel the duplicate in_inventory relist children minted by repeated '
  'relist clicks — rows that show a sold box as available stock. Pass a parent '
  'lot_code to target one lineage, or NULL/no argument for every parent. '
  'Refuses anything with an auction, a bid, an invoice or a bin assignment, and '
  'refuses to act unless a sibling holds the real auction, so it can never '
  'retire the last row standing. Stamps canceled_at like admin_cancel_lot but '
  'leaves canceled_by NULL (0290 precedent: a migration is not a user). '
  'Idempotent. Not granted to `authenticated` — ops repair only.';

-- Retire the whole class. PNK4858937 was the reported tangle; the owner then
-- asked for the remaining 17 in the same pass. ~30 rows expected across 18
-- parents, all of them inert duplicates from the 07-14/15 bulk relist events.
SELECT public.retire_phantom_relist_children();

-- ---------------------------------------------------------------------------
-- Keep the class visible. This reports the phantom shape across ALL parents,
-- not just PNK4858937, so the remaining 17 tangles stay on the books instead of
-- being rediscovered by a customer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phantom_relist_child_audit()
RETURNS TABLE (
  parent_code   TEXT,
  parent_status TEXT,
  phantom_code  TEXT,
  phantom_bin   TEXT,
  phantom_created TIMESTAMPTZ,
  real_sibling  TEXT,
  real_status   TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.lot_code, a.status::TEXT, c.lot_code, b.code, c.created_at,
    sib.lot_code, sib.status::TEXT
  FROM lots c
  JOIN lots a   ON a.id = c.relisted_from_lot_id
  LEFT JOIN bins b ON b.id = c.intake_bin_id
  JOIN LATERAL (
    SELECT s.lot_code, s.status
      FROM lots s
     WHERE s.relisted_from_lot_id = a.id
       AND s.id <> c.id
       AND s.deleted_at IS NULL
       AND s.auction_id IS NOT NULL
     ORDER BY s.created_at DESC
     LIMIT 1
  ) sib ON TRUE
  WHERE c.deleted_at IS NULL
    AND a.deleted_at IS NULL
    AND c.status = 'in_inventory'
    AND c.auction_id IS NULL
    AND c.bid_count = 0
    AND NOT EXISTS (SELECT 1 FROM bids bb         WHERE bb.lot_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = c.id)
  ORDER BY a.lot_code, c.created_at;
$$;

REVOKE ALL ON FUNCTION public.phantom_relist_child_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phantom_relist_child_audit() TO authenticated;

COMMENT ON FUNCTION public.phantom_relist_child_audit() IS
  '0306: relist children sitting at in_inventory with no auction, no bids and '
  'no invoice, while a sibling off the same parent holds the real auction — '
  'duplicate rows from repeated relist clicks, showing a sold box as available '
  'stock. 0306 retired only the PNK4858937 pair; the rest are reported here for '
  'an owner decision. Note lots_one_active_relist_child (0294) does NOT cover '
  'this: its predicate lists draft/scheduled/live, and in_inventory is not one.';

COMMIT;
