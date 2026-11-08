-- 0335 — promote complete, shelved draft lots to in_inventory.
--
-- Reported 2026-08-26: "Why can I not list the items in the Cage into the
-- auction, nothing shows for the Cage in the Auction builder."
--
-- All 16 lots on Cage-01-01 are status='draft'. The auction builder lists only
-- status='in_inventory', and assign_lots_to_auction refuses anything else, so
-- the cage reads as empty there while Bin Lookup shows all 16.
--
-- `draft` is meant to be an UNFINISHED listing — the state an interrupted
-- lotting session lands in. These are not unfinished. Every one has a title, a
-- description, 3-4 photos, a category, a condition, an MSRP, a starting bid and
-- a bound sticker, and every one is physically on a shelf. They were lotted on
-- 2026-08-13 from the "Wayfair Audit" load and simply never left draft.
--
-- Scope is deliberately narrow — only lots that are ALL of:
--   * status='draft' and in no auction
--   * on a shelf (intake_bin_id set)
--   * complete: title, starting bid, at least one photo
-- which is 21 lots in 3 bins (16 Cage-01-01, 4 in 4-16-03, 1 in 6-04-01).
-- Two further drafts have neither bin nor sticker and are genuinely unfinished;
-- they are left alone.
--
-- intake_at is stamped because these never went through intake_lot_to_bin (it
-- is the field that records when a box was accepted onto a shelf, and reports
-- read it). updated_at is left to the table's own trigger.
--
-- Reversal, if this turns out wrong: the affected rows are exactly those with
-- status='in_inventory' AND intake_at = the timestamp this migration wrote.

UPDATE lots
   SET status = 'in_inventory',
       intake_at = COALESCE(intake_at, now())
 WHERE status = 'draft'
   AND auction_id IS NULL
   AND deleted_at IS NULL
   AND intake_bin_id IS NOT NULL
   AND title IS NOT NULL
   AND length(trim(title)) > 0
   AND starting_bid_cents IS NOT NULL
   AND COALESCE(array_length(photo_urls, 1), 0) > 0;
