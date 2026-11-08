-- 0431 dry run, read-only: run with mode=query (no double quotes). One row.
-- Expected 2026-10-21: listed 9, on_old_load 9, deleted 0, manifest_links 0.
WITH ids AS (SELECT unnest(ARRAY['7a76ab40-84ce-40e7-b41f-4f0db48b3a81','6e174fbb-514c-4ed2-a007-abc7e96b7963','df9695c0-cffb-4c4e-a563-094f5b06a8ef','9c04e2fb-ba2e-4d85-9584-93025de77da1','ab31717c-008c-4d59-a6ab-ba0cd0d259a9','5b0122ef-c52b-47b9-ad98-1d230d82e14e','12d91d4f-f54b-4603-a6d9-3f2474fc9d65','24a59a35-9d04-47ac-97f4-3e91a961dbb1','a8a5e550-05bc-4dc3-92cf-74c11126e0d9']::uuid[]) AS lot_id)
SELECT count(*) AS listed,
 count(*) FILTER (WHERE l.load_id::text = 'e82bc44a-774b-4bb1-ab68-a0b67f15a5b3' AND l.operator_id::text = '05775af4-adb7-4f0f-943e-94a91e17f60d') AS on_old_load,
 count(*) FILTER (WHERE l.deleted_at IS NOT NULL) AS deleted,
 (SELECT count(*) FROM import_rows ir JOIN ids ON ids.lot_id = ir.lot_id) AS manifest_links,
 string_agg(l.lot_code, ' ' ORDER BY l.lot_code) AS lots
FROM ids LEFT JOIN lots l ON l.id = ids.lot_id
