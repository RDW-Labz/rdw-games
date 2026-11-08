-- 0334 — bin lookup lists one row per physical box, and only if it's still there.
--
-- Found 2026-08-26 by a physical audit of Cage-01-01. Bin lookup said 19 lots;
-- 16 were on the shelf. The three extras were retired relist PARENTS —
-- BIN-002119 (Xbox), BIN-002161 (iPhone 14), BIN-002169 (iPhone 15 Pro). All
-- three had children that sold and were collected by buyers weeks earlier
-- (Jul 20, Jul 21, Aug 5). Nothing was missing; the screen was wrong.
--
-- Two separate over-counts, both from `relisted` parents:
--
--   * A relist never moves the box. The child inherits intake_bin_id and the
--     printed label, so parent AND child can both list in the same bin — one
--     box, two rows, identical display_code (BRN4978428 in 3-16-02, reported
--     2026-07-22, is exactly this).
--   * When the child later sells and is picked up, the parent keeps
--     status='relisted' and its bin forever. Nothing ever clears it.
--
-- Across BinGo's 2,681 shelved relist parents:
--
--   782  child collected by the buyer   → box gone, parent still listed
--   689  child listed in the SAME bin   → one box counted twice
--   242  child listed in a DIFFERENT bin→ box moved, parent still listed here
--    29  child disposed                 → box gone, parent still listed
--   ---
--  1,742 phantom rows across 264 bins
--
-- 0324's PRESENT_STATUSES fix (won/unsold/canceled/disposed excluded) was the
-- right idea applied to the wrong axis: status alone can't tell you whether a
-- box is on a shelf, because a lineage shares one box across several rows.
--
-- The rule here: a relisted parent is hidden when a descendant (at any depth)
-- either already represents the box in a bin, or has left the building. It is
-- kept in every other case — including when the child is `unsold` or `won` and
-- so isn't listed anywhere itself. That asymmetry is deliberate: over-listing
-- wastes a staffer's time, but under-listing loses a box, and the parent row is
-- sometimes the only thing pointing at where it sits.

DROP FUNCTION IF EXISTS public.bin_present_lots(uuid);
CREATE FUNCTION public.bin_present_lots(p_bin_id uuid)
RETURNS TABLE (
  id uuid,
  qr_token uuid,
  lot_code text,
  sticker_code text,
  display_code text,
  title text,
  status public.lot_status,
  auction_id uuid
)
LANGUAGE sql
STABLE
-- SECURITY INVOKER on purpose: `lots` RLS scopes rows to the caller's operator,
-- and this must not become a cross-tenant read of anyone's shelves.
SECURITY INVOKER
SET search_path = public
AS $$
  WITH RECURSIVE base AS (
    SELECT l.id, l.qr_token, l.lot_code, l.sticker_code, l.display_code,
           l.title, l.status, l.auction_id
      FROM lots l
     WHERE l.intake_bin_id = p_bin_id
       AND l.deleted_at IS NULL
       AND l.status IN (
             'pending_intake', 'in_inventory', 'draft', 'scheduled', 'live', 'relisted'
           )
  ),
  -- Every descendant of every listed lot, to any depth. A relist of a relist is
  -- ordinary here, and checking only the immediate child would hide a parent
  -- behind a child that is itself hidden.
  descendants AS (
    SELECT b.id AS root_id, c.id AS descendant_id
      FROM base b
      JOIN lots c ON c.relisted_from_lot_id = b.id AND c.deleted_at IS NULL
    UNION ALL
    SELECT d.root_id, c.id
      FROM descendants d
      JOIN lots c ON c.relisted_from_lot_id = d.descendant_id AND c.deleted_at IS NULL
  ),
  superseded AS (
    SELECT DISTINCT d.root_id
      FROM descendants d
      JOIN lots c ON c.id = d.descendant_id
     WHERE
       -- The descendant is itself on a shelf, so IT is the row for this box.
       (c.intake_bin_id IS NOT NULL
        AND c.status IN ('pending_intake', 'in_inventory', 'draft', 'scheduled', 'live', 'relisted'))
       -- Or the box left the building and no row should show at all.
       OR c.status = 'disposed'
       OR EXISTS (
            SELECT 1 FROM invoice_lots il
             WHERE il.lot_id = c.id AND il.picked_up_at IS NOT NULL
          )
  )
  SELECT b.id, b.qr_token, b.lot_code, b.sticker_code, b.display_code,
         b.title, b.status, b.auction_id
    FROM base b
   WHERE b.status <> 'relisted'
      OR b.id NOT IN (SELECT root_id FROM superseded)
   ORDER BY b.lot_code;
$$;

COMMENT ON FUNCTION public.bin_present_lots(uuid) IS
  'Lots physically on a bin: one row per box, hiding retired relist parents whose lineage has moved on or left. Bin lookup and bin audit both read this so they cannot disagree (Cage-01-01 audit, 2026-08-26).';

GRANT EXECUTE ON FUNCTION public.bin_present_lots(uuid) TO authenticated;
