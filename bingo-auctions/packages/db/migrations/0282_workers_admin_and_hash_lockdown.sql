-- 0282_workers_admin_and_hash_lockdown.sql — Phase 3 support + a security fix.
--
-- SECURITY FIX: 0281's workers_select_same_operator RLS policy let any staff of
-- the operator SELECT the whole workers table — INCLUDING pin_hash. A 4-8 digit
-- PIN is trivially brute-forced offline from a bcrypt hash, so the hash must
-- never be client-readable. Remove direct client SELECT entirely; all reads go
-- through the SECURITY DEFINER RPCs (list_active_workers for the clock-in picker,
-- list_workers_admin for the manager console), neither of which returns pin_hash.
-- RPCs are SECURITY DEFINER so they bypass RLS and keep working.

BEGIN;

DROP POLICY IF EXISTS workers_select_same_operator ON public.workers;

-- Manager-facing roster for the operator console: includes inactive workers and
-- lock state, never the hash. Manager/admin only.
CREATE OR REPLACE FUNCTION public.list_workers_admin(p_operator_id uuid)
RETURNS TABLE(
  id uuid, display_name text, role operator_user_role,
  is_active boolean, locked_until timestamptz, created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  PERFORM public._require_manager(p_operator_id);
  RETURN QUERY
    SELECT w.id, w.display_name, w.role, w.is_active, w.locked_until, w.created_at
      FROM public.workers w
     WHERE w.operator_id = p_operator_id
     ORDER BY w.is_active DESC, lower(w.display_name);
END;
$$;

-- Toggle a worker active/inactive. Reactivating clears any failed-attempt lock.
CREATE OR REPLACE FUNCTION public.set_worker_active(p_worker_id uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_operator uuid;
BEGIN
  SELECT operator_id INTO v_operator FROM public.workers WHERE id = p_worker_id;
  IF v_operator IS NULL THEN
    RAISE EXCEPTION 'worker_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._require_manager(v_operator);
  UPDATE public.workers
     SET is_active = p_active,
         failed_attempts = CASE WHEN p_active THEN 0 ELSE failed_attempts END,
         locked_until    = CASE WHEN p_active THEN NULL ELSE locked_until END,
         updated_at = now()
   WHERE id = p_worker_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.list_workers_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_worker_active(uuid, boolean) TO authenticated;

COMMIT;
