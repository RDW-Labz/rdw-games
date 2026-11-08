-- Behavioural test for mig 0389: refund_claims / claim_refund / release_refund.
-- Plain-psql assertions, no pgTAP.
--
-- The double-click: two requests for the same refund shape on one invoice,
-- the second arriving while the first is still in flight.
--   1. First claim → true.
--   2. Same key, inside the window, not released → false (the double-click).
--   3. A different key on the same invoice → true (a different refund).
--   4. After release → true again (a deliberate second refund of a new shape
--      still goes through its own line/ledger checks; this only guards
--      concurrency).
--   5. An unreleased claim older than the window → true (a crashed request
--      cannot wedge the invoice).
--   6. NULL / empty key → false, never an error.
--   7. Release is idempotent.
--
-- Fake data only. Runs inside a transaction that is ROLLED BACK.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('e1000000-0000-0000-0000-000000000001', 'claimtest', 'Claim Test Co', 'claim@example.test', 'CLM');
INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('e1000000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000001', 'CLM WH', '1 Claim St', 'Harrison', 'AR', '72601');
INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at, pickup_starts_at, pickup_ends_at)
VALUES ('e1000000-0000-0000-0000-000000000003', 'e1000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000002',
        'CLM sale', 'closed', now() - interval '2 days', now() - interval '1 day', now(), now() + interval '2 days');
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email) VALUES ('e1000000-0000-0000-0000-000000000004', 'claimbidder@example.test') ON CONFLICT DO NOTHING;
INSERT INTO bidders (id, email, birth_date) VALUES ('e1000000-0000-0000-0000-000000000004', 'claimbidder@example.test', DATE '1990-01-01') ON CONFLICT DO NOTHING;
INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, subtotal_cents, total_cents)
VALUES ('e1000000-0000-0000-0000-000000000005', 'e1000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000003',
        'e1000000-0000-0000-0000-000000000004', 'paid', 10014, 10014);

DO $$
DECLARE
  v_inv  uuid := 'e1000000-0000-0000-0000-000000000005';
  v_fail text := '';
  v      boolean;
BEGIN
  -- 1. first claim
  v := public.claim_refund(v_inv, 'items:abc', 60, NULL);
  IF v IS NOT TRUE THEN v_fail := v_fail || E'\n  [1] first claim refused'; END IF;

  -- 2. the double-click: same key, in flight
  v := public.claim_refund(v_inv, 'items:abc', 60, NULL);
  IF v IS NOT FALSE THEN v_fail := v_fail || E'\n  [2] second identical claim was allowed while the first is in flight'; END IF;

  -- 3. a different refund shape on the same invoice is not blocked
  v := public.claim_refund(v_inv, 'items:def', 60, NULL);
  IF v IS NOT TRUE THEN v_fail := v_fail || E'\n  [3] a different key was refused'; END IF;

  -- 4. released → claimable again
  PERFORM public.release_refund(v_inv, 'items:abc');
  v := public.claim_refund(v_inv, 'items:abc', 60, NULL);
  IF v IS NOT TRUE THEN v_fail := v_fail || E'\n  [4] claim refused after release'; END IF;

  -- 5. a stale unreleased claim expires with the window
  UPDATE refund_claims SET claimed_at = now() - interval '61 seconds', released_at = NULL
   WHERE invoice_id = v_inv AND claim_key = 'items:abc';
  v := public.claim_refund(v_inv, 'items:abc', 60, NULL);
  IF v IS NOT TRUE THEN v_fail := v_fail || E'\n  [5] stale claim did not expire'; END IF;
  -- and a fresh one inside the window still blocks
  v := public.claim_refund(v_inv, 'items:abc', 60, NULL);
  IF v IS NOT FALSE THEN v_fail := v_fail || E'\n  [5b] fresh claim did not block'; END IF;

  -- 6. bad input is a refusal, not an error
  v := public.claim_refund(v_inv, NULL, 60, NULL);
  IF v IS NOT FALSE THEN v_fail := v_fail || E'\n  [6] NULL key was accepted'; END IF;
  v := public.claim_refund(v_inv, '', 60, NULL);
  IF v IS NOT FALSE THEN v_fail := v_fail || E'\n  [6] empty key was accepted'; END IF;

  -- 7. release is idempotent
  PERFORM public.release_refund(v_inv, 'items:abc');
  PERFORM public.release_refund(v_inv, 'items:abc');
  PERFORM public.release_refund(v_inv, 'never-claimed');

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'refund_claims failures:%', v_fail;
  END IF;
  RAISE NOTICE 'refund_claims: all assertions passed';
END $$;

ROLLBACK;
