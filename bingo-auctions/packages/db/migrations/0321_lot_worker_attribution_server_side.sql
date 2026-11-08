-- 0321 — attribute lots to the PIN worker on the SERVER, in the same
-- transaction that mints the lot, for BOTH create paths.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
-- Worker Productivity (#254) reads lots.lotted_by_worker — the only column that
-- names a person. lots.lotted_by is auth.uid() of the shared station account and
-- has exactly ONE distinct value across 5,234 prod lots.
--
-- Measured on prod, lots created in the 7 days to 2026-08-14:
--
--   created via                          lots   with worker    pct
--   relist_lot_into_auction ............ 1,095            0    0.0%
--   create_draft_lot ................... 1,191          736   61.8%
--   TOTAL .............................. 2,286          736   32.2%
--
-- Two separate faults, and the bigger one was invisible until the split was
-- measured:
--
--   1. RELISTS WERE NEVER ATTRIBUTED AT ALL. relist_lot_into_auction does not
--      touch lotted_by_worker, and relisting is 48% of the week's lot volume.
--      No amount of fixing the other path could get past a ~52% ceiling.
--
--   2. FRESH LOTS were attributed by a fire-and-forget follow-up UPDATE in
--      packages/domain-lotting/src/persistence.ts:
--
--        void supabase.from('lots').update({ lotted_by_worker: _activeWorkerId })
--          .eq('id', lotId).then(undefined, () => {});   // failures discarded
--
--      A second round-trip from a warehouse phone on bad wifi, with the promise
--      voided and rejections swallowed — a dropped write is indistinguishable
--      from success, nothing retries, nothing logs. Hence 61.8%, not ~100%.
--
-- ── WHY OVERLOADS RATHER THAN REWRITING THE FUNCTIONS ────────────────────────
-- The obvious move is to add a defaulted parameter to each function and write
-- the worker directly in its INSERT. That requires DROP + CREATE (a defaulted
-- extra arg makes every existing call ambiguous, 42725), which means
-- reproducing create_draft_lot's 7KB body and relist_lot_into_auction's ~300
-- lines of lineage/sticker-carryover logic by hand. Both are the warehouse's
-- hot path; a transcription slip there costs more than this feature is worth.
--
-- Instead each gets a NEW overload with one ADDITIONAL REQUIRED argument.
-- Overload resolution is unambiguous — the existing arities keep resolving to
-- the existing functions, untouched — and the delegating call plus the stamp
-- run inside a single transaction, so the attribution is atomic with the lot.
-- That is the property the client-side UPDATE never had.
--
-- ── ATTRIBUTION NEVER BLOCKS A LOT CREATE ────────────────────────────────────
-- An unknown / wrong-operator / inactive worker id resolves to NULL rather than
-- raising. Lotting is the floor's hot path; refusing to mint a lot because a
-- clock-in went stale would trade a reporting gap for a work stoppage. Dropped
-- attribution is already visible — Worker Productivity prints live coverage and
-- states the uncounted lots are absent rather than misattributed.
--
-- The worker id is VALIDATED, not trusted: both wrappers are SECURITY DEFINER,
-- so a client cannot attribute work to another operator's worker.
--
-- Neither wrapper ever overwrites an existing attribution — first writer wins.

BEGIN;

-- ── Shared resolver ──────────────────────────────────────────────────────────
-- Returns the worker id only when it belongs to the caller's operator and is
-- active; NULL otherwise. STABLE + SECURITY DEFINER so it sees workers rows
-- regardless of the caller's RLS.
CREATE OR REPLACE FUNCTION public.resolve_active_worker(p_worker_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_op UUID;
  v_worker_id UUID;
BEGIN
  IF p_worker_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_caller_op := current_operator_id();
  IF v_caller_op IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT w.id INTO v_worker_id
    FROM workers w
   WHERE w.id = p_worker_id
     AND w.operator_id = v_caller_op
     AND w.is_active
   LIMIT 1;

  RETURN v_worker_id;
END;
$function$;

COMMENT ON FUNCTION public.resolve_active_worker(uuid) IS
  '0321: validate a PIN worker id against the calling operator. NULL when '
  'unknown, foreign, or inactive — callers treat attribution as best-effort.';

-- ── create_draft_lot: 23-arg overload ────────────────────────────────────────
-- The existing 22-arg function is untouched and still resolves for any caller
-- that omits the worker (operator-web imports, scripts, tests).
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
  p_brand              text,
  p_model              text,
  p_asin               text,
  p_fnsku              text,
  p_lpn                text,
  p_vendor             text,
  p_product_sku        text,
  p_site_sku           text,
  p_manufacture_sku    text,
  p_import_row_id      uuid,
  p_client_token       uuid,
  p_lotted_by_worker   uuid
)
RETURNS TABLE(out_id uuid, out_lot_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_worker_id UUID;
  v_out_id    UUID;
  v_out_code  TEXT;
BEGIN
  v_worker_id := public.resolve_active_worker(p_lotted_by_worker);

  -- Delegate to the canonical 22-arg implementation. Same transaction, so the
  -- stamp below either commits with the lot or not at all.
  SELECT c.out_id, c.out_lot_code
    INTO v_out_id, v_out_code
    FROM public.create_draft_lot(
      p_operator_id, p_title, p_description, p_category, p_category_id,
      p_condition, p_msrp_cents, p_starting_bid_cents, p_photo_urls,
      p_external_code, p_source, p_brand, p_model, p_asin, p_fnsku, p_lpn,
      p_vendor, p_product_sku, p_site_sku, p_manufacture_sku,
      p_import_row_id, p_client_token
    ) AS c;

  -- IS NULL guard: the delegate short-circuits to an EXISTING lot on both
  -- idempotency paths (client token, import row). Backfilling attribution there
  -- is correct — a retry after clock-in should land — but re-attributing a lot
  -- that already names someone is not. First writer wins.
  IF v_worker_id IS NOT NULL AND v_out_id IS NOT NULL THEN
    UPDATE lots
       SET lotted_by_worker = v_worker_id
     WHERE id = v_out_id
       AND lotted_by_worker IS NULL;
  END IF;

  out_id := v_out_id;
  out_lot_code := v_out_code;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[], text,
  text, text, text, text, text, text, text, text, text, text, uuid, uuid, uuid
) IS
  '0321: create_draft_lot + PIN-worker attribution, atomic in one transaction. '
  'Delegates to the 22-arg implementation; validates the worker against the '
  'caller''s operator; never overwrites an existing attribution.';

-- ── relist_lot_into_auction: 3-arg overload ──────────────────────────────────
-- This is the 48%-of-volume path that was never attributed at all.
CREATE OR REPLACE FUNCTION public.relist_lot_into_auction(
  p_lot_id           uuid,
  p_auction_id       uuid,
  p_lotted_by_worker uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_worker_id  UUID;
  v_new_lot_id UUID;
BEGIN
  v_worker_id := public.resolve_active_worker(p_lotted_by_worker);

  v_new_lot_id := public.relist_lot_into_auction(p_lot_id, p_auction_id);

  IF v_worker_id IS NOT NULL AND v_new_lot_id IS NOT NULL THEN
    UPDATE lots
       SET lotted_by_worker = v_worker_id
     WHERE id = v_new_lot_id
       AND lotted_by_worker IS NULL;
  END IF;

  RETURN v_new_lot_id;
END;
$function$;

COMMENT ON FUNCTION public.relist_lot_into_auction(uuid, uuid, uuid) IS
  '0321: relist + PIN-worker attribution, atomic in one transaction. Relisting '
  'is ~48% of daily lot volume and carried no worker attribution before this.';

GRANT EXECUTE ON FUNCTION public.resolve_active_worker(uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[], text,
  text, text, text, text, text, text, text, text, text, text, uuid, uuid, uuid
) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.relist_lot_into_auction(uuid, uuid, uuid)
  TO authenticated, service_role;

COMMIT;
