-- Read-only prod check BEFORE applying 0453 (after 0451 is applied).
-- Run: scripts/prod-rig/q.sh scripts/prod-rig/0453-rig/preflight-prod.sql
-- Expect: live_md5 = 7b6261a9548864b102f841546003db0d (or a1572dfd7f88e8a58cbb5608d62f2604
-- if 0453 is already applied), overloads = 1 (2 after), has_0451 = true.
-- live_md5 anything else = the migration will refuse; stop and compare bodies.
SELECT json_build_object(
  'live_md5', (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.place_bid(uuid,bigint)'::regprocedure),
  'overloads', (SELECT count(*) FROM pg_proc WHERE proname = 'place_bid' AND pronamespace = 'public'::regnamespace),
  'acl_2arg', (SELECT proacl::text FROM pg_proc WHERE oid = 'public.place_bid(uuid,bigint)'::regprocedure),
  'has_0451', (SELECT count(*) = 2 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND ((table_name = 'auctions' AND column_name = 'bid_mode') OR (table_name = 'lots' AND column_name = 'unit_qty')))
) AS preflight_0453;
