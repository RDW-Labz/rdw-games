-- migration 0190 — find_import_row_by_scan(p_candidates, p_kind) typed-field overload
--
-- WHY (Stream D.1 — QuickLot typed-field search picker)
-- ---------------------------------------------------------------------------
-- The live matcher find_import_row_by_scan(text[]) (mig 0186) probes EVERY
-- identifier column (tracking_number / upc / asin / fnsku / lpn / external_code
-- / pallet_id / product_sku / site_sku / manufacture_sku) in priority order and
-- returns the first hit. That's the right default for a blind camera scan, but
-- it has no way to SCOPE the probe when the operator already knows what they're
-- holding — e.g. a Wayfair ProductSKU that happens to collide (as a substring or
-- exact value) with some other row's pallet_id or external_code would match the
-- wrong column. QuickLot now lets staff pick the field type from a chip row;
-- this overload lets them pass that choice through as p_kind so only the chosen
-- column is probed.
--
-- DESIGN — additive overload, zero copy-paste drift:
--   * The existing 1-arg find_import_row_by_scan(text[]) is left UNTOUCHED
--     (NOT dropped). Postgres resolves by arity, so both coexist.
--   * p_kind = 'auto' (the default) DELEGATES to the 1-arg body verbatim
--     (RETURN public.find_import_row_by_scan(p_candidates)) — so the default
--     path can never drift from the canonical multi-column matcher and any
--     future change to 0186's probe order/list is inherited for free.
--   * Any other p_kind probes ONLY the single column that kind maps to. This
--     mirrors the p_kind CASE selector pattern established in mig 0189
--     (find_lots_by_identifier).
--
-- COLUMN SCOPING — kept identical to 0186 so a scoped probe and the auto probe
-- agree on what counts as a match:
--   * operator-scoped: operator_id = public.current_operator_id()
--   * status = 'pending' (find_import_row_* only ever returns un-lotted rows)
--   * same auth + operator guards (auth.uid() / current_operator_id())
--   * SECURITY DEFINER + SET search_path = public (matches 0186)
--
-- TRACKING vs ID kinds (owner guardrail D.1.a):
--   * 'tracking' uses public._normalize_scan_candidates() suffix expansion AND
--     the mig-0156 token-LIKE fallback — byte-for-byte the same predicate as
--     probe #1 in 0186 — because a scanned/typed tracking number can be a
--     34-digit FedEx composite whose last-12 suffix is the stored value.
--   * Every ID kind (upc/asin/fnsku/lpn/external_code/pallet/product_sku/
--     site_sku/manufacture_sku/model/catalog) matches the RAW trimmed candidate
--     only — no suffix expansion — exactly as 0186 does for its non-tracking
--     probes (it CONTINUEs WHEN v_inner <> v_clean before those columns).
--
-- KIND → COLUMN map (p_kind, case-insensitive, trimmed):
--   upc            → upc
--   asin           → asin
--   fnsku          → fnsku
--   lpn            → lpn
--   external_code  → external_code
--   pallet         → pallet_id
--   product_sku    → product_sku
--   site_sku       → site_sku
--   manufacture_sku→ manufacture_sku
--   model          → manufacture_sku   (manufacturer Model/MPN lives here)
--   catalog        → catalog_id
--   tracking       → tracking_number   (suffix-expanded, token-LIKE fallback)
--   auto / unknown → delegate to the 1-arg multi-column matcher (0186)
--
-- RETURN SHAPE — identical to 0186:
--   { ok:true,  manifest_row:<row jsonb>, matched_field:'<column>' } on hit
--   { ok:false, reason:'not_authenticated' | 'not_operator_staff'
--                     | 'manifest_row_not_found' } otherwise
--
-- Risk: low. Pure additive overload; no schema change, no data write, no change
-- to the existing 1-arg function or any policy.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.find_import_row_by_scan(
  p_candidates text[],
  p_kind       text DEFAULT 'auto'
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_op       UUID := public.current_operator_id();
  v_kind     TEXT := lower(trim(COALESCE(p_kind, 'auto')));
  v_row      import_rows%ROWTYPE;
  v_cand     TEXT;
  v_clean    TEXT;
  v_expanded TEXT[];
  v_inner    TEXT;
BEGIN
  -- 'auto' (and NULL) → delegate to the canonical multi-column matcher (0186)
  -- VERBATIM. Done before the auth/operator guards because the 1-arg body
  -- performs them itself — re-checking here would be redundant, and delegating
  -- first guarantees zero behavioural drift from the default path.
  IF v_kind = 'auto' THEN
    RETURN public.find_import_row_by_scan(p_candidates);
  END IF;

  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  IF v_op IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  FOREACH v_cand IN ARRAY p_candidates LOOP
    v_clean := TRIM(v_cand);
    IF v_clean IS NULL OR LENGTH(v_clean) = 0 THEN
      CONTINUE;
    END IF;

    -- ── tracking: suffix-expanded + token-LIKE fallback (mirrors 0186 probe #1)
    IF v_kind = 'tracking' THEN
      -- Server-side candidate expansion (0163): even if the client sends only
      -- the raw 34-digit composite, probe the last-12 suffix too.
      v_expanded := public._normalize_scan_candidates(v_clean);
      FOREACH v_inner IN ARRAY v_expanded LOOP
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op
           AND status = 'pending'
           AND (
             tracking_number = v_inner
             OR (LENGTH(v_inner) >= 12 AND (
               tracking_number LIKE v_inner || ' %'
               OR tracking_number LIKE '% ' || v_inner
               OR tracking_number LIKE '% ' || v_inner || ' %'
               OR tracking_number LIKE v_inner || ',%'
               OR tracking_number LIKE '%,' || v_inner
               OR tracking_number LIKE '%,' || v_inner || ',%'
             ))
           )
         ORDER BY (tracking_number = v_inner) DESC, created_at ASC
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'tracking_number');
        END IF;
      END LOOP; -- v_expanded
      CONTINUE; -- next candidate; tracking kind never falls through to ID probes
    END IF;

    -- ── ID kinds: match the RAW trimmed candidate only (no suffix expansion).
    -- One scoped probe per kind. Oldest pending row wins for the columns that
    -- can legitimately repeat across units (asin/product_sku/site_sku/
    -- manufacture_sku), matching 0186; the unique-ish identity columns
    -- (upc/fnsku/lpn/external_code/pallet_id/catalog_id) take a bare LIMIT 1.
    CASE v_kind
      WHEN 'upc' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND upc = v_clean
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'upc');
        END IF;

      WHEN 'asin' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND asin = v_clean
         ORDER BY created_at ASC
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'asin');
        END IF;

      WHEN 'fnsku' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND fnsku = v_clean
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'fnsku');
        END IF;

      WHEN 'lpn' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND lpn = v_clean
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'lpn');
        END IF;

      WHEN 'external_code' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND external_code = v_clean
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'external_code');
        END IF;

      WHEN 'pallet' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND pallet_id = v_clean
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'pallet_id');
        END IF;

      WHEN 'product_sku' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND product_sku = v_clean
         ORDER BY created_at ASC
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'product_sku');
        END IF;

      WHEN 'site_sku' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND site_sku = v_clean
         ORDER BY created_at ASC
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'site_sku');
        END IF;

      -- 'manufacture_sku' and 'model' both resolve to the manufacture_sku column
      -- (the manufacturer Model / MPN is stored there per 0186), mirroring how
      -- 0189 folds 'model' onto lots.model/mpn.
      WHEN 'manufacture_sku', 'model' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND manufacture_sku = v_clean
         ORDER BY created_at ASC
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'manufacture_sku');
        END IF;

      WHEN 'catalog' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND catalog_id = v_clean
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'catalog_id');
        END IF;

      ELSE
        -- Unrecognised explicit kind: no column to probe. Don't silently fall
        -- back to multi-column (the caller asked to scope) — just no-match.
        NULL;
    END CASE;

  END LOOP; -- p_candidates

  RETURN jsonb_build_object('ok', false, 'reason', 'manifest_row_not_found');
END $function$;

COMMENT ON FUNCTION public.find_import_row_by_scan(text[], text) IS
  'Stream D.1 (mig 0190). Typed-field overload of find_import_row_by_scan. '
  'p_kind=auto (default) delegates verbatim to the 1-arg multi-column matcher '
  '(mig 0186) for zero drift; any other kind probes ONLY that column, '
  'operator-scoped + status=pending, SECURITY DEFINER. '
  'tracking uses _normalize_scan_candidates suffix expansion + token-LIKE '
  'fallback (mirrors 0186 probe #1); ID kinds match the raw trimmed candidate '
  'only. Kinds: auto | upc | asin | fnsku | lpn | external_code | pallet '
  '(pallet_id) | product_sku | site_sku | manufacture_sku | model '
  '(manufacture_sku) | catalog (catalog_id) | tracking (tracking_number). '
  'Same { ok, manifest_row, matched_field } / { ok:false, reason } shape as 0186.';

-- Grant to authenticated (operator staff). RLS / the SECURITY DEFINER operator
-- guard still scope rows to current_operator_id(). Mirrors the 0186 grant.
GRANT EXECUTE ON FUNCTION public.find_import_row_by_scan(text[], text) TO authenticated;
