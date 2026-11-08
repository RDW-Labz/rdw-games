-- 0313 — A bidder scanning a sticker gets the same answer staff do
--
-- Field report 2026-08-07: a customer scanning the TEA label on a box is told
-- to "scan the auction QR to check in", and when the scan does resolve it
-- lands on the wrong lot. Two separate defects behind one symptom.
--
-- ── Defect 1: the bidder resolver never got 0304 ───────────────────────────
--
-- 0304 rebuilt scan resolution around one rule — gather every row any probe
-- matches, rank active-before-retired, then sticker-over-lot_code, then
-- newest; and if the winner is still a tombstone, walk `relisted_from_lot_id`
-- FORWARD to the incarnation actually on the floor. Its closing note says the
-- scanners, the storefront, and the RPCs "finally agree on one answer."
--
-- The bidder app was not in that list. `resolve_lot_by_sticker` (0150) still
-- does what 0304 was written to stop: a single equality on `sticker_code`,
-- first row wins, no ranking and no lineage walk. So for the reported label:
--
--     TEA4951993   relisted   sticker_code NULL     <- lineage root
--     BIN-006802   unsold     BIN:TEA4951993        <- holds the sticker
--     BIN-007904   won        sticker_code NULL     <- what the customer owns
--
-- the only row whose `sticker_code` equals `BIN:TEA4951993` is the UNSOLD
-- twin, so that is what the customer's scan returns — a dead lot, for an item
-- they already won. Ranking + the forward walk lands on BIN-007904 instead.
--
-- `_find_lot_by_scan` already encodes all of this, but it is staff-only: it
-- derives `current_operator_id()` and RAISEs 'unauthorized' when that is NULL,
-- which is every bidder. Hence a sibling rather than a grant — same rule,
-- bidder-appropriate scoping and rate limiting.
--
-- ── Why 0304's rule alone is not enough here ───────────────────────────────
--
-- Ranking the three rows above still returns BIN-006802: `unsold` is not one
-- of the retired statuses (it is real inventory, correctly so for staff), so
-- it outranks the tombstone AND the forward walk never fires — the winner is
-- not retired, so there is nothing to walk from. Staff scanning that box in
-- the aisle genuinely want the unsold record. The CUSTOMER does not.
--
-- Widening `retired` to include `unsold` would fix the customer and break the
-- warehouse. So this adds one rule ahead of the ranking, available only to a
-- bidder-facing resolver: if the person scanning owns a lot in this lineage,
-- that is the lot they mean. It needs no adjudication of who owns the sticker
-- — the invoice already says so — and it cannot cross customers, because the
-- probe is scoped to auth.uid(). Everyone else still gets 0304's ranking.
--
-- ── Defect 2: the check-in gate dead-ends the common case ──────────────────
--
-- `resolve_lot_by_sticker` needs an operator to build the '{op}:{raw}' probe,
-- so the app refuses to scan at all until the bidder finds a door "Preview QR"
-- — the message in the report. That gate exists to disambiguate identical raw
-- labels across operators, but it charges every bidder for a collision that
-- has to actually happen. Prod today: one real operator (BIN, 12,412 lots) and
-- a 3-lot DEMO.
--
-- So make the operator optional. Passed (a check-in exists) → scope to it,
-- exactly as before. NULL → probe every operator and report how many distinct
-- operators matched, so the client can ask for a check-in ONLY when the label
-- is genuinely ambiguous. The gate survives for the case it was built for and
-- disappears for the case it was breaking.
--
-- Deliberately NOT changed:
--   • `resolve_lot_by_sticker` (0150) — left in place, still operator-scoped,
--     so nothing already calling it changes behaviour.
--   • sticker OWNERSHIP. This only decides which lot a scan RESOLVES to; it
--     writes nothing. The 82 labels whose active holder is contested are a
--     data question and stay open.
--   • the rate limit — same table, same window/budget as 0150.

CREATE OR REPLACE FUNCTION public.resolve_lot_for_bidder(
  p_raw_code    TEXT,
  p_operator_id UUID DEFAULT NULL
)
RETURNS TABLE (
  lot_id            UUID,
  lot_code          TEXT,
  operator_id       UUID,
  operator_code     TEXT,
  status            lot_status,
  auction_id        UUID,
  auction_status    TEXT,
  title             TEXT,
  thumbnail_url     TEXT,
  -- 0 when nothing matched. >1 means the raw label is ambiguous ACROSS
  -- operators and the caller should ask for a preview check-in; the ranked
  -- winner is still returned so the client can choose to use it.
  operator_matches  INT
)
LANGUAGE plpgsql
-- VOLATILE (the default), not STABLE like _find_lot_by_scan: this one records
-- the scan in bidder_sticker_scan_log for the rate limit, and Postgres refuses
-- writes inside a non-volatile function.
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bidder   UUID;
  v_clean    TEXT := TRIM(COALESCE(p_raw_code, ''));
  v_op_code  TEXT;
  v_lot      lots%ROWTYPE;
  v_lot_id   UUID;
  v_owned_id UUID;
  v_matched  UUID[];
  v_ops      INT := 0;
  v_child_id UUID;
  v_seen     UUID[];
  v_i        INT;
  c_window   CONSTANT INTERVAL := INTERVAL '1 minute';
  c_max      CONSTANT INTEGER  := 40;
  v_recent   INTEGER;
BEGIN
  v_bidder := auth.uid();
  IF v_bidder IS NULL THEN
    RETURN; -- no rows: unauthenticated
  END IF;

  -- Same guards as 0150: a raw label never carries the namespace ':'.
  IF v_clean = '' OR LENGTH(v_clean) > 200 OR v_clean LIKE '%:%' THEN
    RETURN;
  END IF;

  -- Rate limit, self-trimming, identical budget to resolve_lot_by_sticker.
  -- An over-budget call RAISEs before its INSERT so abuse cannot grow the log.
  DELETE FROM bidder_sticker_scan_log
   WHERE bidder_id = v_bidder AND scanned_at < now() - c_window;
  SELECT count(*) INTO v_recent FROM bidder_sticker_scan_log WHERE bidder_id = v_bidder;
  IF v_recent >= c_max THEN
    RAISE EXCEPTION 'Too many scans — wait a moment and try again.' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO bidder_sticker_scan_log (bidder_id) VALUES (v_bidder);

  -- An unknown operator id is treated as no check-in rather than as a failure.
  -- The device holds this value indefinitely, so an operator that was renamed
  -- or removed must degrade to an unscoped probe — otherwise the stale id
  -- scopes the query to an operator with no lots and blanks a valid scan.
  IF p_operator_id IS NOT NULL THEN
    SELECT code INTO v_op_code FROM operators WHERE id = p_operator_id;
    IF v_op_code IS NULL THEN
      p_operator_id := NULL;
    END IF;
  END IF;

  -- One pass over every identifier column a printed label can live in, ranked
  -- by 0304's rule. `sticker_code` is stored '{op}:{raw}', so match the raw
  -- half via split_part when unscoped rather than assuming one operator code.
  -- The predicate is written once; the CTE feeds both the ranked winner and
  -- the distinct-operator count (COUNT(DISTINCT …) OVER () is not implemented
  -- in Postgres, so the count cannot ride along as a window function).
  WITH m AS (
    SELECT
      l.id,
      l.operator_id,
      CASE
        WHEN l.sticker_code = v_op_code || ':' || v_clean            THEN 1
        WHEN split_part(l.sticker_code, ':', 2) = v_clean            THEN 2
        WHEN upper(l.lot_code) = upper(v_clean)                      THEN 3
        WHEN upper(l.legacy_lot_code) = upper(v_clean)               THEN 4
      END AS field_rank,
      (l.status IN ('canceled', 'relisted', 'disposed')) AS retired,
      l.created_at
    FROM lots l
    WHERE l.deleted_at IS NULL
      -- When a check-in exists, stay inside it. Otherwise probe globally and
      -- let `operator_matches` tell the caller whether that was ambiguous.
      AND (p_operator_id IS NULL OR l.operator_id = p_operator_id)
      AND (
           (v_op_code IS NOT NULL AND l.sticker_code = v_op_code || ':' || v_clean)
        OR split_part(l.sticker_code, ':', 2) = v_clean
        OR upper(l.lot_code) = upper(v_clean)
        OR upper(l.legacy_lot_code) = upper(v_clean)
      )
  )
  SELECT
    (SELECT m.id
       FROM m
      ORDER BY
        m.retired ASC,      -- 1. a live incarnation beats a tombstone outright
        m.field_rank ASC,   -- 2. the sticker on the box beats the lot_code
        m.created_at DESC   -- 3. newest — the relist child, by construction
      LIMIT 1),
    (SELECT count(DISTINCT m.operator_id) FROM m),
    (SELECT array_agg(m.id) FROM m)
  INTO v_lot_id, v_ops, v_matched;

  IF v_lot_id IS NULL THEN
    RETURN;
  END IF;

  -- One physical box can answer to several rows across a relist chain, and the
  -- ranked winner is the warehouse's answer, not necessarily this customer's.
  -- Expand the label's whole lineage — up to every root, then back down — and
  -- if this bidder is invoiced for a member, that is the item in their hands.
  -- UNION (not UNION ALL) dedupes, which also terminates a cyclic chain.
  WITH RECURSIVE up AS (
    SELECT l.id, l.relisted_from_lot_id FROM lots l WHERE l.id = ANY(v_matched)
    UNION
    SELECT p.id, p.relisted_from_lot_id
      FROM lots p JOIN up ON p.id = up.relisted_from_lot_id
  ),
  fam AS (
    SELECT up.id FROM up WHERE up.relisted_from_lot_id IS NULL
    UNION
    SELECT c.id
      FROM lots c JOIN fam ON c.relisted_from_lot_id = fam.id
     WHERE c.deleted_at IS NULL
  )
  SELECT l.id
    INTO v_owned_id
  FROM fam
  JOIN lots l          ON l.id = fam.id AND l.deleted_at IS NULL
  JOIN invoice_lots il ON il.lot_id = l.id
  JOIN invoices i      ON i.id = il.invoice_id
  WHERE i.bidder_id = v_bidder
  ORDER BY l.created_at DESC   -- their most recent purchase in this lineage
  LIMIT 1;

  IF v_owned_id IS NOT NULL THEN
    v_lot_id := v_owned_id;
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = v_lot_id;

  -- Every match was a tombstone: walk forward to whatever the item became.
  -- Bounded and cycle-guarded, mirroring _find_lot_by_scan.
  --
  -- Skipped when the bidder's own invoice picked the lot. Their purchase may
  -- itself be a tombstone (an early win on a box that was later relisted), and
  -- walking forward from it would hand them the NEXT buyer's lot.
  IF v_owned_id IS NULL AND v_lot.status IN ('canceled', 'relisted', 'disposed') THEN
    v_seen := ARRAY[v_lot.id];
    FOR v_i IN 1..5 LOOP
      v_child_id := NULL;
      SELECT ch.id INTO v_child_id
      FROM lots ch
      WHERE ch.relisted_from_lot_id = v_lot.id
        AND ch.deleted_at IS NULL
        AND NOT (ch.id = ANY(v_seen))
      ORDER BY
        (ch.status IN ('canceled', 'relisted', 'disposed')) ASC,
        ch.created_at DESC
      LIMIT 1;

      EXIT WHEN v_child_id IS NULL;

      v_seen := v_seen || v_child_id;
      SELECT * INTO v_lot FROM lots WHERE id = v_child_id;

      EXIT WHEN v_lot.status NOT IN ('canceled', 'relisted', 'disposed');
    END LOOP;
  END IF;

  RETURN QUERY
  SELECT
    v_lot.id,
    v_lot.lot_code,
    v_lot.operator_id,
    o.code,
    v_lot.status,
    v_lot.auction_id,
    a.status::TEXT,
    v_lot.title,
    (CASE WHEN array_length(v_lot.photo_urls, 1) >= 1 THEN v_lot.photo_urls[1] END)::TEXT,
    GREATEST(v_ops, 1)
  FROM operators o
  LEFT JOIN auctions a ON a.id = v_lot.auction_id
  WHERE o.id = v_lot.operator_id;
END;
$$;

COMMENT ON FUNCTION public.resolve_lot_for_bidder(TEXT, UUID) IS
  'Bidder-facing scan resolution (0313). Same ranking as _find_lot_by_scan '
  '(active-before-retired, sticker-over-lot_code, newest) plus the forward '
  'relist walk, which resolve_lot_by_sticker (0150) never had — that resolver '
  'matched sticker_code only and so returned the unsold twin for a relisted '
  'box. Ahead of that ranking: if the scanning bidder is invoiced for a lot in '
  'the scanned label''s lineage, that lot wins — unsold is not a retired '
  'status, so ranking alone hands the customer the warehouse''s answer. '
  'Operator is OPTIONAL: passed = scoped to the preview check-in, NULL = '
  'probe every operator and report operator_matches so the caller can demand a '
  'check-in only when the label is genuinely ambiguous. Resolves only; writes '
  'nothing and does not change sticker ownership.';

REVOKE ALL ON FUNCTION public.resolve_lot_for_bidder(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_lot_for_bidder(TEXT, UUID) TO authenticated;
