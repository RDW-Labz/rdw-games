\set ON_ERROR_STOP 0
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
SELECT 'report open: ' || string_agg(lot_code || '=' || state, ', ' ORDER BY lot_code) FROM missing_items_report(true);
SELECT 'P1 found 4-09-02: ' || missing_item_found('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-00000000aaa1', 'found it')::text;
SELECT 'P2 found 15-11-01: ' || missing_item_found('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-00000000aaa2', NULL)::text;
SELECT 'P3 found 7-14-01: ' || missing_item_found('00000000-0000-0000-0000-000000000105','00000000-0000-0000-0000-00000000aaa3', NULL)::text;
SELECT 'events: ' || coalesce(string_agg(l.lot_code, ',' ORDER BY l.lot_code), 'none') FROM lot_location_events e JOIN lots l ON l.id = e.lot_id;
SELECT 'checks: ' || coalesce(string_agg(l.lot_code || ':' || c.outcome, ',' ORDER BY l.lot_code), 'none') FROM missing_item_checks c JOIN lots l ON l.id = c.lot_id;
SELECT 'report after: ' || string_agg(lot_code || '=' || state, ', ' ORDER BY lot_code) FROM missing_items_report(true);
