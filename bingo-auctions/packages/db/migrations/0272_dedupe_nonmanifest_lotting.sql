-- 0272 — kill NON-manifest duplicate lots (client idempotency token)
--
-- Owner incident, 2026-07-16: lotter scanned legacy code GRA3735862 and the
-- "Bevington Dining Table" landed as TWO lots — BIN-002916 (kept the sticker,
-- got put away) + its orphan twin BIN-002917 — created 0.96s apart by the same
-- staffer. Verified against prod: 56 near-simultaneous same-title duplicate
-- PAIRS in 45 days, and EVERY one is on the non-manifest path (0 lots stamped
-- 'Wayfair-D2L', the only source the manifest-scan path writes). Breakdown by
-- source: (null) 23 [operator-web Quick Lot double-submit], BRN 17, Wayfair 13,
-- Relot Sedalia 2 [today], Lowes 1.
--
-- WHY 0269 (PR #202) DOESN'T COVER THIS: 0269 makes create_draft_lot idempotent
-- ONLY when p_import_row_id is supplied — its own header says "NULL preserves
-- the exact prior behavior for non-manifest lotting (AI scan / catalog / bare /
-- manual)". None of the 56 real duplicates pass an import_row_id, so 0269 (once
-- deployed) would still mint every one of them. The duplicate the owner hit is
-- exactly this uncovered class.
--
-- ROOT CAUSE (two un-guarded vectors, both verified in code):
--   * field-mobile Quick Lot (quick.tsx): the 2s auto-create timer is NOT
--     cancelled when a manual/photo save fires, so a manual save that commits
--     before the timer fires yields a second create for the same item. The
--     ref mutex only serialises CONCURRENT calls, not a late sequential one.
--   * operator-web createQuickLot / web.tsx: plain next_lot_code + direct
--     INSERT with NO guard at all — a double-click on "Create" mints two lots.
--
-- FIX (mirrors the charge-idempotency-replay pattern from 0271): a
-- client-generated idempotency token, one per intended lot, carried through
-- every create path. A retried/double-fired save reuses the SAME token, so the
-- second create returns the first lot instead of a twin. Enforced by a unique
-- partial index so it holds even under true concurrency. Two genuinely distinct
-- units get two different tokens and are unaffected (0058's "identical items are
-- legit two lots" invariant is preserved — the token keys the ACTION, not the
-- item).
--
-- SELF-CONTAINED / #202-SAFE: this recreates create_draft_lot as a 22-arg
-- SUPERSET that folds in 0269's manifest idempotency (p_import_row_id) verbatim
-- AND adds p_client_token. It DROPs both the 0188 (20-arg) and 0269 (21-arg)
-- signatures first, so it produces one correct function whether or not 0269 has
-- been applied. Both new args DEFAULT NULL, so existing 20-/21-arg callers keep
-- working untouched.
--   ⚠ APPLY ORDER vs #202: 0272 SUPERSEDES 0269's create_draft_lot. If both are
--     applied, apply 0269 BEFORE 0272 (filename order already guarantees this).
--     Do NOT apply 0269 after 0272 — that would re-introduce the 21-arg overload
--     alongside this 22-arg one and make a 21-arg call ambiguous.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS, CREATE UNIQUE INDEX IF NOT
-- EXISTS, CREATE OR REPLACE. Safe to apply ahead of the client code.

BEGIN;

-- 1. Idempotency token column + uniqueness -----------------------------------
ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS client_dedup_token uuid;

COMMENT ON COLUMN public.lots.client_dedup_token IS
  '0272: per-create-action idempotency token from the client. A retried or '
  'double-fired save reuses the same token so the second create returns the '
  'first lot instead of a duplicate. NULL for legacy rows and any path that '
  'does not supply one (dedup simply no-ops there).';

-- Partial unique index: scoped per operator, only for non-null tokens (so the
-- unbounded NULL rows are unconstrained, exactly like import_rows_tracking).
CREATE UNIQUE INDEX IF NOT EXISTS lots_client_dedup_token_uniq
  ON public.lots (operator_id, client_dedup_token)
  WHERE client_dedup_token IS NOT NULL;

-- 2. create_draft_lot — 22-arg superset --------------------------------------
-- Drop the prior signatures so exactly one overload remains after this runs.
DROP FUNCTION IF EXISTS public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text, text, text, text
);
DROP FUNCTION IF EXISTS public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text, text, text, text, uuid
);

CREATE OR REPLACE FUNCTION public.create_draft_lot(
  p_operator_id        uuid,
  p_title              text,
  p_description        text,
  p_category           text,
  p_category_id        uuid,
  p_condition          lot_condition,
  p_msrp_cents         bigint,
  p_starting_bid_cents bigint,
  p_photo_urls         text[],
  p_external_code      text,
  p_source             text,
  p_brand              text DEFAULT NULL,
  p_model              text DEFAULT NULL,
  p_asin               text DEFAULT NULL,
  p_fnsku              text DEFAULT NULL,
  p_lpn                text DEFAULT NULL,
  p_vendor             text DEFAULT NULL,
  p_product_sku        text DEFAULT NULL,
  p_site_sku           text DEFAULT NULL,
  p_manufacture_sku    text DEFAULT NULL,
  -- 0269: manifest provenance. When set, create is idempotent on this row and
  -- the pending->lotted flip happens atomically in this transaction.
  p_import_row_id      uuid DEFAULT NULL,
  -- 0272: client idempotency token. When set, create is idempotent on
  -- (operator_id, token) — a double-fired/retried save returns the first lot.
  p_client_token       uuid DEFAULT NULL
)
RETURNS TABLE(out_id uuid, out_lot_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_op       UUID;
  v_caller_uid      UUID;
  v_seq             BIGINT;
  v_op_code         TEXT;
  v_lot_code        TEXT;
  v_lot_id          UUID;
  v_existing_lot_id UUID;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'create_draft_lot: not authenticated' USING ERRCODE = '28000';
  END IF;

  v_caller_op := current_operator_id();
  IF v_caller_op IS NULL THEN
    RAISE EXCEPTION 'create_draft_lot: caller is not operator staff'
      USING ERRCODE = '42501';
  END IF;
  IF v_caller_op IS DISTINCT FROM p_operator_id THEN
    RAISE EXCEPTION 'create_draft_lot: caller % cannot create lot for operator %',
      v_caller_op, p_operator_id USING ERRCODE = '42501';
  END IF;

  -- 0272: client-token idempotency. Covers the NON-manifest paths (AI scan /
  -- catalog / bare / manual / operator-web). A prior — possibly double-fired —
  -- call with this same token already minted a lot; return it unchanged instead
  -- of inserting a twin. Checked before the manifest path so a token short-
  -- circuits regardless of whether an import row is also supplied.
  IF p_client_token IS NOT NULL THEN
    SELECT id INTO v_existing_lot_id
      FROM lots
     WHERE operator_id = v_caller_op
       AND client_dedup_token = p_client_token
     LIMIT 1;

    IF v_existing_lot_id IS NOT NULL THEN
      SELECT lots.lot_code INTO v_lot_code FROM lots WHERE lots.id = v_existing_lot_id;
      out_id := v_existing_lot_id;
      out_lot_code := v_lot_code;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  -- 0269: manifest idempotency. Lock the operator's import_row; if a lot was
  -- already minted for it (by a prior — possibly double-fired — call), return
  -- that lot unchanged instead of inserting a twin. The FOR UPDATE lock also
  -- serializes two concurrent calls for the same box: the loser waits, then
  -- sees lot_id set and returns it.
  IF p_import_row_id IS NOT NULL THEN
    SELECT lot_id INTO v_existing_lot_id
      FROM import_rows
     WHERE id = p_import_row_id
       AND operator_id = v_caller_op
     FOR UPDATE;

    IF v_existing_lot_id IS NOT NULL THEN
      SELECT lots.lot_code INTO v_lot_code FROM lots WHERE lots.id = v_existing_lot_id;
      out_id := v_existing_lot_id;
      out_lot_code := v_lot_code;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  -- 0066: NEW-VALUE RETURNING semantic aligned with next_lot_code.
  UPDATE operators
     SET next_lot_seq = next_lot_seq + 1
   WHERE id = p_operator_id
   RETURNING code, next_lot_seq INTO v_op_code, v_seq;

  IF v_op_code IS NULL THEN
    RAISE EXCEPTION 'create_draft_lot: operator % not found', p_operator_id
      USING ERRCODE = '02000';
  END IF;

  v_lot_code := v_op_code || '-' || lpad(v_seq::TEXT, 6, '0');

  -- 0154: vendor added alongside the previously-supported identity fields.
  -- 0188: product_sku / site_sku / manufacture_sku added the same way.
  -- 0272: client_dedup_token persisted so a later retry with the same token
  -- short-circuits above (and the unique index blocks a concurrent twin).
  -- Empty strings normalize to NULL so the lot_text_length CHECKs (0050) don't
  -- trip on "" extractions, matching brand/model/asin/fnsku/lpn handling.
  --
  -- The INSERT is wrapped so a genuinely CONCURRENT second call (same token,
  -- both past the pre-check before either committed) resolves to the winner via
  -- the unique index instead of surfacing a 23505 to the operator.
  BEGIN
    INSERT INTO lots (
      operator_id, auction_id, lot_number, warehouse_id,
      lot_code, title, description, category, category_id,
      condition, msrp_cents, starting_bid_cents, photo_urls,
      status, external_code, close_at, source,
      brand, model, asin, fnsku, lpn, vendor,
      product_sku, site_sku, manufacture_sku, client_dedup_token
    ) VALUES (
      p_operator_id, NULL, NULL, NULL,
      v_lot_code, p_title, p_description, p_category, p_category_id,
      COALESCE(p_condition, 'good'::lot_condition),
      p_msrp_cents, p_starting_bid_cents,
      COALESCE(p_photo_urls, ARRAY[]::TEXT[]),
      'pending_intake'::lot_status,
      p_external_code, NULL, p_source,
      NULLIF(TRIM(COALESCE(p_brand,  '')), ''),
      NULLIF(TRIM(COALESCE(p_model,  '')), ''),
      NULLIF(TRIM(COALESCE(p_asin,   '')), ''),
      NULLIF(TRIM(COALESCE(p_fnsku,  '')), ''),
      NULLIF(TRIM(COALESCE(p_lpn,    '')), ''),
      NULLIF(TRIM(COALESCE(p_vendor, '')), ''),
      NULLIF(TRIM(COALESCE(p_product_sku,     '')), ''),
      NULLIF(TRIM(COALESCE(p_site_sku,        '')), ''),
      NULLIF(TRIM(COALESCE(p_manufacture_sku, '')), ''),
      p_client_token
    )
    RETURNING lots.id INTO v_lot_id;
  EXCEPTION WHEN unique_violation THEN
    -- Only the dedup-token index can legitimately collide here (0058 dropped the
    -- external_code uniqueness). Return the lot the winning call inserted.
    IF p_client_token IS NOT NULL THEN
      SELECT id, lots.lot_code INTO v_existing_lot_id, v_lot_code
        FROM lots
       WHERE operator_id = v_caller_op
         AND client_dedup_token = p_client_token
       LIMIT 1;
      IF v_existing_lot_id IS NOT NULL THEN
        out_id := v_existing_lot_id;
        out_lot_code := v_lot_code;
        RETURN NEXT;
        RETURN;
      END IF;
    END IF;
    RAISE; -- not the dedup index — surface it
  END;

  -- 0269: atomic pending->lotted flip (replaces the fire-and-forget
  -- mark_import_row_lotted call in the client). Same transaction as the INSERT,
  -- so the row can never be re-matched by a second scan between create + flip.
  IF p_import_row_id IS NOT NULL THEN
    UPDATE import_rows
       SET status = 'lotted', lot_id = v_lot_id, lotted_at = now()
     WHERE id = p_import_row_id
       AND operator_id = v_caller_op
       AND lot_id IS NULL;
  END IF;

  -- 0076: heuristic backlink of recent unlinked ai_calls rows. See migration
  -- 0076 header for tradeoff rationale. SECURITY DEFINER + same-user filter
  -- (auth.uid()) means RLS doesn't block the UPDATE. Safe to no-op when the
  -- user has no recent unlinked AI activity.
  UPDATE ai_calls
     SET lot_id = v_lot_id
   WHERE user_id     = v_caller_uid
     AND operator_id = p_operator_id
     AND lot_id      IS NULL
     AND created_at  > NOW() - INTERVAL '2 minutes';

  out_id := v_lot_id;
  out_lot_code := v_lot_code;
  RETURN NEXT;
END;
$function$;

-- Re-grant on the new 22-arg signature exactly as create_draft_lot has always
-- been exposed (operator staff invoke it via the authenticated supabase client).
REVOKE ALL ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text, text, text, text, uuid, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text, text, text, text, uuid, uuid
) TO authenticated;

COMMENT ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[],
  text, text, text, text, text, text, text, text, text, text, text, uuid, uuid
) IS
  '0272: quick-lot draft creator. Mints lot_code, inserts a pending_intake lot. '
  'Idempotent on p_client_token (per-create-action token; kills non-manifest '
  'double-fire duplicates) AND on p_import_row_id (0269 manifest re-lot guard, '
  'folded in + atomic pending->lotted flip). Supersedes the 0269 21-arg form. '
  '0154+0188 identity fields intact.';

COMMIT;
