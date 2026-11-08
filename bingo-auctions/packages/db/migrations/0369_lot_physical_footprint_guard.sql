-- Administrative evidence guard for reviewed destructive lot migrations.
-- Additive only: no app trigger, policy, data mutation, or automatic cleanup.
-- Absence of this evidence DOES NOT prove absence of a box/printed label.
-- Canonical/offline printing is not completely recorded; human review remains
-- mandatory. Invoke the assertion on exactly the mutation IDs in the SAME
-- transaction. The runner must SET LOCAL statement_timeout = '30s' first.
-- Assertion locks block footprint writers until that transaction ends.

CREATE OR REPLACE FUNCTION public._lot_physical_footprint(p_lot_ids uuid[])
RETURNS TABLE(lot_id uuid, reason text)
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  v_seen uuid[];
  v_frontier uuid[];
  v_found uuid[];
  v_parents uuid[];
  v_next uuid[];
  v_round integer := 0;
  v_rooted_count integer;
BEGIN
  IF p_lot_ids IS NULL OR array_position(p_lot_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'physical footprint: null lot IDs cannot be evaluated';
  END IF;
  IF cardinality(p_lot_ids) > 10000 THEN
    RAISE EXCEPTION 'physical footprint: input limit exceeded (10000 IDs)';
  END IF;
  SELECT coalesce(array_agg(DISTINCT x), '{}'::uuid[]) INTO v_seen
    FROM unnest(p_lot_ids) AS u(x);
  v_frontier := v_seen;

  -- Traverse the undirected family, not just descendants: ancestors connect
  -- siblings, including deleted members. Each node is expanded once. Arrays
  -- and expansion rounds are capped; exceeding a cap is an error, not false.
  WHILE cardinality(v_frontier) > 0 LOOP
    v_round := v_round + 1;
    IF v_round > 256 THEN
      RAISE EXCEPTION 'physical footprint: lineage traversal limit exceeded (256 rounds)';
    END IF;
    SELECT coalesce(array_agg(l.id), '{}'::uuid[]),
           coalesce(array_agg(l.relisted_from_lot_id)
             FILTER (WHERE l.relisted_from_lot_id IS NOT NULL), '{}'::uuid[])
      INTO v_found, v_parents
      FROM public.lots AS l WHERE l.id = ANY(v_frontier);
    IF cardinality(v_found) <> cardinality(v_frontier) THEN
      RAISE EXCEPTION 'physical footprint: unknown lot or dangling lineage';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.lots AS child
      JOIN public.lots AS parent ON parent.id = child.relisted_from_lot_id
      WHERE child.id = ANY(v_frontier)
        AND child.operator_id IS DISTINCT FROM parent.operator_id
    ) THEN
      RAISE EXCEPTION 'physical footprint: cross-operator lineage';
    END IF;

    SELECT coalesce(array_agg(n.id), '{}'::uuid[]) INTO v_next
    FROM (
      SELECT candidates.id FROM (
        SELECT unnest(v_parents) AS id
        UNION
        SELECT child.id FROM public.lots AS child
          WHERE child.relisted_from_lot_id = ANY(v_frontier)
      ) AS candidates
      WHERE NOT (candidates.id = ANY(v_seen))
      LIMIT 10001
    ) AS n;
    IF cardinality(v_seen) + cardinality(v_next) > 10000 THEN
      RAISE EXCEPTION 'physical footprint: family limit exceeded (10000 lots)';
    END IF;
    v_seen := v_seen || v_next;
    v_frontier := v_next;
  END LOOP;

  -- A valid one-parent family is reachable from its null-parent roots.
  -- A directed cycle (including a self-loop) has no root. UNION deduplicates
  -- nodes, so this validation terminates even on corrupt data.
  WITH RECURSIVE rooted(id) AS (
    SELECT l.id FROM public.lots AS l
      WHERE l.id = ANY(v_seen) AND l.relisted_from_lot_id IS NULL
    UNION
    SELECT child.id FROM public.lots AS child
      JOIN rooted AS parent ON child.relisted_from_lot_id = parent.id
      WHERE child.id = ANY(v_seen)
  ) SELECT count(*) INTO v_rooted_count FROM rooted;
  IF v_rooted_count <> cardinality(v_seen) THEN
    RAISE EXCEPTION 'physical footprint: cyclic lineage';
  END IF;

  RETURN QUERY
    SELECT l.id, 'sticker_code'::text FROM public.lots AS l
      WHERE l.id = ANY(v_seen) AND l.sticker_code IS NOT NULL
    UNION ALL
    SELECT l.id, 'intake_bin_id'::text FROM public.lots AS l
      WHERE l.id = ANY(v_seen) AND l.intake_bin_id IS NOT NULL
    UNION ALL
    SELECT l.id, 'intake_at'::text FROM public.lots AS l
      WHERE l.id = ANY(v_seen) AND l.intake_at IS NOT NULL
    UNION ALL
    SELECT l.id, 'bin_assignments'::text FROM public.lots AS l
      WHERE l.id = ANY(v_seen) AND EXISTS (
        SELECT 1 FROM public.bin_assignments AS b WHERE b.lot_id = l.id)
    UNION ALL
    SELECT l.id, 'lot_location_events'::text FROM public.lots AS l
      WHERE l.id = ANY(v_seen) AND EXISTS (
        SELECT 1 FROM public.lot_location_events AS e WHERE e.lot_id = l.id)
    UNION ALL
    SELECT l.id, 'lot_sticker_pool'::text FROM public.lots AS l
      WHERE l.id = ANY(v_seen) AND EXISTS (
        SELECT 1 FROM public.lot_sticker_pool AS s WHERE s.claimed_by_lot_id = l.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.lot_physical_footprint(p_lot_id uuid)
RETURNS TABLE(lot_id uuid, reason text)
LANGUAGE sql SECURITY INVOKER
SET search_path = pg_catalog, public
SET row_security = off
AS $$ SELECT * FROM public._lot_physical_footprint(ARRAY[p_lot_id]); $$;

CREATE OR REPLACE FUNCTION public.lot_has_physical_footprint(p_lot_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY INVOKER
SET search_path = pg_catalog, public
SET row_security = off
AS $$ SELECT EXISTS (SELECT 1 FROM public.lot_physical_footprint(p_lot_id)); $$;

CREATE OR REPLACE FUNCTION public.assert_no_physical_footprint(p_lot_ids uuid[])
RETURNS void
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  v_lock_timeout text := current_setting('lock_timeout');
BEGIN
  -- Fixed order shared by all callers. These locks conflict with INSERT,
  -- UPDATE and DELETE on lots and all three child evidence tables. Row locks
  -- alone would not protect all historical evidence insert paths.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'physical footprint: assertion requires READ COMMITTED for a fresh post-lock snapshot';
  END IF;
  PERFORM set_config('lock_timeout', '5s', true);
  LOCK TABLE public.lots IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.bin_assignments IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.lot_location_events IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.lot_sticker_pool IN SHARE ROW EXCLUSIVE MODE;
  PERFORM set_config('lock_timeout', v_lock_timeout, true);

  IF EXISTS (SELECT 1 FROM public._lot_physical_footprint(p_lot_ids)) THEN
    RAISE EXCEPTION 'physical footprint: destructive batch refused; physical evidence exists';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._lot_physical_footprint(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.lot_physical_footprint(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.lot_has_physical_footprint(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.assert_no_physical_footprint(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._lot_physical_footprint(uuid[]) TO postgres;
GRANT EXECUTE ON FUNCTION public.lot_physical_footprint(uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.lot_has_physical_footprint(uuid) TO postgres;
GRANT EXECUTE ON FUNCTION public.assert_no_physical_footprint(uuid[]) TO postgres;

COMMENT ON FUNCTION public.assert_no_physical_footprint(uuid[]) IS
  'Admin-only maintenance guard. Same transaction/exact IDs as mutation; locks footprint tables until transaction end. Absence of evidence is not physical clearance; printing/offline work requires human review.';
