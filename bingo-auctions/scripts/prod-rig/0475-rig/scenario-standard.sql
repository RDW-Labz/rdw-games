-- Standard flows that 0475 must NOT change. Run on a copy WITHOUT 0475 and a
-- copy WITH it; run.sh diffs the printed state. No refund-to-unsold case here
-- (that one is meant to differ); refunds here are of picked-up, missing,
-- forfeited or other-sale lines, or leave other lines open.
\set ON_ERROR_STOP 1
SELECT rig_as('00000000-0000-0000-0000-0000000000c1');
-- normal pickup of L08's partner flow: stamp a pickup on L04
UPDATE invoice_lots SET picked_up_at = now() WHERE lot_id = '00000000-0000-0000-0000-000000000104';
-- refund after pickup (L02), missing (L05), forfeited (L07), other open sale (L06)
UPDATE invoice_lots SET refunded_at = now() WHERE lot_id IN ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000105', '00000000-0000-0000-0000-000000000107')
   AND invoice_id = '00000000-0000-0000-0000-0000000002a1';
UPDATE invoice_lots SET refunded_at = now() WHERE lot_id = '00000000-0000-0000-0000-000000000106' AND invoice_id = '00000000-0000-0000-0000-0000000002a1';
-- no-show forfeit sets the lot unsold through its own path (simulated)
UPDATE lots SET status = 'unsold' WHERE id = '00000000-0000-0000-0000-000000000107';
-- plain relist of an unsold lot into the next auction
SELECT 'REL ' || (public.relist_lot_into_auction('00000000-0000-0000-0000-000000000111', '00000000-0000-0000-0000-00000000aa03') IS NOT NULL);
-- re-stamping an already-refunded line changes nothing
UPDATE invoice_lots SET refunded_at = refunded_at WHERE lot_id = '00000000-0000-0000-0000-000000000109';

SELECT 'LOT ' || lot_code || ' ' || status || ' winner=' || (winner_bidder_id IS NOT NULL) || ' auction=' || coalesce(left(auction_id::text, 8), '-')
  FROM lots WHERE lot_code LIKE 'L%' ORDER BY lot_code, created_at;
SELECT 'LINE ' || l.lot_code || ' ' || left(il.invoice_id::text, 8) || ' picked=' || (il.picked_up_at IS NOT NULL) || ' refunded=' || (il.refunded_at IS NOT NULL) || ' forfeited=' || (il.forfeited_at IS NOT NULL)
  FROM invoice_lots il JOIN lots l ON l.id = il.lot_id ORDER BY l.lot_code, il.invoice_id;
SELECT 'HIST ' || l.lot_code || ' ' || string_agg(coalesce(h.from_status::text, '-') || '>' || h.to_status::text, ',' ORDER BY h.changed_at)
  FROM lot_status_history h JOIN lots l ON l.id = h.lot_id WHERE l.lot_code LIKE 'L%' GROUP BY l.lot_code ORDER BY 1;
