-- Behavioural test for mig 0321: PIN-worker attribution on both lot-create
-- paths. Plain-psql assertions, no pgTAP (matches duplicate_lot.sql).
--
-- WHAT MOTIVATED IT (measured on prod, 7 days to 2026-08-14):
--
--   created via                          lots   with worker    pct
--   relist_lot_into_auction ............ 1,095            0    0.0%
--   create_draft_lot ................... 1,191          736   61.8%
--
-- Relists — 48% of lot volume — were never attributed at all, and fresh lots
-- were attributed by a fire-and-forget client UPDATE that swallowed failures.
--
-- 0321 adds an OVERLOAD to each function rather than rewriting them, so the
-- single highest-risk thing to pin is that overload resolution actually works:
-- existing arities must keep hitting the untouched implementations, and the new
-- arities must attribute. A silent mis-resolution would either break lotting on
-- the warehouse floor or quietly keep attributing nothing.
--
-- Cases:
--   1. create_draft_lot/23 with a valid active worker → attributed.
--   2. create_draft_lot/22 (operator-web, scripts, tests) → still mints, NULL.
--   3. create_draft_lot/23 with ANOTHER operator's worker → lot still created,
--      attribution NULL. Validation must not be bypassable and must not raise.
--   4. create_draft_lot/23 with an INACTIVE worker → same.
--   5. relist_lot_into_auction/3 → child attributed.
--   6. relist_lot_into_auction/2 → still relists, child NULL.
--   7. First-writer-wins: an idempotent re-call (same client token) by a
--      DIFFERENT worker must not steal an existing attribution.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that
-- is ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('c1000000-0000-0000-0000-000000000001', 'workerattr', 'Worker Attr Test Co',
        'attr@example.com', 'WAT');

-- A SECOND operator, to prove a foreign worker id cannot be attributed.
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('c1000000-0000-0000-0000-0000000000a1', 'workerattr2', 'Other Co',
        'other@example.com', 'WA2');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('c1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001',
        'WAT WH', '1 Attr St', 'Harrison', 'AR', '72601');

INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                      starts_at, ends_at, pickup_starts_at, pickup_ends_at)
VALUES ('c1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000001',
        'c1000000-0000-0000-0000-000000000002', 'WAT target', 'draft',
        now(), now() + interval '2 days',
        now() + interval '3 days', now() + interval '4 days');

-- create_draft_lot resolves the caller via current_operator_id() / auth.uid().
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('c1000000-0000-0000-0000-000000000004', 'attrstaff@example.com');
INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('c1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000004',
        'manager', 'attrstaff@example.com');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'c1000000-0000-0000-0000-000000000004'::uuid $$;

-- Workers: one active, one inactive, one belonging to the OTHER operator.
INSERT INTO workers (id, operator_id, display_name, pin_hash, role, is_active)
VALUES
  ('c1000000-0000-0000-0000-000000000010', 'c1000000-0000-0000-0000-000000000001',
   'Cheyenne', 'x', 'picker', true),
  ('c1000000-0000-0000-0000-000000000011', 'c1000000-0000-0000-0000-000000000001',
   'Tammy', 'x', 'picker', true),
  ('c1000000-0000-0000-0000-000000000012', 'c1000000-0000-0000-0000-000000000001',
   'Retired Rick', 'x', 'picker', false),
  ('c1000000-0000-0000-0000-0000000000a2', 'c1000000-0000-0000-0000-0000000000a1',
   'Foreign Fran', 'x', 'picker', true);

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_id     UUID;
  v_code   TEXT;
  v_worker UUID;
  v_child  UUID;
  v_tok    UUID := 'c1000000-0000-0000-0000-0000000000f0';
  v_fail   TEXT := '';
BEGIN
  -- ── 1. create_draft_lot/23, valid active worker → attributed ──────────────
  SELECT out_id, out_lot_code INTO v_id, v_code
    FROM public.create_draft_lot(
      'c1000000-0000-0000-0000-000000000001', 'Attributed lot', NULL, NULL, NULL,
      'good'::lot_condition, 1000, 100, NULL, NULL, 'test',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL,
      'c1000000-0000-0000-0000-000000000010'
    );
  SELECT lotted_by_worker INTO v_worker FROM lots WHERE id = v_id;
  IF v_worker IS DISTINCT FROM 'c1000000-0000-0000-0000-000000000010'::uuid THEN
    v_fail := v_fail || format(E'\n  [1] create_draft_lot/23 did not attribute: got %s', v_worker);
  END IF;

  -- ── 2. create_draft_lot/22 still works and leaves NULL ────────────────────
  SELECT out_id INTO v_id
    FROM public.create_draft_lot(
      'c1000000-0000-0000-0000-000000000001', 'Legacy arity lot', NULL, NULL, NULL,
      'good'::lot_condition, 1000, 100, NULL, NULL, 'test'
    );
  IF v_id IS NULL THEN
    v_fail := v_fail || E'\n  [2] create_draft_lot/22 returned NULL — overload broke existing callers';
  ELSE
    SELECT lotted_by_worker INTO v_worker FROM lots WHERE id = v_id;
    IF v_worker IS NOT NULL THEN
      v_fail := v_fail || format(E'\n  [2] create_draft_lot/22 attributed unexpectedly: %s', v_worker);
    END IF;
  END IF;

  -- ── 3. foreign operator's worker → created, NOT attributed, no raise ──────
  SELECT out_id INTO v_id
    FROM public.create_draft_lot(
      'c1000000-0000-0000-0000-000000000001', 'Foreign worker lot', NULL, NULL, NULL,
      'good'::lot_condition, 1000, 100, NULL, NULL, 'test',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL,
      'c1000000-0000-0000-0000-0000000000a2'
    );
  IF v_id IS NULL THEN
    v_fail := v_fail || E'\n  [3] a foreign worker id blocked the lot create — attribution must never block lotting';
  ELSE
    SELECT lotted_by_worker INTO v_worker FROM lots WHERE id = v_id;
    IF v_worker IS NOT NULL THEN
      v_fail := v_fail || format(E'\n  [3] cross-operator attribution leaked: %s', v_worker);
    END IF;
  END IF;

  -- ── 4. inactive worker → created, NOT attributed ──────────────────────────
  SELECT out_id INTO v_id
    FROM public.create_draft_lot(
      'c1000000-0000-0000-0000-000000000001', 'Inactive worker lot', NULL, NULL, NULL,
      'good'::lot_condition, 1000, 100, NULL, NULL, 'test',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL,
      'c1000000-0000-0000-0000-000000000012'
    );
  IF v_id IS NULL THEN
    v_fail := v_fail || E'\n  [4] an inactive worker id blocked the lot create';
  ELSE
    SELECT lotted_by_worker INTO v_worker FROM lots WHERE id = v_id;
    IF v_worker IS NOT NULL THEN
      v_fail := v_fail || format(E'\n  [4] inactive worker was attributed: %s', v_worker);
    END IF;
  END IF;

  -- ── 5. relist/3 attributes the CHILD ──────────────────────────────────────
  -- Source must be relistable: unsold / in_inventory / relisted (0097).
  SELECT out_id INTO v_id
    FROM public.create_draft_lot(
      'c1000000-0000-0000-0000-000000000001', 'Relist source', NULL, NULL, NULL,
      'good'::lot_condition, 1000, 100, NULL, NULL, 'test'
    );
  UPDATE lots
     SET status = 'unsold', warehouse_id = 'c1000000-0000-0000-0000-000000000002'
   WHERE id = v_id;

  v_child := public.relist_lot_into_auction(
    v_id, 'c1000000-0000-0000-0000-000000000003',
    'c1000000-0000-0000-0000-000000000011'
  );
  IF v_child IS NULL THEN
    v_fail := v_fail || E'\n  [5] relist/3 returned NULL';
  ELSE
    SELECT lotted_by_worker INTO v_worker FROM lots WHERE id = v_child;
    IF v_worker IS DISTINCT FROM 'c1000000-0000-0000-0000-000000000011'::uuid THEN
      v_fail := v_fail || format(E'\n  [5] relist/3 did not attribute the child: got %s', v_worker);
    END IF;
  END IF;

  -- ── 6. relist/2 still works, child NULL ───────────────────────────────────
  SELECT out_id INTO v_id
    FROM public.create_draft_lot(
      'c1000000-0000-0000-0000-000000000001', 'Relist source 2', NULL, NULL, NULL,
      'good'::lot_condition, 1000, 100, NULL, NULL, 'test'
    );
  UPDATE lots
     SET status = 'unsold', warehouse_id = 'c1000000-0000-0000-0000-000000000002'
   WHERE id = v_id;

  v_child := public.relist_lot_into_auction(v_id, 'c1000000-0000-0000-0000-000000000003');
  IF v_child IS NULL THEN
    v_fail := v_fail || E'\n  [6] relist/2 returned NULL — overload broke existing callers';
  ELSE
    SELECT lotted_by_worker INTO v_worker FROM lots WHERE id = v_child;
    IF v_worker IS NOT NULL THEN
      v_fail := v_fail || format(E'\n  [6] relist/2 attributed unexpectedly: %s', v_worker);
    END IF;
  END IF;

  -- ── 7. first-writer-wins on the idempotent path ───────────────────────────
  -- Same client token, second call by a DIFFERENT worker. 0272 short-circuits
  -- to the existing lot; the original attribution must survive.
  SELECT out_id INTO v_id
    FROM public.create_draft_lot(
      'c1000000-0000-0000-0000-000000000001', 'Token lot', NULL, NULL, NULL,
      'good'::lot_condition, 1000, 100, NULL, NULL, 'test',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, v_tok,
      'c1000000-0000-0000-0000-000000000010'
    );
  PERFORM public.create_draft_lot(
      'c1000000-0000-0000-0000-000000000001', 'Token lot', NULL, NULL, NULL,
      'good'::lot_condition, 1000, 100, NULL, NULL, 'test',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, v_tok,
      'c1000000-0000-0000-0000-000000000011'
    );
  SELECT lotted_by_worker INTO v_worker FROM lots WHERE id = v_id;
  IF v_worker IS DISTINCT FROM 'c1000000-0000-0000-0000-000000000010'::uuid THEN
    v_fail := v_fail || format(
      E'\n  [7] idempotent re-call stole the attribution: expected Cheyenne, got %s', v_worker);
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'lot_worker_attribution FAILURES:%', v_fail;
  END IF;

  RAISE NOTICE 'lot_worker_attribution: all 7 cases passed';
END;
$$;

ROLLBACK;
