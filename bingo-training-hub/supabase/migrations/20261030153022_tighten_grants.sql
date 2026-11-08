/*
# BinGo Training Hub — Tighten grants & add profile management
1. Revoke all anon privileges (sign-in app). Revoke broad authenticated grants
   where column-level restrictions are needed.
2. profiles: employees UPDATE only (full_name). Managers update profiles via
   the new update_employee_profile() SECURITY DEFINER function (sets role, job,
   location, active, full_name for any employee — role is privileged).
3. lesson_progress: authenticated UPDATE only the non-privileged columns.
4. employee_training view: set security_invoker = true so RLS on underlying
   tables applies.
*/

-- Revoke anon everywhere
REVOKE ALL ON profiles FROM anon;
REVOKE ALL ON categories FROM anon;
REVOKE ALL ON lessons FROM anon;
REVOKE ALL ON assignments FROM anon;
REVOKE ALL ON lesson_progress FROM anon;
REVOKE ALL ON employee_training FROM anon;

-- profiles: narrow authenticated to SELECT + UPDATE(full_name)
REVOKE UPDATE ON profiles FROM authenticated;
GRANT UPDATE (full_name) ON profiles TO authenticated;

-- lesson_progress: narrow authenticated UPDATE to non-privileged columns
REVOKE UPDATE ON lesson_progress FROM authenticated;
GRANT UPDATE (quiz_score, quiz_total, quiz_passed, acknowledged, acknowledged_at, completed_version, last_attempt_at) ON lesson_progress TO authenticated;
-- INSERT also needs to be column-scoped so employees can't set sign-off cols
REVOKE INSERT ON lesson_progress FROM authenticated;
GRANT INSERT (employee_id, lesson_id, quiz_score, quiz_total, quiz_passed, acknowledged, acknowledged_at, completed_version, last_attempt_at) ON lesson_progress TO authenticated;

-- Manager profile-management function (privileged columns live here)
CREATE OR REPLACE FUNCTION update_employee_profile(
  p_employee_id uuid,
  p_full_name text,
  p_role text,
  p_job_title text,
  p_location text,
  p_active boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_is_manager boolean;
BEGIN
  SELECT role = 'manager' INTO v_is_manager FROM profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_is_manager, false) THEN
    RAISE EXCEPTION 'Only managers can edit employee profiles';
  END IF;
  IF p_role NOT IN ('employee','manager') THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;
  UPDATE profiles
  SET full_name = p_full_name, role = p_role, job_title = p_job_title,
      location = p_location, active = p_active
  WHERE id = p_employee_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION update_employee_profile(uuid, text, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION update_employee_profile(uuid, text, text, text, text, boolean) TO authenticated;

-- View: security invoker so underlying RLS applies
ALTER VIEW employee_training SET (security_invoker = true);
