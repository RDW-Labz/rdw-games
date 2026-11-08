-- Session helpers for the 0454 rig (pg_temp: gone when the session ends).
--   pg_temp.who(label)      sets the JWT subject ('admin', 'manager', 'b1', 'none')
--   pg_temp.lot(code) / pg_temp.auc(prefix)  fixed ids by lot_code / title prefix
--   pg_temp.try(label, sql) runs sql; 'label: ok <first value>' or
--                           'label: ERR <message> [<hint>]' (rolled back)
--   pg_temp.expect(label, sql, want)  want = 'ok', 'ok <exact value>', a HINT
--                           code (sqft_*) or a message fragment; prints PASS/FAIL
--   pg_temp.lotrow(code)    the deterministic columns of one lot
\set ON_ERROR_STOP 1

CREATE FUNCTION pg_temp.who(p text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub',
    CASE WHEN p = 'none' THEN '' ELSE (SELECT id::text FROM auth.users WHERE email = p || '@example.test') END, false);
END $$;

CREATE FUNCTION pg_temp.lot(p text) RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT coalesce((SELECT id FROM lots WHERE lot_code = p), '00000000-0000-0000-0000-00000000dead'::uuid) $$;
CREATE FUNCTION pg_temp.auc(p text) RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT id FROM auctions WHERE split_part(title, ' ', 1) = p $$;
-- VOLATILE: must see the row an RPC in the same statement just inserted.
CREATE FUNCTION pg_temp.code(p uuid) RETURNS text LANGUAGE sql VOLATILE AS
$$ SELECT coalesce((SELECT lot_code FROM lots WHERE id = p), '-') $$;

CREATE FUNCTION pg_temp.try(p_label text, p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text; m text; h text;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN p_label || ': ok ' || coalesce(v, '-');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS m = MESSAGE_TEXT, h = PG_EXCEPTION_HINT;
  RETURN p_label || ': ERR ' || m || CASE WHEN coalesce(h, '') <> '' THEN ' [' || h || ']' ELSE '' END;
END $$;

CREATE FUNCTION pg_temp.expect(p_label text, p_sql text, p_want text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text := pg_temp.try(p_label, p_sql); good boolean;
BEGIN
  IF p_want = 'ok' THEN good := r LIKE p_label || ': ok%';
  ELSIF p_want LIKE 'ok %' THEN good := r = p_label || ': ' || p_want;
  ELSE good := r LIKE p_label || ': ERR%' AND strpos(r, p_want) > 0;
  END IF;
  RETURN CASE WHEN good THEN 'PASS ' ELSE 'FAIL ' END || r;
END $$;

-- Deterministic view of a lot (no ids, no timestamps).
CREATE FUNCTION pg_temp.lotrow(p_code text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT l.lot_code || ' ' || l.status || ' auc=' || coalesce(split_part(a.title, ' ', 1), '-')
      || ' no=' || coalesce(l.lot_number::text, '-') || ' start=' || l.starting_bid_cents
      || ' qty=' || coalesce(l.unit_qty::text, '-') || ' label=' || coalesce(l.unit_label, '-')
      || ' from=' || coalesce(p.lot_code, '-') || ' relists=' || coalesce(l.relist_count::text, '-')
      || ' origin=' || coalesce(l.relist_origin, '-') || ' cur=' || coalesce(l.current_bid_cents::text, '-')
      || ' del=' || (l.deleted_at IS NOT NULL)
    FROM lots l
    LEFT JOIN auctions a ON a.id = l.auction_id
    LEFT JOIN lots p ON p.id = l.relisted_from_lot_id
   WHERE l.lot_code = p_code
$$;
