/*
# BinGo Training Hub — Employee visibility fix
1. Restrict profiles SELECT to self or managers. The manager check uses a
   SECURITY DEFINER helper so the policy does not recurse into profiles RLS.
2. employee_training: only active employees, and an assignment with both an
   empty job title and empty location now means "everyone".
*/

CREATE OR REPLACE FUNCTION is_manager()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'manager'
  );
$$;
REVOKE EXECUTE ON FUNCTION is_manager() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_manager() TO authenticated;

DROP POLICY IF EXISTS "profiles_select_all" ON profiles;
DROP POLICY IF EXISTS "profiles_select_self_or_mgr" ON profiles;
CREATE POLICY "profiles_select_self_or_mgr" ON profiles FOR SELECT
  TO authenticated USING (auth.uid() = id OR is_manager());

CREATE OR REPLACE VIEW employee_training AS
SELECT
  e.id AS employee_id,
  e.full_name AS employee_name,
  e.job_title,
  e.location,
  a.id AS assignment_id,
  l.id AS lesson_id,
  l.title AS lesson_title,
  c.name AS category_name,
  c.sort_order AS category_sort,
  l.sort_order AS lesson_sort,
  a.assigned_version,
  l.version AS current_version,
  a.due_date,
  l.requires_practical,
  COALESCE(p.quiz_passed,false) AS quiz_passed,
  COALESCE(p.acknowledged,false) AS acknowledged,
  COALESCE(p.practical_signed_off,false) AS practical_signed_off,
  COALESCE(p.qualified,false) AS qualified,
  COALESCE(p.completed_version,0) AS completed_version,
  COALESCE(p.quiz_score,0) AS quiz_score,
  COALESCE(p.quiz_total,0) AS quiz_total,
  CASE WHEN a.assigned_version > COALESCE(p.completed_version,0) THEN true ELSE false END AS retraining_required
FROM profiles e
JOIN assignments a ON
  (a.assignee_id = e.id)
  OR (a.assignee_id IS NULL AND a.job_title = e.job_title AND a.location = e.location)
  OR (a.assignee_id IS NULL AND a.job_title = e.job_title AND a.location = '')
  OR (a.assignee_id IS NULL AND a.job_title = '' AND a.location = e.location)
  OR (a.assignee_id IS NULL AND a.job_title = '' AND a.location = '')
JOIN lessons l ON l.id = a.lesson_id
JOIN categories c ON c.id = l.category_id
LEFT JOIN lesson_progress p ON p.lesson_id = l.id AND p.employee_id = e.id
WHERE e.active = true AND e.role = 'employee';

ALTER VIEW employee_training SET (security_invoker = true);
GRANT SELECT ON employee_training TO authenticated;
