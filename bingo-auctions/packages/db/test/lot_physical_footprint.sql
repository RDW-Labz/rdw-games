-- Run against fixtures/physical-footprint-schema.sql + migration0369 ONLY.
-- Entire fixture transaction rolls back. No production use. This isolates the
-- evidence contract, including otherwise-FK-impossible corruption cases.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF to_regclass('public.physical_footprint_fixture_marker') IS NULL THEN
    RAISE EXCEPTION 'refusing physical-footprint tests outside isolated fixture';
  END IF;
END $$;
CREATE FUNCTION pg_temp.expect_error(p_sql text, p_fragment text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_failed boolean := false;
BEGIN
  BEGIN EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF position(p_fragment IN SQLERRM) = 0 THEN RAISE; END IF;
    v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'expected refusal containing: %', p_fragment; END IF;
END $$;
CREATE FUNCTION pg_temp.expect_reason(p_id uuid, p_reason text, p_contributor uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.lot_physical_footprint(p_id) AS f
      WHERE f.reason = p_reason AND f.lot_id = coalesce(p_contributor, p_id)) THEN
    RAISE EXCEPTION 'missing expected reason %', p_reason;
  END IF;
  IF NOT public.lot_has_physical_footprint(p_id) THEN RAISE EXCEPTION 'boolean lost evidence'; END IF;
END $$;

-- Same financial shape as0366: 347 lots, no auction/winner/bids. One physical
-- footprint must stop the ENTIRE update, including the 346 unmarked rows.
CREATE TEMP TABLE captured AS SELECT md5('physical-batch-' || n)::uuid AS id FROM generate_series(1,347) AS g(n);
INSERT INTO public.lots(id,operator_id) SELECT id,'00000000-0000-0000-0000-000000000001' FROM captured;
UPDATE public.lots SET sticker_code = 'fixture-only-label' WHERE id = md5('physical-batch-1')::uuid;
DO $$ DECLARE v_refused boolean := false; v_ids uuid[]; BEGIN
  SELECT array_agg(id) INTO v_ids FROM captured;
  IF (SELECT count(*) FROM public.lots WHERE id = ANY(v_ids) AND auction_id IS NULL AND winner_bidder_id IS NULL AND bid_count = 0) <> 347 THEN
    RAISE EXCEPTION '0366-shaped fixture changed';
  END IF;
  BEGIN
    PERFORM public.assert_no_physical_footprint(v_ids);
    UPDATE public.lots SET deleted_at = now() WHERE id = ANY(v_ids);
  EXCEPTION WHEN raise_exception THEN
    IF position('physical evidence exists' IN SQLERRM) = 0 THEN RAISE; END IF;
    v_refused := true;
  END;
  IF NOT v_refused OR EXISTS (SELECT 1 FROM public.lots WHERE id = ANY(v_ids) AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'whole-batch protection failed: original cleanup would hide physical inventory';
  END IF;
END $$;
SELECT pg_temp.expect_reason(md5('physical-batch-1')::uuid,'sticker_code');
UPDATE public.lots SET sticker_code = '' WHERE id = md5('physical-batch-1')::uuid;
SELECT pg_temp.expect_reason(md5('physical-batch-1')::uuid,'sticker_code');

-- Every independent source, even when current bindings have been cleared.
UPDATE public.lots SET intake_bin_id='00000000-0000-0000-0000-000000000099' WHERE id=md5('physical-batch-2')::uuid;
SELECT pg_temp.expect_reason(md5('physical-batch-2')::uuid,'intake_bin_id');
UPDATE public.lots SET intake_at=now() WHERE id=md5('physical-batch-3')::uuid;
SELECT pg_temp.expect_reason(md5('physical-batch-3')::uuid,'intake_at');
INSERT INTO public.bin_assignments(lot_id,bin_id) VALUES(md5('physical-batch-4')::uuid,'00000000-0000-0000-0000-000000000099');
SELECT pg_temp.expect_reason(md5('physical-batch-4')::uuid,'bin_assignments');
UPDATE public.lots SET intake_bin_id='00000000-0000-0000-0000-000000000099' WHERE id=md5('physical-batch-5')::uuid;
INSERT INTO public.lot_location_events(lot_id,bin_id) VALUES(md5('physical-batch-5')::uuid,NULL);
UPDATE public.lots SET intake_bin_id=NULL WHERE id=md5('physical-batch-5')::uuid;
SELECT pg_temp.expect_reason(md5('physical-batch-5')::uuid,'lot_location_events');
INSERT INTO public.lot_sticker_pool(claimed_by_lot_id,claimed_at) VALUES(md5('physical-batch-6')::uuid,now());
SELECT pg_temp.expect_reason(md5('physical-batch-6')::uuid,'lot_sticker_pool');

-- No machine evidence is not physical clearance: a canonical printed label
-- has no issuance ledger here. The detector cannot see that external fact.
DO $$ BEGIN
  IF public.lot_has_physical_footprint(md5('physical-batch-7')::uuid) THEN RAISE EXCEPTION 'clean detector false positive'; END IF;
  PERFORM public.assert_no_physical_footprint(ARRAY[md5('physical-batch-7')::uuid]);
END $$;

-- Child -> ancestor -> deleted sibling -> descendant. Full connected family.
INSERT INTO public.lots(id,operator_id,relisted_from_lot_id,deleted_at,sticker_code) VALUES
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',NULL,NULL,NULL),
 ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',NULL,NULL),
 ('10000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',now(),'sibling-label'),
 ('10000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000003',NULL,NULL);
SELECT pg_temp.expect_reason('10000000-0000-0000-0000-000000000002','sticker_code','10000000-0000-0000-0000-000000000003');
SELECT pg_temp.expect_reason('10000000-0000-0000-0000-000000000004','sticker_code','10000000-0000-0000-0000-000000000003');
SELECT pg_temp.expect_error($q$SELECT public.assert_no_physical_footprint(ARRAY['10000000-0000-0000-0000-000000000002']::uuid[])$q$,'physical evidence exists');

-- Unknown IDs and corrupt lineage must error, even in a mixed batch with
-- a known stickered row (the detector must validate before returning evidence).
SELECT pg_temp.expect_error($q$SELECT public.lot_has_physical_footprint('ffffffff-ffff-ffff-ffff-ffffffffffff')$q$,'unknown lot');
SELECT pg_temp.expect_error($q$SELECT public.assert_no_physical_footprint(ARRAY[md5('physical-batch-1')::uuid,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid])$q$,'unknown lot');
SELECT pg_temp.expect_error($q$SELECT public.lot_has_physical_footprint(NULL)$q$,'null lot IDs');
INSERT INTO public.lots(id,operator_id,relisted_from_lot_id) VALUES
 ('20000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002'),
 ('20000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001'),
 ('20000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003'),
 ('20000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','ffffffff-ffff-ffff-ffff-ffffffffffff');
SELECT pg_temp.expect_error($q$SELECT public.lot_has_physical_footprint('20000000-0000-0000-0000-000000000001')$q$,'cyclic lineage');
SELECT pg_temp.expect_error($q$SELECT public.lot_has_physical_footprint('20000000-0000-0000-0000-000000000003')$q$,'cyclic lineage');
SELECT pg_temp.expect_error($q$SELECT public.lot_has_physical_footprint('20000000-0000-0000-0000-000000000004')$q$,'dangling lineage');
UPDATE public.lots SET operator_id='00000000-0000-0000-0000-000000000002' WHERE id='10000000-0000-0000-0000-000000000003';
SELECT pg_temp.expect_error($q$SELECT public.lot_has_physical_footprint('10000000-0000-0000-0000-000000000002')$q$,'cross-operator lineage');

-- Direct ACL checks cover all helpers; the app never gets an inspection API.
INSERT INTO public.lots(id,operator_id,relisted_from_lot_id)
SELECT md5('long-family-' || n)::uuid,'00000000-0000-0000-0000-000000000001',
       CASE WHEN n=1 THEN NULL ELSE md5('long-family-' || (n-1))::uuid END
FROM generate_series(1,257) AS g(n);
SELECT pg_temp.expect_error($q$SELECT public.lot_has_physical_footprint(md5('long-family-1')::uuid)$q$,'traversal limit exceeded');
SELECT pg_temp.expect_error($q$SELECT public.assert_no_physical_footprint(array_fill(md5('physical-batch-7')::uuid, ARRAY[10001]))$q$,'input limit exceeded');
INSERT INTO public.lots(id,operator_id,relisted_from_lot_id)
SELECT md5('wide-family-' || n)::uuid,'00000000-0000-0000-0000-000000000001',
       CASE WHEN n=1 THEN NULL ELSE md5('wide-family-1')::uuid END
FROM generate_series(1,10001) AS g(n);
SELECT pg_temp.expect_error($q$SELECT public.lot_has_physical_footprint(md5('wide-family-1')::uuid)$q$,'family limit exceeded');

DO $$ DECLARE r text; f text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    FOREACH f IN ARRAY ARRAY['_lot_physical_footprint(uuid[])','lot_physical_footprint(uuid)','lot_has_physical_footprint(uuid)','assert_no_physical_footprint(uuid[])'] LOOP
      IF has_function_privilege(r,'public.' || f,'EXECUTE') THEN RAISE EXCEPTION 'app role can execute guard: % %',r,f; END IF;
    END LOOP;
  END LOOP;
END $$;
SET LOCAL ROLE anon;
SELECT pg_temp.expect_error($q$SELECT public.lot_has_physical_footprint('10000000-0000-0000-0000-000000000001')$q$,'permission denied');
RESET ROLE;

-- Even if an administrator explicitly delegates function/table privileges,
-- row_security=off must refuse filtering, never return a reassuring false.
CREATE ROLE footprint_rls_test;
GRANT USAGE ON SCHEMA public TO footprint_rls_test;
GRANT SELECT ON public.lots,public.bin_assignments,public.lot_location_events,public.lot_sticker_pool TO footprint_rls_test;
GRANT EXECUTE ON FUNCTION public._lot_physical_footprint(uuid[]),public.lot_physical_footprint(uuid),public.lot_has_physical_footprint(uuid) TO footprint_rls_test;
SET LOCAL ROLE footprint_rls_test;
SELECT pg_temp.expect_error($q$SELECT public.lot_has_physical_footprint(md5('physical-batch-1')::uuid)$q$,'row-level security');
RESET ROLE;

-- The assertion must retain all table locks until the transaction ends.
DO $$ DECLARE n integer; BEGIN
  SELECT count(*) INTO n FROM pg_locks
    WHERE pid=pg_backend_pid() AND mode='ShareRowExclusiveLock' AND granted
      AND relation IN ('public.lots'::regclass,'public.bin_assignments'::regclass,'public.lot_location_events'::regclass,'public.lot_sticker_pool'::regclass);
  IF n <> 4 THEN RAISE EXCEPTION 'assertion did not retain all footprint writer locks'; END IF;
END $$;
ROLLBACK;
BEGIN ISOLATION LEVEL REPEATABLE READ;
DO $$ DECLARE refused boolean := false; BEGIN
  BEGIN PERFORM public.assert_no_physical_footprint(ARRAY[]::uuid[]);
  EXCEPTION WHEN raise_exception THEN
    IF position('requires READ COMMITTED' IN SQLERRM)=0 THEN RAISE; END IF;
    refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'stale snapshot isolation was accepted'; END IF;
END $$;
ROLLBACK;
\echo 'physical-footprint behavioral fixtures passed (rolled back)'
