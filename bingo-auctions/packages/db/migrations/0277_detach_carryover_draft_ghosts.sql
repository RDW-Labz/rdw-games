-- 0277 — detach "carryover ghost" draft lots stranded in auctions
--
-- Report 2026-07-17 (Jared): legacy/relisted lots appearing in auctions past the
-- intended 100-lot count (e.g. BIN-003049 as Lot #106 in the LIVE "Fresh Off the
-- Truck"), with close times running past the auction's end.
--
-- Root cause (verified in code, NOT the auto-relist cron — BinGo is
-- auto_relist_mode='review', so that cron does not mint):
--   The auction builder's "carry over unsold / unpicked-up" path
--   (apps/operator-web/.../auctions/[id]/builder/actions.ts → relistLotInto →
--   relist_lot_into_auction, mig 0213) creates the carried-over lot with
--   status='draft' (0213:129) while ASSIGNING it an auction_id + lot_number +
--   close_at. The "available" assign path (assign_lots_to_auction, 0208) instead
--   creates status='scheduled'. On publish, scheduled→live is promoted but the
--   DRAFT carryover lots are left behind — so they linger as numbered ghosts
--   after #100. Bidder/public pages filter to scheduled|live, so these ghosts are
--   NOT customer-biddable (verified: no bids), but they inflate the operator lot
--   count and extend the staggered close schedule past the auction's intended end.
--
-- Blast radius (prod, 2026-07-17): ~74 draft relist-children across 8 auctions,
-- all starting at lot_number 101 (4 live + 4 closed auctions).
--
-- This migration DETACHES those ghosts: clears auction_id / lot_number / close_at
-- and returns them to the unassigned in_inventory pool so staff can re-add them
-- deliberately (same restore shape cancel_auction/0199 and 0276 step-3 use).
-- The physical item keeps exactly one lot (this child — it carries the source's
-- sticker/qr via 0213); the source parent stays 'relisted' as the tombstone.
--
-- Age guard: only children created > 2h before apply are detached, so a lot a
-- staffer is actively relisting-then-publishing right now is never yanked
-- mid-edit. Every current ghost is >12h old, so all 74 are covered.
--
-- Idempotent: re-running finds nothing (detached rows no longer match).

BEGIN;

UPDATE lots
   SET auction_id = NULL,
       lot_number = NULL,
       close_at   = NULL,
       status     = 'in_inventory'::lot_status,
       updated_at = now()
 WHERE status = 'draft'
   AND relisted_from_lot_id IS NOT NULL
   AND auction_id IS NOT NULL
   AND deleted_at IS NULL
   AND created_at < now() - interval '2 hours';

COMMIT;
