-- footprint-exempt: returns stranded draft relist copies to inventory; nothing deleted, hidden or re-coded, sticker and shelf keep pointing at the same lot; owner-approved 2026-10-06
-- 0382 — put the 216 draft relist copies stranded in closed auctions back
--        into inventory, so staff can find them and sell them again.
--
-- ── WHAT HAPPENED ────────────────────────────────────────────────────────────
-- Before 0329 (merged 2026-08-20) a desk relist minted the child lot as 'draft'
-- inside the target auction. When nothing promoted it, the auction opened and
-- closed around it: open_due_lots only opens 'scheduled' lots, finalize only
-- closes 'live' ones, and advance_auction_lifecycle closes the auction without
-- touching drafts. The 0329 repair only fixed drafts whose auction was still
-- live/scheduled; 0277 only ran once (7/18); 0335 only took auction_id IS NULL.
-- So 216 lots sit as 'draft' with a closed auction's auction_id/lot_number/
-- close_at. Every Inventory and Auction Builder list requires
-- status = 'in_inventory' AND auction_id IS NULL, and relist refuses a 'draft'
-- source, so staff cannot see or fix them from either app.
-- Found in docs/state/INVESTIGATION-2026-09-30.md §1; list in
-- docs/state/stranded-drafts-2026-09-30.csv.
--
-- Measured on prod 2026-09-30: all 216 are desk_relist children created
-- 2026-07-18..08-16, 0 bids, no invoice line, parent status 'relisted', no
-- other lineage member draft/scheduled/live, sticker bound, warehouse set.
-- 206 have a shelf (intake_bin_id); 9 do not. No draft has been created since.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────
-- For exactly the 216 IDs below, re-checked in this transaction:
--   • on a shelf (206): status 'in_inventory', intake_at kept or now() — the
--     state put-away gives a shelved lot (as 0277 / 0335 / Worklist Pull).
--   • no shelf (9): status 'pending_intake', so the next put-away scan moves
--     it to 'in_inventory' through the normal path (0295). Not shelved means
--     no one should be offered it for an auction yet.
--   • both: auction_id, lot_number, close_at cleared (they never went live in
--     that auction, and the lot number blocks nothing once the lot leaves it).
--
-- ── WHAT THIS DOES NOT TOUCH ─────────────────────────────────────────────────
-- Lot identity: id, lot_code, sticker_code, qr_token, intake_bin_id, title,
-- photos, relist lineage (relisted_from_lot_id, relist_count, relist_origin).
-- No auctions, bids, invoices, bins or stickers. The closed auctions keep
-- their results; these lots were never in the sale (0 bids, never live).
--
-- ── PHYSICAL FOOTPRINT (docs/PREFLIGHT.md) ───────────────────────────────────
-- These rows DO have a physical footprint (stickers, shelves) — that is why
-- they matter. This is not destructive cleanup: nothing is deleted, hidden,
-- merged or re-coded, and the box, sticker and shelf all keep pointing at the
-- same lot. assert_no_physical_footprint() is therefore NOT called: it exists
-- to refuse destructive batches and would (correctly) refuse this one. The
-- Physical footprint guard CI lint flags this file for that reason. This needs
-- the owner's explicit sign-off on the exact IDs, and a warehouse check of the
-- 9 no-shelf lots, before it is applied. No bypass is added.
--
-- ── SAFETY ───────────────────────────────────────────────────────────────────
-- Each row is copied whole (to_jsonb) into
-- public._stranded_closed_auction_drafts_20260930 before the UPDATE; the
-- reversal at the bottom restores status/auction_id/lot_number/close_at/
-- intake_at exactly.
-- The capture must be exactly 206 shelved + 9 unshelved or the migration
-- aborts (re-measure first: something moved). A database with none of these
-- lots (CI's fresh replay, a local reset) skips with a NOTICE. Idempotent: a
-- rerun finds no drafts to capture and changes nothing.
-- CONCURRENCY: rows are locked FOR UPDATE at capture. A staff edit that lands
-- first changes a checked column and drops the row from the capture, and the
-- count check aborts. lock_timeout bounds the wait.
-- WINDOW: 05:00–07:00 CT (Rule 9: a lots write; it also puts 206 lots in
-- front of staff in Inventory, so do it before they arrive, not mid-shift).
--
-- Dry run (read-only): scripts/prod-rig/0382-dry-run.sql via q.sh.

BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public._stranded_closed_auction_drafts_20260930 (
  lot_id        uuid PRIMARY KEY,
  target_status text        NOT NULL CHECK (target_status IN ('in_inventory', 'pending_intake')),
  row_data      jsonb       NOT NULL,
  captured_at   timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public._stranded_closed_auction_drafts_20260930 FROM PUBLIC, anon, authenticated;

DROP TABLE IF EXISTS pg_temp._0382_ids;
CREATE TEMP TABLE _0382_ids (lot_id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO _0382_ids (lot_id) VALUES
  ('00cd7d41-8dbf-4034-94ab-d8c3e059f8f9'::uuid),
  ('00da3a62-d6e6-4335-872a-9fcf2bce3c19'::uuid),
  ('0320f186-3055-4dcb-b226-04dd8329ed5d'::uuid),
  ('03bf8f57-8f60-42c2-bce1-d39f1346aacb'::uuid),
  ('0707ca97-5202-4a1c-8ca6-3f78de7a5487'::uuid),
  ('0803d582-3d53-4519-81aa-e94c3cc84c92'::uuid),
  ('08b3f6eb-37be-4fc4-aa25-298fdb973a06'::uuid),
  ('0ccc6d26-b689-4a5b-bfd3-0be67f52f9ab'::uuid),
  ('11c6bb1b-8fdb-4410-8f75-dce7c958eb5d'::uuid),
  ('16040441-fbd0-4d3d-a132-1e6d9eb9bf97'::uuid),
  ('181be49a-e5ac-4b77-99f2-c0a53e28cf06'::uuid),
  ('19c7f8e9-b51a-4647-b8d7-386df09568cb'::uuid),
  ('1a67fc6e-9f90-4629-9fbc-48b9d4e1ac20'::uuid),
  ('1bfc13c3-bad9-4054-8472-9418520b4a27'::uuid),
  ('1c81ccdc-046e-4590-92cb-904451bdd308'::uuid),
  ('1da3c7ba-2c03-4779-9b35-2e517c7a9cc8'::uuid),
  ('20f1b8c2-95de-4e4c-90c4-1759e8ba41fb'::uuid),
  ('25db5844-13ed-4adb-8020-e33df48642c4'::uuid),
  ('2692de43-b165-4095-affe-f475797e6d66'::uuid),
  ('27347960-987b-4383-a7ee-ef864506ffb3'::uuid),
  ('2b11ce39-45ce-42b0-bdd4-56ddc190b214'::uuid),
  ('30e3c639-fa97-48a8-bdbe-4cfb1f37d068'::uuid),
  ('33b3fd30-c367-4c1e-917c-b1455757762e'::uuid),
  ('348cd842-d2cc-4392-803f-2e8e851567fb'::uuid),
  ('3513ad8c-9462-4e38-9fe6-b3a06e8fb938'::uuid),
  ('35275726-a5b1-4682-84a8-357b63512716'::uuid),
  ('36800be3-ccd4-4505-a3c9-b6c4e6813be4'::uuid),
  ('36aa3f35-244a-439d-9b02-e27e82750a8b'::uuid),
  ('36b0fbf9-cc0b-4118-9035-a758bc4b0298'::uuid),
  ('36e2f256-7465-4630-8c75-dff14afd31c4'::uuid),
  ('375010c7-9bda-4a21-9ce7-ca11f8d4e3e2'::uuid),
  ('37bbc595-570b-4ec0-a36d-99aeb33c13f3'::uuid),
  ('391cbf00-98f2-4bae-ad91-3f18bad32f08'::uuid),
  ('3a746331-475b-40f1-983d-53ac84043f0a'::uuid),
  ('3a943008-2813-4b0f-af22-8283c864ea9a'::uuid),
  ('3b0d382a-3532-43e4-a2ab-b516748b390d'::uuid),
  ('3c571cea-75de-44ad-a088-ce84dc3d7c5c'::uuid),
  ('3db9d450-e60a-430a-b727-a7e95b1fec49'::uuid),
  ('3e2fee16-1eef-463e-a444-0abedf97ce4b'::uuid),
  ('3e582a4b-fc90-481b-8b7e-b7b5b26f8fd3'::uuid),
  ('3f382152-75b9-4028-8c11-830f5c88d54a'::uuid),
  ('4007e19e-21e5-4b68-9f7e-380e9d05d5d6'::uuid),
  ('413aae12-388b-4733-9c5f-65c07a60383f'::uuid),
  ('42275ba0-12b1-4254-a25d-0305ca19ce98'::uuid),
  ('4396ffcf-2610-43d1-bd2e-af121d7f9c7a'::uuid),
  ('450901a1-82cb-43ca-8277-d3713a15f7de'::uuid),
  ('45acdeb3-8a7c-47df-aeb6-2f94826573fc'::uuid),
  ('4b0aa808-7e6d-402a-af95-64679e6d22d0'::uuid),
  ('4c61327b-d25b-40cf-80a0-86ec61f1a516'::uuid),
  ('4d50ae5b-9922-46e3-89bf-e104aae06aee'::uuid),
  ('511210ba-ba04-48b4-a2d0-ae3cd4ba8ffe'::uuid),
  ('5317ea36-ea73-4754-9bb8-eb88a2f3ccf8'::uuid),
  ('5528a099-b2a7-4252-8b7f-5edd3660b6d6'::uuid),
  ('5647e987-0b6e-4a62-a2a8-edf9126e7332'::uuid),
  ('579308f2-fda9-460f-b896-92e8793e33b4'::uuid),
  ('5858379b-8914-484f-9bf4-ebd9866b53f1'::uuid),
  ('5953ade1-e0e5-47ea-a916-86cdcf7b5428'::uuid),
  ('5969c40b-2882-4358-9cc9-fa3eb123b6e6'::uuid),
  ('59fbcbb7-c407-485f-9d42-cbb66c123357'::uuid),
  ('5a328bcf-ebc3-4d08-b21f-ce09c459565e'::uuid),
  ('5b754a51-83ce-428f-be90-3cc079dd725b'::uuid),
  ('5dc12668-b575-44d5-a559-6e1a9b85ac78'::uuid),
  ('5e9eafbd-9fc8-470a-9dba-0c226ed6a8c7'::uuid),
  ('61eed2b9-0903-40ff-8ec0-988f6282aa56'::uuid),
  ('64449e69-c411-408a-9b11-9901e735a83d'::uuid),
  ('672b0575-8dda-4124-bb53-ccbd540099e8'::uuid),
  ('6844243f-0e9f-4c6a-9779-a29a753c95de'::uuid),
  ('6955ee0f-a830-4a2c-9503-df3aa21e3f45'::uuid),
  ('6a3c37d4-9af4-4907-a38f-a1fb6e6db1e4'::uuid),
  ('6caa6a65-eef0-49d7-807b-bf0aea85972a'::uuid),
  ('6cbfc473-4dce-4ea2-a748-f401e3d7ca06'::uuid),
  ('6d1cff5d-7f00-44fe-9bcb-9fd10a21b79f'::uuid),
  ('6d9f1a68-13cb-41a0-a8a7-b14149bb606a'::uuid),
  ('6f814536-bcab-45aa-bc3d-b87d6d62df4e'::uuid),
  ('6f86d428-db9a-4bc0-adde-6bfc4ad82a3e'::uuid),
  ('6fc2d47e-c41e-4b0e-a6c1-b06dd3c89296'::uuid),
  ('71170403-5c96-481a-8724-0d61496956f4'::uuid),
  ('723faacf-c572-490e-b684-b957f5f21888'::uuid),
  ('724bde83-d092-47b7-a808-030c9d3313d7'::uuid),
  ('72bc768f-a00e-4286-af25-06210f8d30bb'::uuid),
  ('72d25745-b392-4a19-acb6-c90ce93c6359'::uuid),
  ('73909166-f221-492e-b4c4-6e83060ab5ab'::uuid),
  ('740d7751-e330-4670-b73a-49f87e9dbe60'::uuid),
  ('77b5db31-d54b-4718-b19a-985653b97af5'::uuid),
  ('7877dd5b-58a3-4ecd-b440-2fb1dbcb289c'::uuid),
  ('7b7148f9-199f-456f-97f0-01d9156ddf10'::uuid),
  ('7b764bf4-0fbf-4e39-a18f-2b0a8ea2650e'::uuid),
  ('7d02a1e3-9db7-4be9-82d0-80b519109ab4'::uuid),
  ('7e8f2107-4f8a-473f-8e1f-9c063688da6f'::uuid),
  ('7efc529f-a984-49d4-82ca-fc1269cfc963'::uuid),
  ('7f482c43-ad39-41c1-abde-385ed700df59'::uuid),
  ('80b1a1d7-7252-499e-99ea-da120c628954'::uuid),
  ('81594d85-6771-4077-835f-e300c40f2f2f'::uuid),
  ('81b3e725-8ced-4677-9adb-424a086ebbc2'::uuid),
  ('81c2092f-10f1-4d64-9234-38a795bff40f'::uuid),
  ('837d22c7-89ff-4f7d-9927-a06409ed8aa1'::uuid),
  ('837df83f-c357-48f1-9728-e2053a55abf7'::uuid),
  ('851335fa-03c5-40c3-a995-f2f561e3812b'::uuid),
  ('8543fc3f-80b1-4d87-ba2f-8e50fabd58ba'::uuid),
  ('8597e1fa-6a88-4f85-afed-33d313239000'::uuid),
  ('86ac258e-a24a-4e17-85f4-652dacfa95e9'::uuid),
  ('86faae2a-89a4-4111-aa87-a35abcd9c06c'::uuid),
  ('8703f818-48f0-46e1-a488-d121cd9ca0ac'::uuid),
  ('898e7d29-abd3-44c1-bfd4-71583a21e82f'::uuid),
  ('89a5742e-c2de-4622-b597-fcc416ff88e3'::uuid),
  ('89aff545-eb24-4078-8342-46c6479cfff4'::uuid),
  ('91331899-f99c-4bdb-bb74-9576c33bb3c0'::uuid),
  ('91d4a764-627e-40e5-8d0d-0161b6355c28'::uuid),
  ('94ec5d63-c3ae-448a-a544-52efca03f461'::uuid),
  ('97b8a849-c345-4d44-8647-f653f2d01966'::uuid),
  ('998e0052-bc0c-4176-b46a-764ea3484efd'::uuid),
  ('9a99671a-b101-4b40-8ef4-acdaa6aaf651'::uuid),
  ('9b37a87f-5621-4221-bd1f-b52c6b71fefb'::uuid),
  ('9c1c60c1-82f8-460a-85a2-b995492bd251'::uuid),
  ('9d515b71-75cf-410a-9a41-bc5f9ad4791f'::uuid),
  ('a075b53e-0927-4a4c-b20e-65d4e53439fe'::uuid),
  ('a0a9191c-642b-4a9e-9284-f17097218238'::uuid),
  ('a0b0336b-b92d-4473-acfb-cb1fce77bf87'::uuid),
  ('a11029be-e6eb-4858-92c7-cd72d9a92cb7'::uuid),
  ('a128d5ac-50f5-4cf3-8864-1a3c3d69611c'::uuid),
  ('a162ad75-5309-4712-b175-2ec1b4873715'::uuid),
  ('a29998cc-3e05-43f6-a996-900b970911c6'::uuid),
  ('a3905bd5-92be-4833-9748-eca14a47132e'::uuid),
  ('a3c7c758-0314-4a9b-b2ea-702b515a0ed4'::uuid),
  ('a440eb4a-c891-48f2-b764-a35e41340ae9'::uuid),
  ('a46702f7-3d50-4261-8828-0cadd24283a6'::uuid),
  ('a4b15a41-588d-4fc1-99cd-10dc65a5563d'::uuid),
  ('a50f30c7-ec9e-4e00-ad41-d9519dbe202d'::uuid),
  ('a642d370-8a16-45aa-b7c7-983b459ff342'::uuid),
  ('a6eff19b-8b13-4c62-902c-254f6b9c93e4'::uuid),
  ('a7456098-d51d-4e23-93d0-35f3f1cd0f2c'::uuid),
  ('a7a9bc4b-ae2c-42e1-ab3d-c688cf280c2d'::uuid),
  ('ace8f535-6bf3-4db2-a238-91f91d234c70'::uuid),
  ('aeae5fd1-9c7e-418c-94e6-a27c75e7b957'::uuid),
  ('af546835-aa10-4d1e-97e5-960a8f9d5b44'::uuid),
  ('b0267f57-cce4-4373-a83e-51c63c322db7'::uuid),
  ('b0b6f22c-5ee6-48da-9e4d-498d26cbb25b'::uuid),
  ('b0e575e9-6d3d-4282-8e96-3b0d8ad12512'::uuid),
  ('b0e5a0ba-ebb2-4e05-a7a1-dd4480565a98'::uuid),
  ('b1d4207b-a926-4793-a0b2-22690f045542'::uuid),
  ('b1fd8faf-69ee-4184-b911-d24cfcf25d71'::uuid),
  ('b2457994-9d52-46c8-883e-e7d744a776b4'::uuid),
  ('b2b9cac0-f9ab-45e6-a18b-fa4097fed492'::uuid),
  ('b2f77d3a-1b67-47a4-b274-9626bce67243'::uuid),
  ('b4297b44-9cec-47b5-be83-851f5c4a4ef3'::uuid),
  ('b57d71ea-562c-4384-9da4-b93da86d5434'::uuid),
  ('b6763331-30c8-4464-b86a-28569b3ec1c6'::uuid),
  ('b6b74517-07bc-42ec-a2f0-98172f7da36c'::uuid),
  ('b73c1eb8-e678-48eb-8521-8e3902326663'::uuid),
  ('b81b3451-2207-4cdc-af21-9500ce3c20e2'::uuid),
  ('b8c90d2d-7ce5-4f40-a762-4f0185063091'::uuid),
  ('b8d30c35-8d5d-4bee-bb25-853ee20e006f'::uuid),
  ('ba240f15-af9f-4bb4-a5a5-86909ee58491'::uuid),
  ('bb39aaca-0a4f-4277-bc4c-162332786449'::uuid),
  ('bb44c938-4e2d-4dd6-a853-3a8611a5893e'::uuid),
  ('bbeee4f9-03bd-45bc-9445-2ac51e4264e3'::uuid),
  ('bd602841-a199-4bc1-889e-b2a8294a2c5b'::uuid),
  ('bdbc8cd9-dfe5-4dcc-8a70-039ffbc38827'::uuid),
  ('bf1c3dad-4b30-4ecc-9b29-938201677c9c'::uuid),
  ('bfcd4397-70c7-4bc4-8d77-37be5a0084ff'::uuid),
  ('c16e8412-7fe3-47fb-b7a6-9570d466ea12'::uuid),
  ('c2def95e-ba0c-46fb-8880-06754d19aecb'::uuid),
  ('c32fd72e-6a45-4f28-837c-ce3afab1cf16'::uuid),
  ('c5b9e82a-f2bf-4aeb-ad80-1383e096eaf5'::uuid),
  ('c6f695d4-cab9-436d-8328-fd3d06473665'::uuid),
  ('c803b94e-07a2-4793-8a35-0496db315352'::uuid),
  ('c8405185-b76d-4ee7-961c-f378b66bbaf3'::uuid),
  ('c9587bd6-fa2f-42e5-962a-3c40cb731a15'::uuid),
  ('c9fa1947-9cf2-4ab4-9228-b6c1f7058a15'::uuid),
  ('ce185835-bd7a-4c92-8847-72d47cf0cceb'::uuid),
  ('ce403cc9-7dff-4e65-8c6a-d2bcf10d1af7'::uuid),
  ('d01d45c0-eef2-4baa-9d25-cca6363344f6'::uuid),
  ('d2be7e31-a2b1-4a99-9555-2bcc807c10d1'::uuid),
  ('d3f8d480-fe1f-4ee3-a8ac-35500dd178dd'::uuid),
  ('d5c984bf-8ca0-433a-ac68-f274bdfab29c'::uuid),
  ('d5e1d9d8-629f-4bba-998f-50968cf1c370'::uuid),
  ('d6919bd4-4a34-4571-882c-3acdc89dcb78'::uuid),
  ('d69686d7-4d0c-4c12-9c1a-21d0d514f469'::uuid),
  ('d807799a-f90e-421c-bee4-ade45a723022'::uuid),
  ('d821dd45-dee9-4663-9989-96ce19e488ec'::uuid),
  ('daa7d3d5-9496-475d-aec0-0afbfdf7a8ad'::uuid),
  ('db141a4a-48fd-4954-aa51-458721e1be3c'::uuid),
  ('dcdf4781-2511-4202-af15-98ed551cf46e'::uuid),
  ('dd1ac0f1-cb83-45b2-909d-ae8bb08bb309'::uuid),
  ('dd77c604-53f5-4dd8-96cc-9cc34864d18e'::uuid),
  ('ddcdba62-3ecd-4315-be8e-1bedcc98fd5f'::uuid),
  ('dfef285f-ac0e-41a1-a2ef-fcf18c23f3a3'::uuid),
  ('dff360ac-c7a5-41c1-b145-9e24f64400dd'::uuid),
  ('e0cdde67-be77-475d-9b53-c2d917ebf7fa'::uuid),
  ('e4ea1409-3a70-4aa6-8d23-6d6f9bf953b0'::uuid),
  ('e6f37cb2-8466-484c-8091-f4025700a497'::uuid),
  ('ea6f7cae-89b0-4397-85d1-4031601fa572'::uuid),
  ('eafca101-c7bc-462c-bdde-e8429d4579fc'::uuid),
  ('ebe0da1d-3fd8-4b40-bc17-5e4293419d9e'::uuid),
  ('ec086fb2-97a2-4bcd-8380-b5c9caba5559'::uuid),
  ('ec445931-23e6-48a0-ad64-dda577d53d1c'::uuid),
  ('ed0faed5-26fa-4360-b340-1898c56e9b55'::uuid),
  ('edb96ab1-2157-44aa-9315-7bd1c8f0fd42'::uuid),
  ('edbc50f8-3c2a-4896-90ba-16f9b2137aec'::uuid),
  ('ee4800bf-d16a-4eb9-9d92-becea7fed882'::uuid),
  ('ee54dba0-7b1c-49e7-ad65-71f0cfe1fb37'::uuid),
  ('f0110617-7e4c-48ee-9de7-57ddcf101f53'::uuid),
  ('f06a52ca-60c9-4d6a-8b3c-5a655ce377d6'::uuid),
  ('f096d01d-43a0-4804-9b15-ff7b8bdd9463'::uuid),
  ('f175237c-8fba-4781-b910-cc036d551850'::uuid),
  ('f738cf0d-eb12-4b5f-991e-a5bbcb9a7c03'::uuid),
  ('f788d70c-f5e7-498a-a923-e554c9a53d6c'::uuid),
  ('f7c3016b-4081-40d5-bf59-b15926b42f36'::uuid),
  ('f9f56f45-8094-427d-a066-c588ddbcb9b7'::uuid),
  ('fa460c92-e5f7-4fd4-9d36-c6bc05b2a7ea'::uuid),
  ('fb911785-faaf-4852-8d71-aa7c990301fd'::uuid),
  ('fc8f30b5-fcc7-46d8-a525-8bbc080b6dd2'::uuid),
  ('fce5990d-623e-4d11-b3ec-d53da8fc0586'::uuid),
  ('fec09851-a073-43f0-acdc-8247a86917e4'::uuid),
  ('ff1adbbb-490d-4cb4-b212-27593a8f4f08'::uuid),
  ('ff57a3b2-d823-43db-b85a-218011adbf8e'::uuid)
;

-- Capture: the listed lot must still be exactly what was measured.
INSERT INTO public._stranded_closed_auction_drafts_20260930 (lot_id, target_status, row_data)
SELECT l.id,
       CASE WHEN l.intake_bin_id IS NOT NULL THEN 'in_inventory' ELSE 'pending_intake' END,
       to_jsonb(l)
FROM public.lots l
JOIN _0382_ids x ON x.lot_id = l.id
JOIN public.auctions a ON a.id = l.auction_id
WHERE l.status = 'draft'
  AND l.deleted_at IS NULL
  AND l.bid_count = 0
  AND l.winner_bidder_id IS NULL
  AND l.current_bid_id IS NULL
  AND l.relisted_from_lot_id IS NOT NULL
  AND l.warehouse_id IS NOT NULL
  AND a.status IN ('closed', 'canceled')
  AND NOT EXISTS (SELECT 1 FROM public.bids b WHERE b.lot_id = l.id)
  AND NOT EXISTS (SELECT 1 FROM public.invoice_lots il WHERE il.lot_id = l.id)
  AND NOT EXISTS (
    SELECT 1 FROM public.lots s
    WHERE s.id <> l.id AND s.deleted_at IS NULL
      AND s.status IN ('draft', 'scheduled', 'live')
      AND (s.relisted_from_lot_id = l.relisted_from_lot_id
           OR s.relisted_from_lot_id = l.id
           OR s.id = l.relisted_from_lot_id))
FOR UPDATE OF l
ON CONFLICT (lot_id) DO NOTHING;

DO $$
DECLARE n_shelf int; n_noshelf int; n_listed int;
BEGIN
  SELECT count(*) FILTER (WHERE c.target_status = 'in_inventory'),
         count(*) FILTER (WHERE c.target_status = 'pending_intake')
    INTO n_shelf, n_noshelf
  FROM public._stranded_closed_auction_drafts_20260930 c
  JOIN public.lots l ON l.id = c.lot_id
  WHERE l.status = 'draft';
  SELECT count(*) INTO n_listed FROM public.lots l JOIN _0382_ids x ON x.lot_id = l.id;
  IF n_listed = 0 THEN
    RAISE NOTICE '0382: none of the listed lots exist here — nothing to fix, skipping';
  ELSIF n_shelf = 0 AND n_noshelf = 0 AND NOT EXISTS (
          SELECT 1 FROM public.lots l JOIN _0382_ids x ON x.lot_id = l.id WHERE l.status = 'draft') THEN
    RAISE NOTICE '0382: no listed lot is still draft — already applied, skipping';
  ELSIF n_shelf <> 206 OR n_noshelf <> 9 THEN
    RAISE EXCEPTION '0382: captured % shelved + % unshelved, expected 206 + 9 — aborting', n_shelf, n_noshelf;
  END IF;
END $$;

UPDATE public.lots l
SET status     = c.target_status::lot_status,
    auction_id = NULL,
    lot_number = NULL,
    close_at   = NULL,
    intake_at  = CASE WHEN c.target_status = 'in_inventory'
                      THEN COALESCE(l.intake_at, now()) ELSE l.intake_at END,
    updated_at = now()
FROM public._stranded_closed_auction_drafts_20260930 c
WHERE l.id = c.lot_id
  AND l.status = 'draft';

DO $$
DECLARE wrong int; still_draft int;
BEGIN
  SELECT count(*) INTO wrong
  FROM public._stranded_closed_auction_drafts_20260930 c
  JOIN public.lots l ON l.id = c.lot_id
  WHERE l.status::text <> c.target_status OR l.auction_id IS NOT NULL OR l.lot_number IS NOT NULL;
  SELECT count(*) INTO still_draft
  FROM public.lots l JOIN _0382_ids x ON x.lot_id = l.id WHERE l.status = 'draft';
  IF wrong <> 0 OR still_draft <> 0 THEN
    RAISE EXCEPTION '0382: % captured lots not at target, % listed lots still draft — aborting', wrong, still_draft;
  END IF;
END $$;

COMMIT;

-- ── REVERSAL (run by hand only if needed) ────────────────────────────────────
-- Only rows untouched since 0382 are restored; a lot staff have since moved
-- (scheduled, relotted, disposed) is left as it is.
-- BEGIN;
-- UPDATE public.lots l
-- SET status     = (c.row_data->>'status')::lot_status,
--     auction_id = (c.row_data->>'auction_id')::uuid,
--     lot_number = (c.row_data->>'lot_number')::int,
--     close_at   = (c.row_data->>'close_at')::timestamptz,
--     intake_at  = (c.row_data->>'intake_at')::timestamptz,
--     updated_at = now()
-- FROM public._stranded_closed_auction_drafts_20260930 c
-- WHERE l.id = c.lot_id AND l.status::text = c.target_status AND l.auction_id IS NULL;
-- COMMIT;
