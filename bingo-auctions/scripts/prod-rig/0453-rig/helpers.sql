-- Session helpers for the 0453 rig. pg_temp: gone when the session ends.
--   pg_temp.bid(who, lot, amount)        → the call style chosen by GUC rig.fn:
--       '2' place_bid(lot, amount)
--       '3' place_bid(lot, amount, rig.qty)   (rig.qty '' = NULL)
--   pg_temp.bid3(who, lot, amount, qty)  → always the 3-arg
-- who = auth.users label ('b1', 'nocard', … or 'anon' for no JWT).
-- Exceptions (shill / identity) are caught and returned as 'EXC <message>'.
\set ON_ERROR_STOP 1

CREATE FUNCTION pg_temp.lbl(p uuid) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT coalesce((SELECT label FROM rig_labels WHERE id = p), CASE WHEN p IS NULL THEN '-' ELSE '?' END) $$;

CREATE FUNCTION pg_temp.fmt(r place_bid_result) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT r.ok || ' ' || r.reason || ' cur=' || coalesce(r.current_bid_cents::text, '-')
       || ' lead=' || pg_temp.lbl(r.current_leader_id) || ' ext=' || coalesce(r.was_extended::text, '-')
       || ' outbid=' || pg_temp.lbl(r.outbid_bidder_id) $$;

CREATE FUNCTION pg_temp.who(p_who text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub',
    CASE WHEN p_who = 'anon' THEN ''
         ELSE (SELECT id::text FROM auth.users WHERE email = p_who || '@example.test') END, false);
END $$;

CREATE FUNCTION pg_temp.lot(p_code text) RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT coalesce((SELECT id FROM lots WHERE lot_code = p_code), '00000000-0000-0000-0000-00000000dead'::uuid) $$;

CREATE FUNCTION pg_temp.bid(p_who text, p_lot text, p_amt bigint) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r place_bid_result; q text := current_setting('rig.qty', true);
BEGIN
  PERFORM pg_temp.who(p_who);
  IF current_setting('rig.fn') = '3' THEN
    r := place_bid(pg_temp.lot(p_lot), p_amt, nullif(q, '')::int);
  ELSE
    r := place_bid(pg_temp.lot(p_lot), p_amt);
  END IF;
  RETURN p_who || ' ' || p_lot || ' ' || p_amt || ': ' || pg_temp.fmt(r);
EXCEPTION WHEN raise_exception THEN
  RETURN p_who || ' ' || p_lot || ' ' || p_amt || ': EXC ' || SQLERRM;
END $$;

CREATE FUNCTION pg_temp.bid3(p_who text, p_lot text, p_amt bigint, p_qty int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE r place_bid_result;
BEGIN
  PERFORM pg_temp.who(p_who);
  r := place_bid(pg_temp.lot(p_lot), p_amt, p_qty);
  RETURN p_who || ' ' || p_lot || ' ' || p_amt || ' q=' || coalesce(p_qty::text, 'null') || ': ' || pg_temp.fmt(r);
EXCEPTION WHEN raise_exception THEN
  RETURN p_who || ' ' || p_lot || ' ' || p_amt || ': EXC ' || SQLERRM;
END $$;

-- Raw result, for exact-equality checks.
CREATE FUNCTION pg_temp.r3(p_who text, p_lot text, p_amt bigint, p_qty int) RETURNS place_bid_result LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_temp.who(p_who); RETURN place_bid(pg_temp.lot(p_lot), p_amt, p_qty); END $$;
CREATE FUNCTION pg_temp.r2(p_who text, p_lot text, p_amt bigint) RETURNS place_bid_result LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_temp.who(p_who); RETURN place_bid(pg_temp.lot(p_lot), p_amt); END $$;
