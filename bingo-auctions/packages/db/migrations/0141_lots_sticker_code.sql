-- migration 0141 — lots.sticker_code + claim_sticker_code RPC (W2-bonus)
--
-- Per docs/state/PLAN-field-mobile-restructure-2026-05-25.md W2-bonus:
--   "Global uniqueness preserved via operator-prefix on physical sticker
--    codes … even with collision-proof UUIDs today, add belt-and-suspenders
--    + enable LPN-as-pre-sticker safely."
--
-- ── Why a new column instead of reusing qr_token ──────────────────────────
-- `lots.qr_token` is a UUID (server-minted, globally unique by uniform
-- random distribution) used for the in-app sticker flow + public /l/{token}
-- URLs. Operators who buy generic pre-printed sticker rolls (BidFTA-style
-- workflow) already use it via `claim_prestickered_qr` (0110).
--
-- But operators may also want to use ARBITRARY operator-chosen physical
-- sticker schemes — most commonly the LPN that arrives on the manifest
-- pallet, OR a roll of pre-printed numbered stickers in their own format.
-- LPNs are not globally unique across operators (different vendors collide).
-- A raw operator-chosen string is not safe to write into qr_token (which
-- is typed UUID) and not safe to write into lot_code (which already has
-- the `{operator.code}-NNNNNN` semantic).
--
-- Solution: a third resolution lane — `sticker_code TEXT` — with format
-- `{operators.code}:{raw}`. Server-side, the RPC prefixes the operator's
-- code before storing, so:
--
--   * Operator RDW scans LPN "LPNABC123" → stored as "RDW:LPNABC123"
--   * Operator RDW scans UUID "550e..."  → stored as "RDW:550e..."
--   * Operator BIN scans LPN "LPNABC123" → stored as "BIN:LPNABC123"
--
-- `operators.code` is globally UNIQUE + CHECK-constrained to `^[A-Z0-9]{2,8}$`
-- (0021 lines 65-68). Since operator code can't contain ':', and we own
-- the prefix server-side, `{operators.code}:*` is globally unique by
-- construction regardless of what's on the right side of the colon.
--
-- ── Why a new RPC instead of widening claim_prestickered_qr ───────────────
-- claim_prestickered_qr takes a UUID and writes to lots.qr_token. Its
-- contract — "rotate this UUID to be this lot's qr_token, idempotently"
-- — is well-defined. Widening it to also handle non-UUID strings or to
-- write a different column would conflate two flows. Adding a sibling
-- RPC keeps each function single-purpose.
--
-- The lots.qr_token column STAYS, unchanged, for backward compatibility.
-- Existing pre-stickered lots are unaffected.
--
-- ── Resolution order in intake_lot_to_bin (W4, next migration) ────────────
-- W4 will tighten intake_lot_to_bin's resolution to:
--   1. lot_code  (globally unique via `{operator.code}-NNNNNN`)
--   2. qr_token  (UUID, globally unique by random distribution + UNIQUE index)
--   3. sticker_code  (globally unique via `{operator.code}:*` per this migration)
-- and DROP the LPN/FNSKU/ASIN/external_code/legacy_lot_code fall-throughs
-- (those move to the new `lot_from_manifest` RPC used by Lotting only).
-- See PLAN W4 for the rationale (silent-fail bug class).
--
-- ── Idempotent guards ─────────────────────────────────────────────────────
-- ADD COLUMN IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS / DO-block
-- around the CHECK constraint. Safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. lots.sticker_code TEXT — operator-prefixed unique physical sticker code
-- ---------------------------------------------------------------------------

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS sticker_code TEXT;

-- Format CHECK: when present, must contain ':'  and the prefix must match
-- the operators.code format `^[A-Z0-9]{2,8}$`. We don't FK-join to
-- operators.code here (it'd be expensive and the operator_id FK already
-- guarantees the lot belongs to a valid operator); we just enforce the
-- shape so a malformed sticker_code can't slip in.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'lots_sticker_code_format'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_sticker_code_format
      CHECK (
        sticker_code IS NULL
        OR sticker_code ~ '^[A-Z0-9]{2,8}:[^:].*$'
      );
  END IF;
END $$;

-- Global uniqueness via partial UNIQUE index (sparse — most lots will have
-- NULL sticker_code; only lots actually using the operator-chosen scheme
-- get a row in the index).
CREATE UNIQUE INDEX IF NOT EXISTS lots_sticker_code_unique_idx
  ON public.lots (sticker_code)
  WHERE sticker_code IS NOT NULL;

COMMENT ON COLUMN public.lots.sticker_code IS
  'Operator-chosen physical sticker code, namespaced as `{operators.code}:{raw}`. '
  'Globally unique via partial UNIQUE index. Server-side RPCs prefix the raw '
  'code with the calling operator''s code before storing — clients pass the '
  'raw value, never the prefix. NULL = no operator-chosen sticker on this lot '
  '(may still have qr_token from the generate/pre-printed-UUID flow). '
  'See migration 0141 and PLAN W2-bonus.';

COMMENT ON CONSTRAINT lots_sticker_code_format ON public.lots IS
  'W2-bonus: enforces `{operators.code}:{non-empty raw}` shape so malformed '
  'codes can''t slip in. operator-code prefix matches operators_code_format.';

-- ---------------------------------------------------------------------------
-- 2. lot_sticker_pool.sticker_code TEXT — for new pre-printed batches
-- ---------------------------------------------------------------------------
-- Per PLAN W2-bonus: "New rows for pre-printed UUID stickers store
-- `sticker_code = {operator.code}:{uuid}` going forward; old rows untouched".
-- Old rows (claimed pre-2026-05-25) keep working through qr_token. New
-- rows can be claimed via either qr_token (back-compat) or sticker_code.

ALTER TABLE public.lot_sticker_pool
  ADD COLUMN IF NOT EXISTS sticker_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS lot_sticker_pool_sticker_code_unique_idx
  ON public.lot_sticker_pool (sticker_code)
  WHERE sticker_code IS NOT NULL;

COMMENT ON COLUMN public.lot_sticker_pool.sticker_code IS
  'Operator-prefixed sticker code for pre-printed batches minted after W2-bonus. '
  'Older pool rows have NULL here and resolve via qr_token only. New '
  'mint_blank_qr_batch calls populate both qr_token (UUID) and sticker_code '
  '({operator.code}:{uuid}).';

-- ---------------------------------------------------------------------------
-- 3. claim_sticker_code RPC — bind a raw code to a lot
-- ---------------------------------------------------------------------------
-- Mirror of claim_prestickered_qr but for the sticker_code lane. Takes the
-- RAW operator-chosen string from the client (e.g. "LPNABC123" or a UUID
-- scanned from a pre-printed sticker), looks up the calling operator's
-- code, and stores `{operator.code}:{raw}`.
--
-- Validates:
--   - caller is operator staff
--   - lot belongs to caller's operator
--   - lot is not yet bound to a sticker_code (or is bound to the same one — idempotent)
--   - the new code isn't already used by another lot
--
-- If the operator pre-printed a UUID sticker (mint_blank_qr_batch), the
-- pool row's sticker_code is also marked claimed.

CREATE OR REPLACE FUNCTION claim_sticker_code(
  p_lot_id   UUID,
  p_raw_code TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id        UUID;
  v_op_code      TEXT;
  v_lot          lots%ROWTYPE;
  v_other_lot    UUID;
  v_clean_raw    TEXT := TRIM(p_raw_code);
  v_full_code    TEXT;
BEGIN
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  IF v_clean_raw IS NULL OR LENGTH(v_clean_raw) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_raw_code');
  END IF;

  -- Sanity cap on raw length. The format CHECK on the column doesn't bound
  -- length explicitly; we cap here to keep the column workable. 200 chars
  -- is generous (a UUID is 36 chars, an LPN is < 30, an EAN-13 is 13).
  IF LENGTH(v_clean_raw) > 200 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'raw_code_too_long');
  END IF;

  -- Reject if the raw code itself contains a colon — that would create
  -- ambiguity between operator prefix and operator-chosen content.
  IF v_clean_raw LIKE '%:%' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'raw_code_contains_colon');
  END IF;

  SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;
  IF v_op_code IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'operator_code_missing');
  END IF;

  v_full_code := v_op_code || ':' || v_clean_raw;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id;
  IF v_lot.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  IF v_lot.operator_id <> v_op_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_other_operator');
  END IF;

  -- Already bound to this exact code? Idempotent success.
  IF v_lot.sticker_code = v_full_code THEN
    RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id,
      'sticker_code', v_full_code, 'idempotent', true);
  END IF;

  -- Bound to a DIFFERENT sticker_code? Reject. Re-binding would orphan the
  -- old physical sticker — caller must explicitly rotate (separate RPC, TBD).
  IF v_lot.sticker_code IS NOT NULL AND v_lot.sticker_code <> v_full_code THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'lot_already_has_different_sticker',
      'existing_sticker_code', v_lot.sticker_code
    );
  END IF;

  -- Code used by another lot? Reject.
  SELECT id INTO v_other_lot
    FROM lots
    WHERE sticker_code = v_full_code AND id <> p_lot_id
    LIMIT 1;
  IF v_other_lot IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'sticker_code_already_used',
      'other_lot_id', v_other_lot
    );
  END IF;

  -- Mark pool row claimed if a pre-printed sticker matches (only relevant
  -- when the raw code was a UUID from a mint_blank_qr_batch batch).
  UPDATE lot_sticker_pool
     SET claimed_at = COALESCE(claimed_at, now()),
         claimed_by_lot_id = COALESCE(claimed_by_lot_id, p_lot_id)
   WHERE sticker_code = v_full_code
     AND operator_id = v_op_id
     AND claimed_at IS NULL;

  -- Write the lot's sticker_code.
  UPDATE lots
     SET sticker_code = v_full_code,
         updated_at = now()
   WHERE id = p_lot_id;

  RETURN jsonb_build_object(
    'ok', true,
    'lot_id', p_lot_id,
    'sticker_code', v_full_code,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION claim_sticker_code(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_sticker_code(UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION claim_sticker_code(UUID, TEXT) IS
  'W2-bonus: bind an operator-chosen RAW physical sticker code (LPN, '
  'pre-printed UUID, etc.) to a lot. Server-side prefixes with '
  '`{caller.operator.code}:` before storing. Idempotent on same code. '
  'Rejects rebinding to a different code (use a future rotate RPC for that).';

-- ---------------------------------------------------------------------------
-- 4. mint_blank_qr_batch — also populate sticker_code on new pool rows
-- ---------------------------------------------------------------------------
-- Per PLAN W2-bonus: new pre-printed batches should populate sticker_code
-- alongside qr_token so the pool row can be claimed via either path. Old
-- rows are left untouched (they have NULL sticker_code and remain
-- claimable via qr_token through claim_prestickered_qr as before).
--
-- This REPLACE keeps the function signature stable — callers (the
-- /api/lots/blank-qr-sheet route) need no changes.

CREATE OR REPLACE FUNCTION mint_blank_qr_batch(
  p_count INTEGER DEFAULT 50
)
RETURNS TABLE (
  batch_id  UUID,
  qr_tokens UUID[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id    UUID;
  v_op_code  TEXT;
  v_batch_id UUID := uuid_generate_v4();
  v_tokens   UUID[] := ARRAY[]::UUID[];
  v_token    UUID;
  i INTEGER;
BEGIN
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;
  IF p_count < 1 OR p_count > 500 THEN
    RAISE EXCEPTION 'invalid_count: 1-500 only' USING ERRCODE = 'P0001';
  END IF;

  SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;
  IF v_op_code IS NULL THEN
    RAISE EXCEPTION 'operator_code_missing' USING ERRCODE = 'P0001';
  END IF;

  FOR i IN 1..p_count LOOP
    v_token := uuid_generate_v4();
    INSERT INTO lot_sticker_pool
      (qr_token, sticker_code, operator_id, printed_batch_id, printed_by)
    VALUES
      (v_token, v_op_code || ':' || v_token::TEXT, v_op_id, v_batch_id, auth.uid());
    v_tokens := v_tokens || v_token;
  END LOOP;

  RETURN QUERY SELECT v_batch_id, v_tokens;
END;
$$;

REVOKE ALL ON FUNCTION mint_blank_qr_batch(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mint_blank_qr_batch(INTEGER) TO authenticated;

COMMENT ON FUNCTION mint_blank_qr_batch(INTEGER) IS
  'Mint N blank pre-printed UUID stickers for the caller''s operator. '
  'Each pool row gets BOTH qr_token (UUID) and sticker_code '
  '({operator.code}:{uuid}). Existing rows pre-W2-bonus have NULL '
  'sticker_code and remain claimable via qr_token only.';

COMMIT;
