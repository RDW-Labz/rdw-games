-- 0307 — the tail of the 0306 class: relist twins where NOTHING ever sold
--
-- 0306 retired 19 phantom relist children across the 07-14/15 bulk relists and
-- left the audit reporting zero. But zero is an artefact of how that predicate
-- is anchored, not the end of the class.
--
-- ── What 0306 could not judge ──────────────────────────────────────────────
--
-- `retire_phantom_relist_children` only acts when a sibling off the same parent
-- holds an auction. That requirement is what makes it safe: the auctioned
-- sibling is proof the physical item is still represented somewhere, so
-- cancelling the inert rows cannot erase it. No auctioned sibling, no action —
-- and `phantom_relist_child_audit` carries the same JOIN, so those rows are not
-- merely skipped, they are invisible.
--
-- Twelve inert in_inventory children on prod sit outside that anchor. Nine are
-- the last row standing for their item and must stay. The other six are three
-- PAIRS, and each pair is one box counted twice:
--
--   parent       kept         retired      title / bin           intake_at
--   TEA3822650   BIN-002565   BIN-002622   loft bed   1-18-01    05-28 19:00:31.143056
--   PNK4996884   BIN-002574   BIN-002631   vanity     1-16-01    05-28 20:42:50.072032
--   PNK4996266   BIN-002578   BIN-002635   vanity pcs 11-03-01   05-28 17:58:34.137633
--
-- Same parent, same title, same bin, and — the part that settles it — the same
-- `intake_at`, down to the microsecond. `intake_at` records when a physical box
-- was put away. Two rows cannot share one to six decimal places unless both
-- were cloned from the same source row. Each pair was minted 78 seconds apart
-- (13:48:5x then 13:50:0x on 07-15) by the same double-click that produced
-- everything 0306 retired.
--
-- ── Why this is not the Duplicate Lot feature ──────────────────────────────
--
-- `duplicate_lot` (0299) exists precisely to create two identical in_inventory
-- rows for two real boxes, so the shape this migration matches is, on its face,
-- the shape that feature produces. It is not: 0299 deliberately leaves
-- `relisted_from_lot_id` NULL (its header explains why — lineage would make a
-- second unit look like a relist twin to every guard since 0275) and does not
-- copy `intake_at`, because the new box has not been put away yet. All six rows
-- carry lineage, `relist_count = 1`, and an inherited `intake_at`. A genuine
-- Duplicate Lot row cannot match the predicate below on either column.
--
-- ── The rule ───────────────────────────────────────────────────────────────
--
-- Keep the oldest of each clone group, retire the newer ones. A row is only
-- retired when an OLDER twin exists, so at least one row always survives — the
-- guarantee 0306 got from the auctioned sibling, obtained here from the
-- survivor instead. The kept row holds the same bin and the same photos, so
-- staff looking for the box still find it in 1-18-01.
--
-- Sticker-bound rows are excluded: a relist child inherits the sticker stuck to
-- the box (0299), so a `sticker_code` is a claim on the physical item. If the
-- newer twin holds it, nothing is retired and both rows remain — the safe
-- failure direction, and a visible one, since the audit below still reports it.
--
-- The write is `admin_cancel_lot` (0291) minus `canceled_by`, per the 0290
-- precedent 0306 followed. Reversible: status back to in_inventory with
-- canceled_at NULL restores the row exactly, as nothing else is touched.

BEGIN;

CREATE OR REPLACE FUNCTION public.retire_duplicate_relist_twins(
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
     -- inert, exactly as 0306 requires: in stock, never listed, owed to no one
     AND c.status = 'in_inventory'
     AND c.auction_id IS NULL
     AND c.bid_count = 0
     AND c.sticker_code IS NULL          -- a sticker is a claim on the box
     AND NOT EXISTS (SELECT 1 FROM bids b             WHERE b.lot_id  = c.id)
     AND NOT EXISTS (SELECT 1 FROM invoice_lots il    WHERE il.lot_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM bin_assignments ba WHERE ba.lot_id = c.id)
     -- put away, and provably the same box as its twin
     AND c.intake_at IS NOT NULL
     AND c.intake_bin_id IS NOT NULL
     -- an OLDER twin off the same parent survives this row. Both the proof that
     -- the two rows are one box (identical inherited intake_at, same title,
     -- same bin) and the guarantee that the item is never erased: the survivor
     -- is matched here, not assumed.
     AND EXISTS (
       SELECT 1 FROM lots k
        WHERE k.relisted_from_lot_id = a.id
          AND k.id <> c.id
          AND k.deleted_at IS NULL
          AND k.status = 'in_inventory'
          AND k.auction_id IS NULL
          AND k.bid_count = 0
          AND k.intake_at      = c.intake_at
          AND k.intake_bin_id  = c.intake_bin_id
          AND k.title          = c.title
          AND k.created_at     < c.created_at
     );

  GET DIAGNOSTICS v_retired = ROW_COUNT;
  RETURN v_retired;
END;
$$;

REVOKE ALL ON FUNCTION public.retire_duplicate_relist_twins(TEXT) FROM PUBLIC;

COMMENT ON FUNCTION public.retire_duplicate_relist_twins(TEXT) IS
  '0307: the tail of the 0306 phantom class — inert in_inventory relist twins '
  'where no sibling ever reached an auction, so 0306''s anchor did not apply. '
  'Two rows sharing a parent, a title, a bin and an inherited intake_at to the '
  'microsecond are one box cloned twice; this keeps the oldest and cancels the '
  'newer. Never retires a row without an older surviving twin, so an item can '
  'not be erased. Skips sticker-bound rows. Does NOT match duplicate_lot (0299) '
  'output, which carries no lineage and no inherited intake_at. Pass a parent '
  'lot_code for one lineage, NULL/no argument for every parent. Stamps '
  'canceled_at, leaves canceled_by NULL (0290). Idempotent. Ops repair only.';

-- 3 rows expected: BIN-002622, BIN-002631, BIN-002635.
SELECT public.retire_duplicate_relist_twins();

-- ---------------------------------------------------------------------------
-- Keep the rest of the tail visible. `phantom_relist_child_audit` reports only
-- what 0306 can act on; these are the inert children with no auctioned sibling
-- anywhere in the lineage, which that audit structurally cannot show. After the
-- sweep above the twins are gone and what remains is the nine last-rows-
-- standing — each the only surviving record of its item, listed here so a
-- reappearing duplicate is noticed rather than rediscovered by a customer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unanchored_relist_child_audit()
RETURNS TABLE (
  parent_code     TEXT,
  parent_status   TEXT,
  child_code      TEXT,
  child_bin       TEXT,
  child_intake_at TIMESTAMPTZ,
  child_created   TIMESTAMPTZ,
  clone_group     BIGINT,
  is_oldest       BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.lot_code, a.status::TEXT, c.lot_code, b.code, c.intake_at, c.created_at,
    count(*)    OVER (PARTITION BY a.id, c.intake_at, c.intake_bin_id, c.title),
    c.created_at = min(c.created_at)
                OVER (PARTITION BY a.id, c.intake_at, c.intake_bin_id, c.title)
  FROM lots c
  JOIN lots a      ON a.id = c.relisted_from_lot_id
  LEFT JOIN bins b ON b.id = c.intake_bin_id
  WHERE c.deleted_at IS NULL
    AND a.deleted_at IS NULL
    AND c.status = 'in_inventory'
    AND c.auction_id IS NULL
    AND c.bid_count = 0
    AND NOT EXISTS (SELECT 1 FROM bids bb         WHERE bb.lot_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = c.id)
    -- the distinguishing condition: no sibling reached an auction, which is
    -- exactly why phantom_relist_child_audit cannot report these
    AND NOT EXISTS (
      SELECT 1 FROM lots s
       WHERE s.relisted_from_lot_id = a.id
         AND s.deleted_at IS NULL
         AND s.auction_id IS NOT NULL
    )
  ORDER BY a.lot_code, c.created_at;
$$;

REVOKE ALL ON FUNCTION public.unanchored_relist_child_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unanchored_relist_child_audit() TO authenticated;

COMMENT ON FUNCTION public.unanchored_relist_child_audit() IS
  '0307: inert in_inventory relist children whose lineage contains NO auctioned '
  'sibling. phantom_relist_child_audit cannot report these — it joins to the '
  'auctioned sibling — so without this they are unreported rather than merely '
  'unretired. clone_group > 1 with is_oldest false is a twin 0307 would retire '
  '(if it survives, something blocked it — usually a sticker); clone_group = 1 '
  'is the last surviving row for its item and must never be cancelled.';

-- 0306 shipped this comment saying it had retired only the PNK4858937 pair. It
-- was widened to sweep every parent before it merged, and the comment did not
-- follow. Corrected here so the catalog stops contradicting the migration.
COMMENT ON FUNCTION public.phantom_relist_child_audit() IS
  '0306: relist children sitting at in_inventory with no auction, no bids and '
  'no invoice, while a sibling off the same parent holds the real auction — '
  'duplicate rows from repeated relist clicks, showing a sold box as available '
  'stock. 0306 retired this class across all parents (19 rows on prod); a '
  'non-empty result means new ones have appeared since. Note '
  'lots_one_active_relist_child (0294) does NOT cover this: its predicate lists '
  'draft/scheduled/live, and in_inventory is not one. Children whose lineage '
  'never reached an auction cannot appear here at all — see '
  'unanchored_relist_child_audit (0307).';

COMMIT;
