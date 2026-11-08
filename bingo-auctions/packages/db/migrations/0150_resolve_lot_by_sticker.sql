-- ============================================================================
-- Migration 0150 — Bidder-scannable stickers (Option C: preview check-in)
--
-- See docs/state/PATCH-bidder-scannable-stickers-2026-05-27.md.
--
-- Bidders have no operator identity, so an operator's own physical sticker
-- (sticker_code = `{op.code}:{raw}`, mig 0141) can't be resolved by a bidder
-- the way staff resolve it (current_operator_id()). Option C supplies the
-- operator context from a ONE-TIME, persisted "preview check-in": the bidder
-- scans the operator's door "Preview QR" (or picks their auction house) once,
-- and we persist that operator on the bidder profile. Scanning a sticker then
-- resolves `{op.code}:{raw}` operator-scoped, exactly like staff.
--
-- This migration is ADDITIVE ONLY:
--   1. bidders.preview_operator_id — the persisted preview-check-in operator.
--   2. bidder_sticker_scan_log     — per-bidder throttle accounting (internal).
--   3. set_bidder_preview_operator(p_auction_id) — sets the check-in operator
--      from a scanned door QR (which encodes an auction_id → its operator).
--   4. resolve_lot_by_sticker(p_raw_code, p_operator_id) — bidder-facing
--      sticker resolver, operator-scoped, safe-column allowlist (mirrors
--      resolve_lot_by_qr_token, 0103) + a per-bidder rate limit.
--
-- NO in-auction gate (return the lot regardless of auction status; the client
-- routes live→bid / else→watchlist, identical to the qr_token path). NO
-- sticker reuse / lifecycle clearing (codes stay bound permanently, per 0141).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. bidders.preview_operator_id — persisted preview-check-in operator
-- ---------------------------------------------------------------------------
ALTER TABLE public.bidders
  ADD COLUMN IF NOT EXISTS preview_operator_id UUID
    REFERENCES public.operators(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.bidders.preview_operator_id IS
  '0150 (Option C): the auction house the bidder last checked in to preview. '
  'Set ONCE via set_bidder_preview_operator (door "Preview QR" scan or pick-'
  'your-house). Supplies the operator context for resolve_lot_by_sticker so a '
  'bidder can scan the operator''s own physical sticker codes. NULL = no '
  'check-in yet.';

-- ---------------------------------------------------------------------------
-- 2. Per-bidder rate-limit log for the sticker resolver
-- ---------------------------------------------------------------------------
-- resolve_lot_by_sticker returns warehouse-visible info (title/photo/price) for
-- a lot the bidder is physically standing in front of — low sensitivity, but we
-- still throttle to stop a signed-in bidder from programmatically enumerating an
-- operator's raw-code namespace. Bounded WITHOUT a cron: each call first purges
-- the caller's own expired rows, so the table self-trims.
CREATE TABLE IF NOT EXISTS public.bidder_sticker_scan_log (
  bidder_id  UUID NOT NULL,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bidder_sticker_scan_log_bidder_idx
  ON public.bidder_sticker_scan_log (bidder_id, scanned_at);

-- RLS on + NO policies + NO grants → clients (anon/authenticated) cannot touch
-- it via PostgREST; only the SECURITY DEFINER resolver (runs as owner, bypasses
-- RLS) reads/writes it.
ALTER TABLE public.bidder_sticker_scan_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.bidder_sticker_scan_log IS
  '0150: internal per-bidder throttle accounting for resolve_lot_by_sticker. '
  'Written only by that SECURITY DEFINER function; self-trims per call. Not '
  'client-accessible (RLS on, no policies, no grants).';

-- ---------------------------------------------------------------------------
-- 3. set_bidder_preview_operator(p_auction_id UUID)
-- ---------------------------------------------------------------------------
-- The operator's door "Preview QR" encodes an auction_id. Scanning it in the
-- bidder app calls this to persist the auction's operator as the bidder's
-- preview context. Returns the operator identity so the client can ALSO cache
-- it on-device (AsyncStorage) and show "Previewing {house}".
CREATE OR REPLACE FUNCTION public.set_bidder_preview_operator(p_auction_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bidder   UUID;
  v_op_id    UUID;
  v_op_name  TEXT;
  v_op_code  TEXT;
BEGIN
  v_bidder := auth.uid();
  IF v_bidder IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT operator_id INTO v_op_id FROM auctions WHERE id = p_auction_id;
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'auction_not_found');
  END IF;

  SELECT business_name, code INTO v_op_name, v_op_code
    FROM operators WHERE id = v_op_id;

  -- Persist on the bidder profile. Best-effort: a non-bidder caller has no
  -- bidders row → 0 rows updated, but we still return ok so the client can
  -- cache the operator on-device regardless.
  UPDATE bidders
     SET preview_operator_id = v_op_id, updated_at = now()
   WHERE id = v_bidder;

  RETURN jsonb_build_object(
    'ok', true,
    'operator_id', v_op_id,
    'operator_name', v_op_name,
    'operator_code', v_op_code
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_bidder_preview_operator(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_bidder_preview_operator(UUID) TO authenticated;

COMMENT ON FUNCTION public.set_bidder_preview_operator(UUID) IS
  '0150 (Option C): persist the scanned door-QR auction''s operator as the '
  'caller''s bidders.preview_operator_id. Returns the operator identity for '
  'on-device caching. authenticated-only.';

-- ---------------------------------------------------------------------------
-- 4. resolve_lot_by_sticker(p_raw_code TEXT, p_operator_id UUID)
-- ---------------------------------------------------------------------------
-- Bidder-facing sticker resolver. Builds `{op.code}:{raw}` from the bidder's
-- persisted preview operator (p_operator_id) and the raw scanned code, then
-- returns the matching lot REGARDLESS of auction status (the client routes
-- live→bid / else→watchlist). Returns the SAME safe-column allowlist as
-- resolve_lot_by_qr_token (0103) so the client reuses its typing + routing
-- verbatim. authenticated-only + per-bidder rate limit.
CREATE OR REPLACE FUNCTION public.resolve_lot_by_sticker(
  p_raw_code    TEXT,
  p_operator_id UUID
)
RETURNS TABLE (
  lot_id          UUID,
  lot_code        TEXT,
  operator_id     UUID,
  operator_code   TEXT,
  status          lot_status,
  auction_id      UUID,
  auction_status  TEXT,
  title           TEXT,
  thumbnail_url   TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bidder  UUID;
  v_op_code TEXT;
  v_clean   TEXT := TRIM(p_raw_code);
  v_full    TEXT;
  v_recent  INTEGER;
  -- Sliding-window throttle: generous for a human scanning physical labels,
  -- tight enough to block programmatic namespace enumeration.
  c_window  CONSTANT INTERVAL := INTERVAL '1 minute';
  c_max     CONSTANT INTEGER  := 40;
BEGIN
  v_bidder := auth.uid();
  IF v_bidder IS NULL THEN
    RETURN; -- no rows: unauthenticated
  END IF;

  -- Rate limit (self-trimming): purge this bidder's expired rows, count the
  -- rest, reject if over budget, else record this call. An over-budget call
  -- RAISEs before its INSERT, so abusive traffic can't grow the log.
  DELETE FROM bidder_sticker_scan_log
   WHERE bidder_id = v_bidder AND scanned_at < now() - c_window;
  SELECT count(*) INTO v_recent
    FROM bidder_sticker_scan_log WHERE bidder_id = v_bidder;
  IF v_recent >= c_max THEN
    RAISE EXCEPTION 'Too many scans — wait a moment and try again.'
      USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO bidder_sticker_scan_log (bidder_id) VALUES (v_bidder);

  -- Need a valid operator context (the persisted preview check-in).
  SELECT code INTO v_op_code FROM operators WHERE id = p_operator_id;
  IF v_op_code IS NULL THEN
    RETURN; -- no rows: unknown / blank operator context
  END IF;

  -- Validate the raw code (mirror claim_sticker_code's guards).
  IF v_clean IS NULL OR LENGTH(v_clean) = 0 THEN RETURN; END IF;
  IF LENGTH(v_clean) > 200 THEN RETURN; END IF;
  IF v_clean LIKE '%:%' THEN RETURN; END IF; -- raw can't contain the namespace ':'

  v_full := v_op_code || ':' || v_clean;

  RETURN QUERY
  SELECT
    l.id,
    l.lot_code,
    l.operator_id,
    o.code,
    l.status,
    l.auction_id,
    a.status::TEXT,
    l.title,
    -- First photo as a thumbnail; empty arrays return NULL safely.
    (CASE WHEN array_length(l.photo_urls, 1) >= 1 THEN l.photo_urls[1] END)::TEXT
  FROM lots l
  JOIN operators o ON o.id = l.operator_id
  LEFT JOIN auctions a ON a.id = l.auction_id
  WHERE l.sticker_code = v_full
    AND l.operator_id = p_operator_id
    AND l.deleted_at IS NULL
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_lot_by_sticker(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_lot_by_sticker(TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION public.resolve_lot_by_sticker(TEXT, UUID) IS
  '0150 (Option C): bidder-facing resolver for an operator''s own physical '
  'sticker codes. Builds `{op.code}:{raw}` from the bidder''s persisted '
  'preview operator + the raw scan, returns the lot regardless of auction '
  'status (client routes live→bid / else→watchlist), safe-column allowlist '
  'only (mirrors resolve_lot_by_qr_token). authenticated-only + per-bidder '
  'rate limit.';
