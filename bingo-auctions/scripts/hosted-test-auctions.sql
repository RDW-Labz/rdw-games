-- Test auctions + live lots for the hosted Supabase project.
-- Creates a live auction under operator CLU with six lots whose
-- close_at times span the full heat range (urgent → closing → live)
-- so the bidder app's color tiers and countdown timers are exercised.

-- Auction first. End time is the latest lot's close_at + a buffer so
-- the auction itself remains live until all lots have closed.
INSERT INTO auctions (
  id, operator_id, warehouse_id, title,
  starts_at, ends_at, soft_close_minutes,
  pickup_starts_at, pickup_ends_at, buyer_premium_bps, status
) VALUES (
  '33333333-3333-3333-3333-333333333333',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  'Cluer · Live Test Auction',
  now() - interval '1 hour',
  now() + interval '2 days',
  3,
  now() + interval '2 days' + interval '4 hours',
  now() + interval '5 days',
  1500, 'live'
) ON CONFLICT (id) DO UPDATE SET
  status = EXCLUDED.status,
  starts_at = EXCLUDED.starts_at,
  ends_at = EXCLUDED.ends_at;

-- Wipe any existing lots for this auction so we can reseed cleanly.
-- The auction itself is upserted above; lots get fresh codes/timings.
DELETE FROM lots WHERE auction_id = '33333333-3333-3333-3333-333333333333';

-- Inserts six live lots with varied close_at offsets. lot_code via the
-- operator's next_lot_seq sequence so codes look like CLU-000001 …
DO $$
DECLARE
  v_lot record;
  v_code text;
  v_lots constant text[][] := ARRAY[
    ['1',  'Apple AirPods Pro 2 — Sealed Retail Box',
       'Amazon return, factory-sealed packaging. Carry case + USB-C lightning.',
       'electronics', 'appears_new',     '24900', '100',  '90 seconds'],
    ['2',  'KitchenAid Artisan Stand Mixer (Empire Red)',
       'Open box, all parts accounted for. Light scratch on bowl rim.',
       'home',        'open_box',        '39900', '500',  '8 minutes'],
    ['3',  'DeWalt DCD771C2 20V MAX Drill Driver Kit',
       'Used, fully working. Includes battery, charger, hard case.',
       'tools',       'good',            '14900', '300',  '25 minutes'],
    ['4',  'Sony WH-1000XM5 Wireless Noise Cancelling Headphones',
       'Open box, in original packaging. Cable + carrying case included.',
       'electronics', 'open_box',        '39900', '500',  '90 minutes'],
    ['5',  'Weber Spirit II E-310 3-Burner Gas Grill',
       'Customer return, never assembled. All boxes intact.',
       'home',        'appears_new',     '54900', '1000', '6 hours'],
    ['6',  'Mystery Bin — Mixed Tools (~25 lbs)',
       'Sold as-is. Contents not individually photographed; expect drills, wrenches, accessories.',
       'tools',       'as_is',           NULL,    '100',  '20 hours']
  ];
BEGIN
  FOR i IN 1..array_upper(v_lots, 1) LOOP
    -- Reserve a fresh lot_code per lot (atomic, increments next_lot_seq).
    v_code := next_lot_code('11111111-1111-1111-1111-111111111111');

    INSERT INTO lots (
      operator_id, auction_id, warehouse_id,
      lot_number, lot_code,
      title, description, category, condition,
      msrp_cents, starting_bid_cents, close_at,
      photo_urls, status
    ) VALUES (
      '11111111-1111-1111-1111-111111111111',
      '33333333-3333-3333-3333-333333333333',
      '22222222-2222-2222-2222-222222222222',
      v_lots[i][1]::int,
      v_code,
      v_lots[i][2],
      v_lots[i][3],
      v_lots[i][4],
      v_lots[i][5]::lot_condition,
      NULLIF(v_lots[i][6], '')::bigint,
      v_lots[i][7]::bigint,
      now() + (v_lots[i][8])::interval,
      ARRAY['https://picsum.photos/seed/' || v_code || '/800/600'],
      'live'
    );
  END LOOP;
END $$;

-- Verify
SELECT lot_number, lot_code, title, status,
  EXTRACT(EPOCH FROM (close_at - now()))/60 AS minutes_to_close,
  starting_bid_cents
FROM lots
WHERE auction_id = '33333333-3333-3333-3333-333333333333'
ORDER BY lot_number;
