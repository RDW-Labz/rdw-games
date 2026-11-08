SELECT jsonb_build_object(
  'in_inventory', (SELECT count(*) FROM _stranded_closed_auction_drafts_20260930 c JOIN lots l ON l.id = c.lot_id WHERE c.target_status = 'in_inventory' AND l.status = 'in_inventory' AND l.auction_id IS NULL AND l.lot_number IS NULL),
  'pending_intake', (SELECT count(*) FROM _stranded_closed_auction_drafts_20260930 c JOIN lots l ON l.id = c.lot_id WHERE c.target_status = 'pending_intake' AND l.status = 'pending_intake' AND l.auction_id IS NULL AND l.lot_number IS NULL),
  'still_draft', (SELECT count(*) FROM _stranded_closed_auction_drafts_20260930 c JOIN lots l ON l.id = c.lot_id WHERE l.status = 'draft'),
  'ledger', (SELECT count(*) FROM _schema_migrations WHERE filename = '0382_unstrand_closed_auction_drafts.sql')) AS v
