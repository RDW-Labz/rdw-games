-- Post-migration: row counts unchanged, defaults correct, CHECKs reject bad
-- values, existing rows untouched, RLS/grants proof.
SELECT 'lots count: ' || count(*) FROM lots;
SELECT 'auctions count: ' || count(*) FROM auctions;
SELECT 'sample lot: ' || id || ' ' || lot_code || ' ' || status || ' unit_qty=' || coalesce(unit_qty::text,'NULL') || ' unit_label=' || coalesce(unit_label,'NULL') FROM lots ORDER BY lot_code;
SELECT 'sample auction: ' || id || ' ' || status || ' bid_mode=' || bid_mode || ' unit_start_cents=' || coalesce(unit_start_cents::text,'NULL') FROM auctions ORDER BY id;
SELECT 'every existing lot unit_qty/unit_label NULL: ' || (count(*) FILTER (WHERE unit_qty IS NOT NULL OR unit_label IS NOT NULL) = 0) FROM lots;
SELECT 'every existing auction bid_mode standard and unit_start_cents NULL: ' || (count(*) FILTER (WHERE bid_mode <> 'standard' OR unit_start_cents IS NOT NULL) = 0) FROM auctions;

-- CHECK: bid_mode
DO $$ BEGIN
  BEGIN
    UPDATE auctions SET bid_mode = 'bogus' WHERE id = '00000000-0000-0000-0000-0000000000f0';
    RAISE NOTICE 'bid_mode bogus: NOT REJECTED (BUG)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'bid_mode bogus: rejected (check_violation)';
  END;
END $$;

-- CHECK: unit_start_cents <= 0
DO $$ BEGIN
  BEGIN
    UPDATE auctions SET unit_start_cents = 0 WHERE id = '00000000-0000-0000-0000-0000000000f0';
    RAISE NOTICE 'unit_start_cents 0: NOT REJECTED (BUG)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'unit_start_cents 0: rejected (check_violation)';
  END;
  BEGIN
    UPDATE auctions SET unit_start_cents = -10 WHERE id = '00000000-0000-0000-0000-0000000000f0';
    RAISE NOTICE 'unit_start_cents -10: NOT REJECTED (BUG)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'unit_start_cents -10: rejected (check_violation)';
  END;
END $$;
-- CHECK: unit_start_cents positive succeeds, then revert
UPDATE auctions SET unit_start_cents = 10 WHERE id = '00000000-0000-0000-0000-0000000000f0';
SELECT 'unit_start_cents 10 accepted: ' || (unit_start_cents = 10) FROM auctions WHERE id = '00000000-0000-0000-0000-0000000000f0';
UPDATE auctions SET unit_start_cents = NULL WHERE id = '00000000-0000-0000-0000-0000000000f0';

-- CHECK: unit_qty <= 0
DO $$ BEGIN
  BEGIN
    UPDATE lots SET unit_qty = 0 WHERE id = '00000000-0000-0000-0000-000000000101';
    RAISE NOTICE 'unit_qty 0: NOT REJECTED (BUG)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'unit_qty 0: rejected (check_violation)';
  END;
  BEGIN
    UPDATE lots SET unit_qty = -5 WHERE id = '00000000-0000-0000-0000-000000000101';
    RAISE NOTICE 'unit_qty -5: NOT REJECTED (BUG)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'unit_qty -5: rejected (check_violation)';
  END;
END $$;

-- CHECK: unit_qty positive and bid_mode per_unit both succeed (the happy path PR1 allows; PR4 is the cross-table lock)
UPDATE lots SET unit_qty = 247, unit_label = 'sq ft' WHERE id = '00000000-0000-0000-0000-000000000101';
SELECT 'unit_qty 247 accepted: ' || (unit_qty = 247 AND unit_label = 'sq ft') FROM lots WHERE id = '00000000-0000-0000-0000-000000000101';
UPDATE auctions SET bid_mode = 'per_unit' WHERE id = '00000000-0000-0000-0000-0000000000f0';
SELECT 'bid_mode per_unit accepted: ' || (bid_mode = 'per_unit') FROM auctions WHERE id = '00000000-0000-0000-0000-0000000000f0';
-- revert so the "existing rows untouched" story stays clean for later re-checks
UPDATE lots SET unit_qty = NULL, unit_label = NULL WHERE id = '00000000-0000-0000-0000-000000000101';
UPDATE auctions SET bid_mode = 'standard' WHERE id = '00000000-0000-0000-0000-0000000000f0';

-- CHECK: unit_label length bounds (empty after trim, and 21 chars)
DO $$ BEGIN
  BEGIN
    UPDATE lots SET unit_label = '   ' WHERE id = '00000000-0000-0000-0000-000000000101';
    RAISE NOTICE 'unit_label blank: NOT REJECTED (BUG)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'unit_label blank: rejected (check_violation)';
  END;
  BEGIN
    UPDATE lots SET unit_label = repeat('x', 21) WHERE id = '00000000-0000-0000-0000-000000000101';
    RAISE NOTICE 'unit_label 21 chars: NOT REJECTED (BUG)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'unit_label 21 chars: rejected (check_violation)';
  END;
END $$;
UPDATE lots SET unit_label = NULL WHERE id = '00000000-0000-0000-0000-000000000101';

-- Grants: table-level SELECT covers the new columns automatically (Supabase default grant simulated below in run.sh)
SELECT 'col privilege lots.unit_qty anon: ' || has_column_privilege('anon','public.lots','unit_qty','SELECT');
SELECT 'col privilege lots.unit_qty authenticated: ' || has_column_privilege('authenticated','public.lots','unit_qty','SELECT');
SELECT 'col privilege auctions.bid_mode anon: ' || has_column_privilege('anon','public.auctions','bid_mode','SELECT');
SELECT 'col privilege auctions.unit_start_cents anon: ' || has_column_privilege('anon','public.auctions','unit_start_cents','SELECT');

-- RLS as a bidder session: SELECT sees the new columns on the published lot, not the draft one; cannot write any column (new or old).
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', false);
SET ROLE authenticated;
SELECT 'bidder sees published lot incl. new cols: ' || (lot_code || '/' || status || '/unit_qty=' || coalesce(unit_qty::text,'NULL')) FROM lots WHERE id = '00000000-0000-0000-0000-000000000101';
SELECT 'bidder sees draft lot (should be 0 rows): ' || count(*) FROM lots WHERE id = '00000000-0000-0000-0000-000000000102';
SELECT 'bidder sees auction incl. bid_mode/unit_start_cents: ' || bid_mode || '/' || coalesce(unit_start_cents::text,'NULL') FROM auctions WHERE id = '00000000-0000-0000-0000-0000000000f0';
-- RLS blocks by filtering rows out of the UPDATE's USING clause (0 rows
-- affected, no exception), not necessarily by raising 42501 — so the real
-- check is rows-affected, confirmed via GET DIAGNOSTICS, not whether an
-- exception fired.
DO $$ DECLARE n int; BEGIN
  BEGIN
    UPDATE lots SET unit_qty = 9 WHERE id = '00000000-0000-0000-0000-000000000101';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RAISE NOTICE 'bidder UPDATE lots.unit_qty: blocked (0 rows matched under RLS)';
    ELSE RAISE NOTICE 'bidder UPDATE lots.unit_qty: NOT BLOCKED (BUG, % rows)', n; END IF;
  EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
    RAISE NOTICE 'bidder UPDATE lots.unit_qty: blocked (%)', SQLSTATE;
  END;
  BEGIN
    UPDATE auctions SET bid_mode = 'per_unit' WHERE id = '00000000-0000-0000-0000-0000000000f0';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RAISE NOTICE 'bidder UPDATE auctions.bid_mode: blocked (0 rows matched under RLS)';
    ELSE RAISE NOTICE 'bidder UPDATE auctions.bid_mode: NOT BLOCKED (BUG, % rows)', n; END IF;
  EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
    RAISE NOTICE 'bidder UPDATE auctions.bid_mode: blocked (%)', SQLSTATE;
  END;
  BEGIN
    UPDATE auctions SET unit_start_cents = 10 WHERE id = '00000000-0000-0000-0000-0000000000f0';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RAISE NOTICE 'bidder UPDATE auctions.unit_start_cents: blocked (0 rows matched under RLS)';
    ELSE RAISE NOTICE 'bidder UPDATE auctions.unit_start_cents: NOT BLOCKED (BUG, % rows)', n; END IF;
  EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
    RAISE NOTICE 'bidder UPDATE auctions.unit_start_cents: blocked (%)', SQLSTATE;
  END;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);

-- RLS as anon (no JWT, no bidders row => is_bidder() is false): the bidder
-- read policy requires is_bidder(), so a bare anon role sees 0 rows here —
-- that is RLS doing its job, not a gap. (The app's public browsing goes
-- through an authenticated session or a server route; out of scope for PR1.)
SET ROLE anon;
SELECT 'anon sees published lot (expect 0, is_bidder() false for anon): ' || count(*) FROM lots WHERE id = '00000000-0000-0000-0000-000000000101';
SELECT 'anon sees draft lot (should be 0 rows): ' || count(*) FROM lots WHERE id = '00000000-0000-0000-0000-000000000102';
DO $$ DECLARE n int; BEGIN
  BEGIN
    UPDATE lots SET unit_qty = 9 WHERE id = '00000000-0000-0000-0000-000000000101';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RAISE NOTICE 'anon UPDATE lots.unit_qty: blocked (0 rows matched under RLS)';
    ELSE RAISE NOTICE 'anon UPDATE lots.unit_qty: NOT BLOCKED (BUG, % rows)', n; END IF;
  EXCEPTION WHEN insufficient_privilege OR OTHERS THEN
    RAISE NOTICE 'anon UPDATE lots.unit_qty: blocked (%)', SQLSTATE;
  END;
END $$;
RESET ROLE;

-- Final: confirm the test writes above left no residue and existing rows are still untouched.
SELECT 'final: every lot unit_qty/unit_label NULL: ' || (count(*) FILTER (WHERE unit_qty IS NOT NULL OR unit_label IS NOT NULL) = 0) FROM lots;
SELECT 'final: every auction bid_mode standard and unit_start_cents NULL: ' || (count(*) FILTER (WHERE bid_mode <> 'standard' OR unit_start_cents IS NOT NULL) = 0) FROM auctions;
