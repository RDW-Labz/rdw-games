-- Behavioural test for mig 0300's clear_sticker_code().
-- Plain-psql assertions, no pgTAP (matches lineage_assign_guard.sql).
--
-- The assertion that matters is the pool-release SCOPE. Clearing a lot's
-- sticker releases its lot_sticker_pool claim so the physical sticker can be
-- claimed by the lot it actually belongs to -- but the release is keyed on
-- claimed_by_lot_id = this lot. If that scoping were ever dropped (say, keyed on
-- sticker_code alone), clearing one lot could free a sticker another lot
-- legitimately holds, and two lots would end up fighting over one physical
-- label. So the fixture deliberately has a SECOND lot holding its own sticker
-- and asserts that claim survives untouched.
--
-- Also pins: the floor-recovery status gate (a live lot is refused rather than
-- silently edited), idempotency on a lot with nothing bound, and the audit row.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('e0000000-0000-0000-0000-0000000000a1', 'clrtest', 'Clear Test Co',
        'clr@example.com', 'CLR');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('e0000000-0000-0000-0000-0000000000a2', 'e0000000-0000-0000-0000-0000000000a1',
        'CLR WH', '1 Clr St', 'Harrison', 'AR', '72601');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('e0000000-0000-0000-0000-0000000000a3', 'clr@example.com');
INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('e0000000-0000-0000-0000-0000000000a1', 'e0000000-0000-0000-0000-0000000000a3',
        'manager', 'clr@example.com');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'e0000000-0000-0000-0000-0000000000a3'::uuid $$;

-- A holds the wrong sticker; B legitimately holds its own; LIVE is out of scope.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title, sticker_code)
VALUES ('e0000000-0000-0000-0000-0000000000a4', 'e0000000-0000-0000-0000-0000000000a1',
        'e0000000-0000-0000-0000-0000000000a2', 'CLR-A', 'draft', 'A', 'CLR:S-1'),
       ('e0000000-0000-0000-0000-0000000000a5', 'e0000000-0000-0000-0000-0000000000a1',
        'e0000000-0000-0000-0000-0000000000a2', 'CLR-B', 'draft', 'B', 'CLR:S-2'),
       ('e0000000-0000-0000-0000-0000000000a6', 'e0000000-0000-0000-0000-0000000000a1',
        'e0000000-0000-0000-0000-0000000000a2', 'CLR-LIVE', 'live', 'L', 'CLR:S-3');

INSERT INTO lot_sticker_pool (qr_token, operator_id, printed_batch_id, printed_at,
                              sticker_code, claimed_at, claimed_by_lot_id)
VALUES (gen_random_uuid(), 'e0000000-0000-0000-0000-0000000000a1', gen_random_uuid(), now(),
        'CLR:S-1', now(), 'e0000000-0000-0000-0000-0000000000a4'),
       (gen_random_uuid(), 'e0000000-0000-0000-0000-0000000000a1', gen_random_uuid(), now(),
        'CLR:S-2', now(), 'e0000000-0000-0000-0000-0000000000a5');

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_res  JSONB;
  v_fail TEXT := '';
BEGIN
  v_res := clear_sticker_code('e0000000-0000-0000-0000-0000000000a4');
  IF (v_res->>'ok')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'clear_sticker_code returned not-ok: %', v_res;
  END IF;
  IF (v_res->>'previous_sticker_code') <> 'CLR:S-1' THEN
    v_fail := v_fail || E'\n  previous_sticker_code not reported';
  END IF;

  IF (SELECT sticker_code FROM lots WHERE id = 'e0000000-0000-0000-0000-0000000000a4') IS NOT NULL THEN
    v_fail := v_fail || E'\n  sticker_code not cleared on the target lot';
  END IF;

  -- The other lot must be completely untouched, row and pool claim alike.
  IF (SELECT sticker_code FROM lots WHERE id = 'e0000000-0000-0000-0000-0000000000a5') <> 'CLR:S-2' THEN
    v_fail := v_fail || E'\n  a DIFFERENT lot lost its sticker';
  END IF;
  IF (SELECT claimed_by_lot_id FROM lot_sticker_pool WHERE sticker_code = 'CLR:S-2') IS NULL THEN
    v_fail := v_fail || E'\n  released another lot''s pool claim — release is not scoped to this lot';
  END IF;

  -- This lot's own pool row must be freed for re-claim.
  IF (SELECT claimed_by_lot_id FROM lot_sticker_pool WHERE sticker_code = 'CLR:S-1') IS NOT NULL THEN
    v_fail := v_fail || E'\n  pool row still claimed — sticker would be permanently unusable';
  END IF;
  IF (SELECT claimed_at FROM lot_sticker_pool WHERE sticker_code = 'CLR:S-1') IS NOT NULL THEN
    v_fail := v_fail || E'\n  pool claimed_at not cleared';
  END IF;

  -- Second call is a no-op success, so a double-tap cannot error.
  IF (clear_sticker_code('e0000000-0000-0000-0000-0000000000a4')->>'idempotent') <> 'true' THEN
    v_fail := v_fail || E'\n  second clear was not idempotent';
  END IF;

  -- Out of floor-recovery scope.
  IF (clear_sticker_code('e0000000-0000-0000-0000-0000000000a6')->>'reason') <> 'lot_not_editable' THEN
    v_fail := v_fail || E'\n  a LIVE lot was not refused';
  END IF;
  IF (SELECT sticker_code FROM lots WHERE id = 'e0000000-0000-0000-0000-0000000000a6') IS NULL THEN
    v_fail := v_fail || E'\n  refused call still mutated the live lot';
  END IF;

  IF (SELECT count(*) FROM operator_audit_log WHERE action_type = 'lot_sticker_cleared') <> 1 THEN
    v_fail := v_fail || E'\n  expected exactly one lot_sticker_cleared audit row';
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'clear_sticker_code assertions failed:%', v_fail;
  END IF;
  RAISE NOTICE 'clear_sticker_code: all assertions OK';
END $$;

ROLLBACK;
