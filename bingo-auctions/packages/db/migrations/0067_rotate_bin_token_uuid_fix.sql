-- ============================================================================
-- 0067_rotate_bin_token_uuid_fix
--
-- Bug found by mega-sim Phase 1 binsmith tests: rotate_bin_token (from
-- 0064) raises 42883 "function uuid_generate_v4() does not exist".
--
-- Why: 0064 set `SET search_path = public` on rotate_bin_token but
-- called uuid_generate_v4() directly. In Supabase, the uuid-ossp
-- extension is installed in the `extensions` schema, not `public`.
-- The pinned search_path hides it.
--
-- Other RPCs that mint UUIDs (create_draft_lot, etc.) don't trip this
-- because they don't call uuid_generate_v4() directly — they rely on
-- column DEFAULT uuid_generate_v4() which is evaluated in the
-- column's default expression context, not the function body's.
--
-- Fix: replace with gen_random_uuid() which is built into PostgreSQL
-- 13+ (no extension needed) and is the modern preferred function for
-- UUID generation. Same output guarantees. Both Supabase and local
-- Postgres 14+ install gen_random_uuid() into the pg_catalog schema
-- which is implicitly on every search_path.
-- ============================================================================

CREATE OR REPLACE FUNCTION rotate_bin_token(p_bin_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller       UUID := auth.uid();
  v_operator_id  UUID;
  v_role         operator_user_role;
  v_bin_operator UUID;
  -- 0067: was uuid_generate_v4() — fails because the extension is in
  -- the `extensions` schema and SET search_path = public hides it.
  -- gen_random_uuid() is built into Postgres 13+ (pg_catalog) and
  -- always resolvable regardless of search_path.
  v_new_token    UUID := gen_random_uuid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT operator_id, role INTO v_operator_id, v_role
  FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_operator_id IS NULL THEN
    RAISE EXCEPTION 'not_staff' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'admin_or_manager_required' USING ERRCODE = '42501';
  END IF;

  SELECT w.operator_id INTO v_bin_operator
  FROM bins b JOIN warehouses w ON w.id = b.warehouse_id
  WHERE b.id = p_bin_id LIMIT 1;
  IF v_bin_operator IS NULL THEN
    RAISE EXCEPTION 'bin_not_found' USING ERRCODE = '02000';
  END IF;
  IF v_bin_operator <> v_operator_id THEN
    RAISE EXCEPTION 'bin_other_operator' USING ERRCODE = '42501';
  END IF;

  UPDATE bins
     SET qr_token        = v_new_token,
         qr_rotated_at   = now(),
         qr_revoked_at   = NULL,
         qr_revoked_by   = NULL,
         qr_revoked_reason = NULL
   WHERE id = p_bin_id;

  RETURN v_new_token;
END;
$$;

REVOKE ALL ON FUNCTION rotate_bin_token(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotate_bin_token(UUID) TO authenticated;
