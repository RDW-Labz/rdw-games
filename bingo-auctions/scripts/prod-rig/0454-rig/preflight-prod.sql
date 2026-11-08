-- READ-ONLY prod check before applying 0454 (after 0451 and 0453). Not run
-- by the author: no prod access from this rig. Run it with the read-only
-- query workflow, e.g. scripts/prod-rig/q.sh scripts/prod-rig/0454-rig/preflight-prod.sql
-- (or gh workflow run apply-migration.yml -f mode=query — no double quotes in
-- the SQL, which this file has none of).
--
-- Lists what the 0454 guards would refuse if the same change were made
-- today. They only fire on a change (insert, assign, relist, edit of
-- unit_qty/unit_label/starting_bid_cents/bid_mode); existing rows are never
-- re-checked. Expect every count = 0 (no per_unit auction or unit_qty lot
-- exists yet), has_0451 = true, triggers_present = 0 (2 once applied), and a
-- server version >= 14 (CREATE OR REPLACE TRIGGER).
SELECT json_build_object(
  'server_version_num', current_setting('server_version_num')::int,
  'has_0451', (SELECT count(*) = 4 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND ((table_name = 'auctions' AND column_name IN ('bid_mode', 'unit_start_cents'))
                    OR (table_name = 'lots' AND column_name IN ('unit_qty', 'unit_label')))),
  'triggers_present', (SELECT count(*) FROM pg_trigger
                        WHERE tgname IN ('lots_sqft_guard', 'auctions_sqft_mode_lock') AND NOT tgisinternal),
  'name_clash_functions', (SELECT count(*) FROM pg_proc
                            WHERE pronamespace = 'public'::regnamespace
                              AND proname IN ('lots_sqft_guard', 'auctions_sqft_mode_lock')),
  -- auctions by mode / status (expect: all standard)
  'auctions_per_unit', (SELECT count(*) FROM auctions WHERE bid_mode = 'per_unit'),
  'auctions_per_unit_live_or_closed', (SELECT count(*) FROM auctions WHERE bid_mode = 'per_unit' AND status IN ('live', 'closed')),
  'auctions_with_unit_start', (SELECT count(*) FROM auctions WHERE unit_start_cents IS NOT NULL),
  -- lots with sq ft at all (expect 0)
  'lots_with_unit_qty', (SELECT count(*) FROM lots WHERE unit_qty IS NOT NULL),
  'lots_with_unit_label', (SELECT count(*) FROM lots WHERE unit_label IS NOT NULL),
  -- rule 2: quantity and unit not together
  'lots_qty_label_unpaired', (SELECT count(*) FROM lots WHERE (unit_qty IS NULL) <> (unit_label IS NULL)),
  -- rule 4: lot in an auction of the other mode
  'lots_with_qty_in_standard_auction', (SELECT count(*) FROM lots l JOIN auctions a ON a.id = l.auction_id
                                         WHERE a.bid_mode = 'standard' AND l.unit_qty IS NOT NULL),
  'lots_without_qty_in_per_unit_auction', (SELECT count(*) FROM lots l JOIN auctions a ON a.id = l.auction_id
                                            WHERE a.bid_mode = 'per_unit' AND l.unit_qty IS NULL),
  -- rule 5: per_unit start not a whole multiple
  'per_unit_lots_start_not_multiple', (SELECT count(*) FROM lots l JOIN auctions a ON a.id = l.auction_id
                                        WHERE a.bid_mode = 'per_unit' AND l.unit_qty IS NOT NULL
                                          AND l.starting_bid_cents % l.unit_qty <> 0),
  -- rule 3: sq ft already locked on (would refuse an edit)
  'locked_lots_with_qty', (SELECT count(*) FROM lots l
                            WHERE l.unit_qty IS NOT NULL
                              AND (l.status IN ('live', 'won')
                                OR EXISTS (SELECT 1 FROM bids b WHERE b.lot_id = l.id)
                                OR EXISTS (SELECT 1 FROM auctions a WHERE a.id = l.auction_id AND a.status IN ('live', 'closed')))),
  -- relist would copy sq ft from these parents (relistable, with sq ft)
  'relistable_lots_with_qty', (SELECT count(*) FROM lots WHERE unit_qty IS NOT NULL AND status IN ('unsold', 'in_inventory', 'relisted', 'won')),
  -- known gap: auto-relist picks the soonest auction at the warehouse without
  -- looking at bid_mode. Operators where that can matter once a per_unit
  -- auction exists:
  'operators_auto_relist_auto', (SELECT count(*) FROM operators
                                  WHERE auto_relist_enabled AND auto_relist_max_attempts > 0 AND auto_relist_mode = 'auto')
) AS preflight_0454;
