-- Behavioural test for mig 0299's duplicate_lot().
-- Plain-psql assertions, no pgTAP (matches lineage_assign_guard.sql).
--
-- The invariant worth protecting is the RELIST/DUPLICATE distinction:
--
--   relist    = the SAME box listed again -> carries relisted_from_lot_id and
--               inherits the sticker
--   duplicate = a DIFFERENT, identical box -> carries NO lineage and gets its
--               own sticker
--
-- If duplicate_lot ever starts setting relisted_from_lot_id, a case of six
-- identical items becomes six listings of one item to every guard built since
-- 0275 (D1, lots_one_active_relist_child, the 0294 lineage guard). That is the
-- exact duplicate-listing class this codebase spent a month closing, so the
-- no-lineage assertion below is the point of this file.
--
-- Also pins what must NOT be inherited: physical identity (lot_code,
-- sticker_code, qr_token), unit identity (external_code, lpn), bid state, and
-- listing state — while item + product detail and photos DO carry over.
--
-- photo_urls uses hosts on the is_safe_image_url allowlist (mig 0049). With
-- arbitrary hosts the BEFORE-INSERT filter strips them and the photo assertion
-- passes vacuously by comparing two empty arrays.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('d0000000-0000-0000-0000-0000000000f1', 'duptest', 'Dup Test Co',
        'dup@example.com', 'DUP');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('d0000000-0000-0000-0000-0000000000f2', 'd0000000-0000-0000-0000-0000000000f1',
        'DUP WH', '1 Dup St', 'Harrison', 'AR', '72601');

-- duplicate_lot resolves the caller via current_operator_id() / auth.uid().
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('d0000000-0000-0000-0000-0000000000f3', 'dupstaff@example.com');
INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('d0000000-0000-0000-0000-0000000000f1', 'd0000000-0000-0000-0000-0000000000f3',
        'manager', 'dupstaff@example.com');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'd0000000-0000-0000-0000-0000000000f3'::uuid $$;

-- Source: fully populated, stickered, already relisted twice.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title, description,
                  category, condition, msrp_cents, starting_bid_cents, photo_urls,
                  brand, model, upc, source, vendor,
                  sticker_code, external_code, lpn, relist_count)
VALUES ('d0000000-0000-0000-0000-0000000000f4', 'd0000000-0000-0000-0000-0000000000f1',
        'd0000000-0000-0000-0000-0000000000f2', 'DUP-SRC', 'draft',
        'Wedding Arbor', 'Vinyl, 61 in', 'Garden', 'good', 12999, 500,
        ARRAY['https://m.media-amazon.com/images/I/one.jpg',
              'https://i.ebayimg.com/images/g/two.jpg'],
        'Acme', 'X1', '012345678905', 'manifest', 'VendorCo',
        'DUP:STICK-1', 'EXT-1', 'LPN-1', 2);

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_res    JSONB;
  v_new    lots%ROWTYPE;
  v_src    lots%ROWTYPE;
  v_fail   TEXT := '';
BEGIN
  SELECT * INTO v_src FROM lots WHERE id = 'd0000000-0000-0000-0000-0000000000f4';

  v_res := duplicate_lot('d0000000-0000-0000-0000-0000000000f4');
  IF (v_res->>'ok')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'duplicate_lot returned not-ok: %', v_res;
  END IF;

  SELECT * INTO v_new FROM lots WHERE id = (v_res->>'lot_id')::UUID;
  IF v_new.id IS NULL THEN
    RAISE EXCEPTION 'duplicate_lot reported ok but no row at %', v_res->>'lot_id';
  END IF;

  -- THE invariant: a duplicate is a different box, so no lineage.
  IF v_new.relisted_from_lot_id IS NOT NULL THEN
    v_fail := v_fail || E'\n  relisted_from_lot_id set — duplicate must NOT carry relist lineage';
  END IF;
  IF COALESCE(v_new.relist_count, 0) <> 0 THEN
    v_fail := v_fail || E'\n  relist_count not reset';
  END IF;

  -- Physical identity is never inherited.
  IF v_new.lot_code = v_src.lot_code THEN v_fail := v_fail || E'\n  lot_code not fresh'; END IF;
  IF v_new.sticker_code IS NOT NULL THEN v_fail := v_fail || E'\n  sticker_code copied'; END IF;
  IF v_new.qr_token = v_src.qr_token THEN v_fail := v_fail || E'\n  qr_token copied'; END IF;

  -- Unit identity is not inherited (two boxes share a UPC, not a manifest row).
  IF v_new.external_code IS NOT NULL THEN v_fail := v_fail || E'\n  external_code copied'; END IF;
  IF v_new.lpn IS NOT NULL THEN v_fail := v_fail || E'\n  lpn copied'; END IF;

  -- Listing / bid state is fresh.
  -- 0322: the source here has NO shelf (draft, no intake_bin_id/intake_at), so
  -- the duplicate must enter the put-away queue rather than claim a location.
  -- It must NOT be 'draft' — nothing lists draft, which is the bug 0322 fixed.
  IF v_new.status::TEXT <> 'pending_intake' THEN
    v_fail := v_fail || format(E'\n  shelfless source: status is %s, expected pending_intake', v_new.status);
  END IF;
  IF v_new.intake_bin_id IS NOT NULL THEN
    v_fail := v_fail || E'\n  shelfless source: duplicate claimed a bin it is not on';
  END IF;
  IF v_new.intake_at IS NOT NULL THEN
    v_fail := v_fail || E'\n  shelfless source: duplicate claimed an intake time';
  END IF;
  IF v_new.auction_id IS NOT NULL THEN v_fail := v_fail || E'\n  auction_id copied'; END IF;
  IF COALESCE(v_new.bid_count, 0) <> 0 THEN v_fail := v_fail || E'\n  bid_count copied'; END IF;

  -- Item + product detail and photos DO carry over.
  IF v_new.title IS DISTINCT FROM v_src.title THEN v_fail := v_fail || E'\n  title not copied'; END IF;
  IF v_new.description IS DISTINCT FROM v_src.description THEN v_fail := v_fail || E'\n  description not copied'; END IF;
  IF v_new.msrp_cents IS DISTINCT FROM v_src.msrp_cents THEN v_fail := v_fail || E'\n  msrp not copied'; END IF;
  IF v_new.category IS DISTINCT FROM v_src.category THEN v_fail := v_fail || E'\n  category not copied'; END IF;
  IF v_new.condition IS DISTINCT FROM v_src.condition THEN v_fail := v_fail || E'\n  condition not copied'; END IF;
  IF v_new.brand IS DISTINCT FROM v_src.brand OR v_new.upc IS DISTINCT FROM v_src.upc THEN
    v_fail := v_fail || E'\n  product identity (brand/upc) not copied';
  END IF;
  -- Guard against the vacuous-pass case: the source must really have photos.
  IF COALESCE(array_length(v_src.photo_urls, 1), 0) <> 2 THEN
    v_fail := v_fail || E'\n  fixture photos were stripped — allowlist host changed, assertion would be vacuous';
  ELSIF v_new.photo_urls IS DISTINCT FROM v_src.photo_urls THEN
    v_fail := v_fail || E'\n  photos not copied';
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'duplicate_lot assertions failed:%', v_fail;
  END IF;
  RAISE NOTICE 'duplicate_lot: all assertions OK (new lot %)', v_res->>'lot_code';
END $$;

-- Cross-tenant and missing-lot paths return a reason rather than raising.
DO $$
DECLARE v_res JSONB;
BEGIN
  v_res := duplicate_lot('00000000-0000-0000-0000-0000000000ff');
  IF (v_res->>'reason') <> 'lot_not_found' THEN
    RAISE EXCEPTION 'expected lot_not_found for an unknown id, got %', v_res;
  END IF;
  RAISE NOTICE 'duplicate_lot: unknown id -> lot_not_found OK';
END $$;

-- ---------------------------------------------------------------------------
-- 0326: a duplicate of a PUT-AWAY source gets NO shelf.
--
-- 0322 made this branch mint in_inventory on the source's own bin, reasoning
-- that duplicates are stacked with their twin. Reported 2026-08-18: staff put
-- the copies away separately, so the copy arrived claiming shelf A and
-- scanning it onto shelf B returned 'pending_move' for a box that had never
-- been on any shelf.
--
-- What 0322 got right and this still pins: it is not 'draft'. Draft is
-- invisible to the staff worklist (pending_intake | in_inventory | unsold),
-- which is what left duplicates reachable only by searching for them one at a
-- time. pending_intake puts the copy in the put-away queue, where it earns a
-- real shelf by being scanned onto it.
-- ---------------------------------------------------------------------------
INSERT INTO bins (id, warehouse_id, code, aisle, bay, x_px, y_px, qr_token)
VALUES ('d0000000-0000-0000-0000-0000000000b1', 'd0000000-0000-0000-0000-0000000000f2',
        '3-01-04', '3', '01', 0, 0, 'd0000000-0000-0000-0000-0000000000c1');

INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  condition, msrp_cents, starting_bid_cents,
                  intake_bin_id, intake_at)
VALUES ('d0000000-0000-0000-0000-0000000000f9', 'd0000000-0000-0000-0000-0000000000f1',
        'd0000000-0000-0000-0000-0000000000f2', 'DUP-SHELVED', 'in_inventory',
        'Shelved Arbor', 'good', 12999, 500,
        'd0000000-0000-0000-0000-0000000000b1', now() - interval '9 days');

DO $$
DECLARE
  v_res  JSONB;
  v_new  lots%ROWTYPE;
  v_fail TEXT := '';
BEGIN
  v_res := public.duplicate_lot('d0000000-0000-0000-0000-0000000000f9');
  IF NOT (v_res->>'ok')::BOOLEAN THEN
    RAISE EXCEPTION 'duplicate_lot of a shelved source failed: %', v_res;
  END IF;
  SELECT * INTO v_new FROM lots WHERE id = (v_res->>'lot_id')::UUID;

  -- In the put-away queue, not the assignable pool. The one thing it must
  -- never be is 'draft', which no list shows.
  IF v_new.status::TEXT <> 'pending_intake' THEN
    v_fail := v_fail || format(E'\n  status is %s, expected pending_intake', v_new.status);
  END IF;

  -- THE REGRESSION THIS PINS: no inherited shelf. A copy that claims its
  -- source's bin makes putting it away anywhere else read as a move.
  IF v_new.intake_bin_id IS NOT NULL THEN
    v_fail := v_fail || format(E'\n  intake_bin_id is %s, expected NULL', v_new.intake_bin_id);
  END IF;

  IF v_new.intake_at IS NOT NULL THEN
    v_fail := v_fail || format(E'\n  intake_at is %s on a lot that has never been shelved', v_new.intake_at);
  END IF;

  -- The response still reports the branch; on_shelf is now always false.
  IF v_res->>'status' <> 'pending_intake' OR (v_res->>'on_shelf')::BOOLEAN THEN
    v_fail := v_fail || format(E'\n  response did not report the shelfless branch: %s', v_res);
  END IF;

  -- 0299 invariants still hold on this branch: no lineage, no sticker.
  IF v_new.relisted_from_lot_id IS NOT NULL THEN
    v_fail := v_fail || E'\n  duplicate carried relist lineage';
  END IF;
  IF v_new.sticker_code IS NOT NULL THEN
    v_fail := v_fail || E'\n  duplicate inherited the sticker';
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'duplicate_lot shelved-source FAILURES:%', v_fail;
  END IF;
  RAISE NOTICE 'duplicate_lot: shelved source -> pending_intake with no shelf OK';
END $$;

-- ---------------------------------------------------------------------------
-- 0416: a duplicate is credited to a PIN worker, not to nobody.
--
-- Found 2026-10-14: 42 of 108 Crandall lots on Oct 13 had no lotted_by_worker,
-- 40 of them Duplicate Lot copies of a Tim or Lane lot. The app called
-- duplicate_lot with no worker and the function never copied one.
--
-- Pins: an explicit worker wins when it is valid; an invalid one (foreign,
-- inactive) or none falls back to the SOURCE's worker; the 1-arg call that old
-- app builds make still resolves (no ambiguous overload) and inherits; a
-- duplicate never fails over attribution.
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('d0000000-0000-0000-0000-0000000000a1', 'duptest2', 'Other Dup Co',
        'dup2@example.com', 'DU2');

INSERT INTO workers (id, operator_id, display_name, pin_hash, role, is_active)
VALUES
  ('d0000000-0000-0000-0000-0000000000e1', 'd0000000-0000-0000-0000-0000000000f1',
   'Tim', 'x', 'picker', true),
  ('d0000000-0000-0000-0000-0000000000e2', 'd0000000-0000-0000-0000-0000000000f1',
   'Lane', 'x', 'picker', true),
  ('d0000000-0000-0000-0000-0000000000e3', 'd0000000-0000-0000-0000-0000000000f1',
   'Retired Rita', 'x', 'picker', false),
  ('d0000000-0000-0000-0000-0000000000e4', 'd0000000-0000-0000-0000-0000000000a1',
   'Foreign Fay', 'x', 'picker', true);

-- Source lotted by Tim.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  condition, msrp_cents, starting_bid_cents, lotted_by_worker)
VALUES ('d0000000-0000-0000-0000-0000000000d1', 'd0000000-0000-0000-0000-0000000000f1',
        'd0000000-0000-0000-0000-0000000000f2', 'DUP-TIM', 'pending_intake',
        'Tim Arbor', 'good', 12999, 500, 'd0000000-0000-0000-0000-0000000000e1');

DO $$
DECLARE
  c_src   CONSTANT UUID := 'd0000000-0000-0000-0000-0000000000d1';
  c_bare  CONSTANT UUID := 'd0000000-0000-0000-0000-0000000000f4';  -- no worker
  c_tim   CONSTANT UUID := 'd0000000-0000-0000-0000-0000000000e1';
  c_lane  CONSTANT UUID := 'd0000000-0000-0000-0000-0000000000e2';
  c_rita  CONSTANT UUID := 'd0000000-0000-0000-0000-0000000000e3';
  c_fay   CONSTANT UUID := 'd0000000-0000-0000-0000-0000000000e4';
  v_res   JSONB;
  v_w     UUID;
  v_by    UUID;
  v_n     INT;
  v_fail  TEXT := '';
BEGIN
  -- Exactly one duplicate_lot, so a 1-arg call cannot be ambiguous (42725).
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'duplicate_lot';
  IF v_n <> 1 THEN
    v_fail := v_fail || format(E'\n  %s duplicate_lot functions, expected 1', v_n);
  END IF;

  -- 1. Old app build: positional 1-arg call -> inherits the source's worker.
  v_res := public.duplicate_lot(c_src);
  SELECT lotted_by_worker, lotted_by INTO v_w, v_by FROM lots WHERE id = (v_res->>'lot_id')::UUID;
  IF v_w IS DISTINCT FROM c_tim THEN
    v_fail := v_fail || format(E'\n  1-arg call: worker %s, expected source''s (Tim)', v_w);
  END IF;
  IF v_by IS DISTINCT FROM 'd0000000-0000-0000-0000-0000000000f3'::UUID THEN
    v_fail := v_fail || E'\n  lotted_by is no longer the caller login';
  END IF;

  -- 2. PostgREST shape: named p_lot_id only -> same.
  v_res := public.duplicate_lot(p_lot_id => c_src);
  SELECT lotted_by_worker INTO v_w FROM lots WHERE id = (v_res->>'lot_id')::UUID;
  IF v_w IS DISTINCT FROM c_tim THEN
    v_fail := v_fail || format(E'\n  named 1-arg call: worker %s, expected Tim', v_w);
  END IF;

  -- 3. New app build: Lane duplicates Tim's lot -> Lane.
  v_res := public.duplicate_lot(p_lot_id => c_src, p_lotted_by_worker => c_lane);
  SELECT lotted_by_worker INTO v_w FROM lots WHERE id = (v_res->>'lot_id')::UUID;
  IF v_w IS DISTINCT FROM c_lane THEN
    v_fail := v_fail || format(E'\n  explicit worker: %s, expected Lane', v_w);
  END IF;

  -- 4. Another operator's worker is not trusted -> falls back to the source.
  v_res := public.duplicate_lot(c_src, c_fay);
  IF (v_res->>'ok')::BOOLEAN IS NOT TRUE THEN
    v_fail := v_fail || format(E'\n  foreign worker blocked the duplicate: %s', v_res);
  ELSE
    SELECT lotted_by_worker INTO v_w FROM lots WHERE id = (v_res->>'lot_id')::UUID;
    IF v_w IS DISTINCT FROM c_tim THEN
      v_fail := v_fail || format(E'\n  foreign worker: %s, expected fallback to Tim', v_w);
    END IF;
  END IF;

  -- 5. Inactive worker -> falls back to the source.
  v_res := public.duplicate_lot(c_src, c_rita);
  SELECT lotted_by_worker INTO v_w FROM lots WHERE id = (v_res->>'lot_id')::UUID;
  IF v_w IS DISTINCT FROM c_tim THEN
    v_fail := v_fail || format(E'\n  inactive worker: %s, expected fallback to Tim', v_w);
  END IF;

  -- 6. Unattributed source, no worker passed -> still duplicates, NULL.
  v_res := public.duplicate_lot(c_bare);
  IF (v_res->>'ok')::BOOLEAN IS NOT TRUE THEN
    v_fail := v_fail || format(E'\n  unattributed source failed: %s', v_res);
  ELSE
    SELECT lotted_by_worker INTO v_w FROM lots WHERE id = (v_res->>'lot_id')::UUID;
    IF v_w IS NOT NULL THEN
      v_fail := v_fail || format(E'\n  unattributed source: worker %s invented', v_w);
    END IF;
  END IF;

  -- 7. Unattributed source, worker passed -> that worker.
  v_res := public.duplicate_lot(c_bare, c_lane);
  SELECT lotted_by_worker INTO v_w FROM lots WHERE id = (v_res->>'lot_id')::UUID;
  IF v_w IS DISTINCT FROM c_lane THEN
    v_fail := v_fail || format(E'\n  unattributed source + Lane: %s, expected Lane', v_w);
  END IF;

  -- The source itself is never re-attributed.
  SELECT lotted_by_worker INTO v_w FROM lots WHERE id = c_src;
  IF v_w IS DISTINCT FROM c_tim THEN
    v_fail := v_fail || E'\n  source lot''s worker changed';
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'duplicate_lot worker attribution FAILURES:%', v_fail;
  END IF;
  RAISE NOTICE 'duplicate_lot: worker attribution (explicit / inherited / validated) OK';
END $$;

-- authenticated can still call both arities (grants survived DROP + CREATE).
DO $$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.duplicate_lot(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost EXECUTE on duplicate_lot';
  END IF;
  IF has_function_privilege('anon', 'public.duplicate_lot(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can EXECUTE duplicate_lot — PUBLIC grant not revoked';
  END IF;
  RAISE NOTICE 'duplicate_lot: grants OK';
END $$;

ROLLBACK;
