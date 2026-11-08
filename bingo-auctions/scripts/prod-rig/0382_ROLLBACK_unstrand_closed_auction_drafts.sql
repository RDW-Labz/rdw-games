-- STANDBY ONLY, never merge. Rollback for 0382: puts the lots 0382 moved back
-- into the closed auctions as drafts, from the whole-row copy 0382 saved in
-- _stranded_closed_auction_drafts_20260930. A lot staff have moved since 0382
-- (scheduled, relotted, disposed) is left alone. Rig-tested 2026-10-06: 215
-- restored to draft with auction_id/lot_number/close_at/intake_at as before.
-- Apply: gh workflow run apply-migration.yml --ref braden/rollback-0382-0387-standby -f mode=rerun -f file=0382_ROLLBACK_unstrand_closed_auction_drafts.sql
BEGIN;
UPDATE public.lots l
SET status     = (c.row_data->>'status')::lot_status,
    auction_id = (c.row_data->>'auction_id')::uuid,
    lot_number = (c.row_data->>'lot_number')::int,
    close_at   = (c.row_data->>'close_at')::timestamptz,
    intake_at  = (c.row_data->>'intake_at')::timestamptz,
    updated_at = now()
FROM public._stranded_closed_auction_drafts_20260930 c
WHERE l.id = c.lot_id AND l.status::text = c.target_status AND l.auction_id IS NULL;
COMMIT;
