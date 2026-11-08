-- Behavioural test for mig 0517: additive bidder_credits cash/credit buckets.
-- Plain-psql assertions, no pgTAP. Fake ids only. Transaction is ROLLED BACK.
--
-- Pins: existing unique indexes unchanged; one spend row with additive split
-- columns; second spend is 23505; UPDATE/DELETE forbidden; NULL bucket =
-- legacy credit; flag-off insert shape (no new columns) still works; 10000
-- invoice / 3000 credit remainder is 7000; no ledger UPDATE/DELETE in 0517;
-- no FK CASCADE/SET NULL on bidder_credits; a probe CASCADE/SET NULL cannot
-- silently erase rows (23001); rollback refuses cash-bucket, business-owned,
-- and split-spend data that a reason-only guard would allow.
\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION pg_temp.sqlstate(p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $$;

-- Same WHERE clause as scripts/prod-rig/0517_ROLLBACK_bidder_credits_buckets.sql.
-- A reason-only check (pre-fix) returns false for cash-bucket manual grants,
-- business-owned manual grants, and split spends — those keep legacy reasons.
CREATE FUNCTION pg_temp.rollback_0517_would_refuse() RETURNS boolean
LANGUAGE sql AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.bidder_credits
     WHERE reason NOT IN (
       'referral_earn', 'referral_welcome', 'spend', 'spend_reversal',
       'manual', 'loyalty_redeem', 'promo', 'refund_return'
     )
        OR bucket IS NOT NULL
        OR spend_credit_cents IS NOT NULL
        OR spend_cash_cents IS NOT NULL
        OR owner_kind IS DISTINCT FROM 'bidder'
        OR business_id IS NOT NULL
  )
$$;

DO $$
DECLARE
  v_fail text := '';
  v_got  text;
  v_n    int;
  v_credit int;
  v_cash   int;
  v_sum    int;
  v_def    text;
  a uuid := '89300000-0000-4000-8000-00000000000a';
  b uuid := '89300000-0000-4000-8000-00000000000b';
  c uuid := '89300000-0000-4000-8000-00000000000c';
  i1 uuid := '89300000-0000-4000-8000-0000000000a1';
  i2 uuid := '89300000-0000-4000-8000-0000000000a2';
  i3 uuid := '89300000-0000-4000-8000-0000000000a3';
BEGIN
  -- Catalog: no FK path can CASCADE/SET NULL into this ledger (master 0229
  -- created bidder_id / invoice_id / related_bidder_id without REFERENCES;
  -- later migrations did not add FKs).
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.bidder_credits'::regclass AND contype = 'f'
  ) THEN
    v_fail := v_fail || E'\n  bidder_credits has unexpected foreign keys';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'delete_my_account'
       AND p.prosrc ILIKE '%bidder_credits%'
  ) THEN
    v_fail := v_fail || E'\n  delete_my_account must not touch bidder_credits';
  END IF;

  -- Isolated rollback-refusal cases. TRUNCATE bypasses the row trigger;
  -- this transaction rolls back. Pre-fix reason-only guard would NOT refuse
  -- the first three (legacy reasons) and would drop bucket/owner/split columns.
  TRUNCATE public.bidder_credits;
  INSERT INTO bidder_credits (bidder_id, amount_cents, reason, bucket)
  VALUES (a, 2000, 'manual', 'cash');
  IF EXISTS (
    SELECT 1 FROM bidder_credits
     WHERE reason NOT IN (
       'referral_earn', 'referral_welcome', 'spend', 'spend_reversal',
       'manual', 'loyalty_redeem', 'promo', 'refund_return'
     )
  ) THEN
    v_fail := v_fail || E'\n  cash-bucket manual must keep a legacy reason';
  END IF;
  IF NOT pg_temp.rollback_0517_would_refuse() THEN
    v_fail := v_fail || E'\n  rollback must refuse cash-bucket manual grant';
  END IF;

  TRUNCATE public.bidder_credits;
  INSERT INTO bidder_credits (bidder_id, amount_cents, reason, bucket, owner_kind)
  VALUES (a, 400, 'manual', 'credit', 'business');
  IF EXISTS (
    SELECT 1 FROM bidder_credits
     WHERE reason NOT IN (
       'referral_earn', 'referral_welcome', 'spend', 'spend_reversal',
       'manual', 'loyalty_redeem', 'promo', 'refund_return'
     )
  ) THEN
    v_fail := v_fail || E'\n  business-owned manual must keep a legacy reason';
  END IF;
  IF NOT pg_temp.rollback_0517_would_refuse() THEN
    v_fail := v_fail || E'\n  rollback must refuse business-owned grant';
  END IF;

  TRUNCATE public.bidder_credits;
  INSERT INTO bidder_credits
    (bidder_id, amount_cents, reason, invoice_id, spend_credit_cents, spend_cash_cents)
  VALUES (a, -5000, 'spend', i1, 3000, 2000);
  IF EXISTS (
    SELECT 1 FROM bidder_credits
     WHERE reason NOT IN (
       'referral_earn', 'referral_welcome', 'spend', 'spend_reversal',
       'manual', 'loyalty_redeem', 'promo', 'refund_return'
     )
  ) THEN
    v_fail := v_fail || E'\n  split spend must keep a legacy reason';
  END IF;
  IF NOT pg_temp.rollback_0517_would_refuse() THEN
    v_fail := v_fail || E'\n  rollback must refuse split spend columns';
  END IF;

  TRUNCATE public.bidder_credits;
  INSERT INTO bidder_credits (bidder_id, amount_cents, reason)
  VALUES (a, 3000, 'referral_welcome');
  IF pg_temp.rollback_0517_would_refuse() THEN
    v_fail := v_fail || E'\n  rollback must allow a legacy-only ledger';
  END IF;
  TRUNCATE public.bidder_credits;

  SELECT indexdef INTO v_def FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'bidder_credits_one_spend_per_invoice';
  IF v_def IS NULL OR v_def NOT LIKE '%invoice_id%' OR v_def NOT LIKE '%reason%spend%' THEN
    v_fail := v_fail || E'\n  spend unique index missing or rewritten';
  END IF;
  IF v_def LIKE '%bucket%' THEN
    v_fail := v_fail || E'\n  spend unique index must not include bucket';
  END IF;
  SELECT indexdef INTO v_def FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'bidder_credits_one_reversal_per_invoice';
  IF v_def IS NULL OR v_def NOT LIKE '%invoice_id%' OR v_def NOT LIKE '%reason%spend_reversal%' THEN
    v_fail := v_fail || E'\n  reversal unique index missing or rewritten';
  END IF;

  -- Flag-off legacy shape: 3000 credit on a 10000 invoice → card 7000.
  INSERT INTO bidder_credits (bidder_id, amount_cents, reason)
  VALUES (a, 3000, 'referral_welcome');
  v_got := pg_temp.sqlstate(format(
    $sql$INSERT INTO bidder_credits (bidder_id, amount_cents, reason, invoice_id)
         VALUES (%L, -3000, 'spend', %L)$sql$, a, i1));
  IF v_got <> 'ok' THEN v_fail := v_fail || E'\n  legacy spend insert: ' || v_got; END IF;
  SELECT COUNT(*) INTO v_n FROM bidder_credits WHERE invoice_id = i1 AND reason = 'spend';
  IF v_n <> 1 THEN v_fail := v_fail || E'\n  expected one spend row'; END IF;
  IF EXISTS (
    SELECT 1 FROM bidder_credits
     WHERE invoice_id = i1 AND reason = 'spend'
       AND (bucket IS NOT NULL OR spend_credit_cents IS NOT NULL OR spend_cash_cents IS NOT NULL)
  ) THEN
    v_fail := v_fail || E'\n  legacy spend must leave new columns NULL';
  END IF;
  v_got := pg_temp.sqlstate(format(
    $sql$INSERT INTO bidder_credits (bidder_id, amount_cents, reason, invoice_id)
         VALUES (%L, -3000, 'spend', %L)$sql$, a, i1));
  IF v_got <> '23505' THEN v_fail := v_fail || E'\n  second spend: ' || v_got || ' want 23505'; END IF;
  IF 10000 - 3000 <> 7000 THEN v_fail := v_fail || E'\n  10000-3000 remainder'; END IF;

  -- Balance: credit 5000 + cash 2000 + legacy 1000 = credit 6000, cash 2000.
  INSERT INTO bidder_credits (bidder_id, amount_cents, reason, bucket)
  VALUES (b, 5000, 'manual', 'credit');
  INSERT INTO bidder_credits (
    bidder_id, amount_cents, reason, bucket, idempotency_key, square_payment_id
  ) VALUES (b, 2000, 'wallet_load', 'cash', 'wallet_load:sq_pay_synthetic_893', 'sq_pay_synthetic_893');
  v_got := pg_temp.sqlstate(
    $sql$INSERT INTO bidder_credits (bidder_id, amount_cents, reason, bucket, idempotency_key)
         VALUES ('89300000-0000-4000-8000-00000000000f', 1, 'adjustment', 'credit', 'wallet_load:sq_pay_synthetic_893')$sql$);
  IF v_got <> '23505' THEN v_fail := v_fail || E'\n  dup idempotency_key: ' || v_got; END IF;
  v_got := pg_temp.sqlstate(
    $sql$INSERT INTO bidder_credits (bidder_id, amount_cents, reason, bucket, square_payment_id)
         VALUES ('89300000-0000-4000-8000-00000000000f', 1, 'wallet_load', 'cash', 'sq_pay_synthetic_893')$sql$);
  IF v_got <> '23505' THEN v_fail := v_fail || E'\n  dup wallet_load payment: ' || v_got; END IF;
  INSERT INTO bidder_credits (bidder_id, amount_cents, reason)
  VALUES (b, 1000, 'referral_welcome');
  INSERT INTO bidder_credits (bidder_id, amount_cents, reason, bucket, owner_kind)
  VALUES (c, 9999, 'manual', 'credit', 'bidder');
  INSERT INTO bidder_credits (bidder_id, amount_cents, reason, bucket, owner_kind)
  VALUES (b, 400, 'adjustment', 'credit', 'business');
  v_credit := public.bidder_bucket_balance_cents(b, 'credit');
  v_cash := public.bidder_bucket_balance_cents(b, 'cash');
  SELECT COALESCE(SUM(amount_cents), 0) INTO v_sum FROM bidder_credits WHERE bidder_id = b;
  IF v_credit <> 6000 OR v_cash <> 2000 THEN
    v_fail := v_fail || format(E'\n  grants credit=%s cash=%s want 6000/2000', v_credit, v_cash);
  END IF;
  IF v_sum <> 8400 THEN
    v_fail := v_fail || format(E'\n  naive sum=%s includes business 400', v_sum);
  END IF;
  IF public.bidder_bucket_balance_cents(b, 'credit') + public.bidder_bucket_balance_cents(b, 'cash')
     <> (SELECT COALESCE(SUM(amount_cents), 0) FROM bidder_credits WHERE bidder_id = b AND owner_kind IS DISTINCT FROM 'business') THEN
    v_fail := v_fail || E'\n  credit+cash should equal non-business sum';
  END IF;
  IF public.bidder_bucket_balance_cents(c, 'credit') <> 9999 THEN
    v_fail := v_fail || E'\n  cross-owner leak into bidder c';
  END IF;

  INSERT INTO bidder_credits (bidder_id, amount_cents, reason, invoice_id)
  VALUES (b, -3000, 'spend', i2);
  IF public.bidder_bucket_balance_cents(b, 'credit') <> 3000
     OR public.bidder_bucket_balance_cents(b, 'cash') <> 2000 THEN
    v_fail := v_fail || E'\n  legacy spend should drop credit 3000 only';
  END IF;

  v_got := pg_temp.sqlstate(format(
    $sql$INSERT INTO bidder_credits
      (bidder_id, amount_cents, reason, invoice_id, spend_credit_cents, spend_cash_cents)
     VALUES (%L, -5000, 'spend', %L, 3000, 2000)$sql$, b, i3));
  IF v_got <> 'ok' THEN v_fail := v_fail || E'\n  split spend insert: ' || v_got; END IF;
  SELECT COUNT(*) INTO v_n FROM bidder_credits WHERE invoice_id = i3 AND reason = 'spend';
  IF v_n <> 1 THEN v_fail := v_fail || E'\n  split spend must be one row'; END IF;
  IF public.bidder_bucket_balance_cents(b, 'credit') <> 0
     OR public.bidder_bucket_balance_cents(b, 'cash') <> 0 THEN
    v_fail := v_fail || E'\n  split spend should zero both buckets';
  END IF;
  v_got := pg_temp.sqlstate(format(
    $sql$INSERT INTO bidder_credits
      (bidder_id, amount_cents, reason, invoice_id, spend_credit_cents, spend_cash_cents)
     VALUES (%L, -1, 'spend', %L, 1, 0)$sql$, b, i3));
  IF v_got <> '23505' THEN v_fail := v_fail || E'\n  second split spend: ' || v_got; END IF;

  v_got := pg_temp.sqlstate(format(
    $sql$INSERT INTO bidder_credits
      (bidder_id, amount_cents, reason, invoice_id, spend_credit_cents, spend_cash_cents)
     VALUES (%L, 5000, 'spend_reversal', %L, 3000, 2000)$sql$, b, i3));
  IF v_got <> 'ok' THEN v_fail := v_fail || E'\n  split reversal: ' || v_got; END IF;
  v_got := pg_temp.sqlstate(format(
    $sql$INSERT INTO bidder_credits
      (bidder_id, amount_cents, reason, invoice_id, spend_credit_cents, spend_cash_cents)
     VALUES (%L, 5000, 'spend_reversal', %L, 3000, 2000)$sql$, b, i3));
  IF v_got <> '23505' THEN v_fail := v_fail || E'\n  second reversal: ' || v_got; END IF;

  v_got := pg_temp.sqlstate(format(
    $sql$UPDATE bidder_credits SET note = 'nope' WHERE bidder_id = %L$sql$, a));
  IF v_got <> '23001' THEN v_fail := v_fail || E'\n  UPDATE: ' || v_got || ' want 23001'; END IF;
  v_got := pg_temp.sqlstate(format(
    $sql$DELETE FROM bidder_credits WHERE bidder_id = %L$sql$, a));
  IF v_got <> '23001' THEN v_fail := v_fail || E'\n  DELETE: ' || v_got || ' want 23001'; END IF;
  v_got := pg_temp.sqlstate(format(
    $sql$INSERT INTO bidder_credits (bidder_id, amount_cents, reason)
         VALUES (%L, 1, 'manual')$sql$, a));
  IF v_got <> 'ok' THEN v_fail := v_fail || E'\n  INSERT after blocked UPDATE: ' || v_got; END IF;

  v_got := pg_temp.sqlstate(
    $sql$INSERT INTO bidder_credits (bidder_id, amount_cents, reason)
         VALUES ('89300000-0000-4000-8000-00000000000d', 1, 'not_a_reason')$sql$);
  IF v_got <> '23514' THEN v_fail := v_fail || E'\n  unknown reason: ' || v_got; END IF;
  v_got := pg_temp.sqlstate(format(
    $sql$INSERT INTO bidder_credits
      (bidder_id, amount_cents, reason, invoice_id, spend_credit_cents, spend_cash_cents)
     VALUES (%L, -100, 'spend', '89300000-0000-4000-8000-0000000000a4', 30, 20)$sql$, a));
  IF v_got <> '23514' THEN v_fail := v_fail || E'\n  split mismatch: ' || v_got; END IF;
  v_got := pg_temp.sqlstate(format(
    $sql$INSERT INTO bidder_credits
      (bidder_id, amount_cents, reason, bucket, owner_kind)
     VALUES (%L, 100, 'wallet_load', 'cash', 'business')$sql$, a));
  IF v_got <> '23514' THEN v_fail := v_fail || E'\n  business cash: ' || v_got; END IF;
  v_got := pg_temp.sqlstate(
    $sql$INSERT INTO bidder_credits
      (bidder_id, amount_cents, reason, bucket, owner_kind, idempotency_key)
     VALUES ('89300000-0000-4000-8000-00000000000e', 100, 'adjustment', 'credit', 'business', 'adjustment:893-biz')$sql$);
  IF v_got <> 'ok' THEN v_fail := v_fail || E'\n  business credit: ' || v_got; END IF;

  FOREACH v_got IN ARRAY ARRAY[
    'referral_earn','referral_welcome','spend','spend_reversal','manual',
    'loyalty_redeem','promo','refund_return','wallet_load','refund_as_credit',
    'credit_bonus','cash_out','adjustment','boost_cancel_credit'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.bidder_credits'::regclass
         AND conname = 'bidder_credits_reason_check'
         AND pg_get_constraintdef(oid) LIKE '%' || v_got || '%'
    ) THEN
      v_fail := v_fail || E'\n  reason CHECK missing ' || v_got;
    END IF;
  END LOOP;

  -- Probe: a throwaway ON DELETE CASCADE / SET NULL cannot silently erase
  -- or rewrite ledger rows. The append-only trigger raises 23001 and the
  -- parent stays. Production has no such FKs (catalog check above).
  CREATE TABLE public._893_probe_bidders (id uuid PRIMARY KEY);
  INSERT INTO public._893_probe_bidders (id)
    SELECT DISTINCT bidder_id FROM public.bidder_credits;
  ALTER TABLE public.bidder_credits
    ADD CONSTRAINT _893_probe_bidder_fk
    FOREIGN KEY (bidder_id) REFERENCES public._893_probe_bidders(id)
    ON DELETE CASCADE;
  SELECT COUNT(*) INTO v_n FROM bidder_credits WHERE bidder_id = a;
  IF v_n < 1 THEN v_fail := v_fail || E'\n  probe needs credits for bidder a'; END IF;
  v_got := pg_temp.sqlstate(format(
    $sql$DELETE FROM public._893_probe_bidders WHERE id = %L$sql$, a));
  IF v_got <> '23001' THEN
    v_fail := v_fail || E'\n  CASCADE parent delete: ' || v_got || ' want 23001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public._893_probe_bidders WHERE id = a) THEN
    v_fail := v_fail || E'\n  CASCADE parent delete must not succeed';
  END IF;
  IF (SELECT COUNT(*) FROM bidder_credits WHERE bidder_id = a) IS DISTINCT FROM v_n THEN
    v_fail := v_fail || E'\n  CASCADE silently deleted ledger rows';
  END IF;

  CREATE TABLE public._893_probe_invoices (id uuid PRIMARY KEY);
  INSERT INTO public._893_probe_invoices (id)
    SELECT DISTINCT invoice_id FROM public.bidder_credits WHERE invoice_id IS NOT NULL;
  ALTER TABLE public.bidder_credits
    ADD CONSTRAINT _893_probe_inv_fk
    FOREIGN KEY (invoice_id) REFERENCES public._893_probe_invoices(id)
    ON DELETE SET NULL;
  v_got := pg_temp.sqlstate(format(
    $sql$DELETE FROM public._893_probe_invoices WHERE id = %L$sql$, i1));
  IF v_got <> '23001' THEN
    v_fail := v_fail || E'\n  SET NULL parent delete: ' || v_got || ' want 23001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM bidder_credits WHERE invoice_id IS NULL AND reason = 'spend'
  ) THEN
    v_fail := v_fail || E'\n  SET NULL silently rewrote invoice_id';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM bidder_credits WHERE invoice_id = i1 AND reason = 'spend'
  ) THEN
    v_fail := v_fail || E'\n  SET NULL lost spend row for i1';
  END IF;

  ALTER TABLE public.bidder_credits DROP CONSTRAINT IF EXISTS _893_probe_bidder_fk;
  ALTER TABLE public.bidder_credits DROP CONSTRAINT IF EXISTS _893_probe_inv_fk;
  DROP TABLE IF EXISTS public._893_probe_bidders;
  DROP TABLE IF EXISTS public._893_probe_invoices;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'bidder_credits_buckets failures:%', v_fail;
  END IF;
END $$;

ROLLBACK;
