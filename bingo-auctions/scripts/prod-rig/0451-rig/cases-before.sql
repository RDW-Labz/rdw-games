-- Pre-migration snapshot: row counts + a sample, and confirm the columns don't exist yet.
SELECT 'lots count: ' || count(*) FROM lots;
SELECT 'auctions count: ' || count(*) FROM auctions;
SELECT 'sample lot: ' || id || ' ' || lot_code || ' ' || status FROM lots ORDER BY lot_code;
SELECT 'sample auction: ' || id || ' ' || status FROM auctions ORDER BY id;
SELECT 'bid_mode exists: ' || (to_regclass('public.auctions') IS NOT NULL
  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='auctions' AND column_name='bid_mode'));
SELECT 'unit_start_cents exists: ' || EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='auctions' AND column_name='unit_start_cents');
SELECT 'unit_qty exists: ' || EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='lots' AND column_name='unit_qty');
SELECT 'unit_label exists: ' || EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='lots' AND column_name='unit_label');
