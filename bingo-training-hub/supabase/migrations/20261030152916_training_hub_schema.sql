/*
# BinGo Training Hub — Core Schema (fix pass)
Fixes typo in lessons_read policy. Re-runs all DDL idempotently.
*/

-- ===== profiles =====
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'employee' CHECK (role IN ('employee','manager')),
  job_title text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- ===== categories =====
CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

-- ===== lessons =====
CREATE TABLE IF NOT EXISTS lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  video_url text NOT NULL DEFAULT '',
  screenshot_urls text[] NOT NULL DEFAULT '{}',
  requires_practical boolean NOT NULL DEFAULT false,
  practical_notes text NOT NULL DEFAULT '',
  quiz_questions jsonb NOT NULL DEFAULT '[]',
  passing_score int NOT NULL DEFAULT 1,
  version int NOT NULL DEFAULT 1,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lessons ENABLE ROW LEVEL SECURITY;

-- ===== assignments =====
CREATE TABLE IF NOT EXISTS assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  assignee_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  job_title text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  assigned_version int NOT NULL DEFAULT 1,
  due_date date,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;

-- ===== lesson_progress =====
CREATE TABLE IF NOT EXISTS lesson_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  lesson_id uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  quiz_score int NOT NULL DEFAULT 0,
  quiz_total int NOT NULL DEFAULT 0,
  quiz_passed boolean NOT NULL DEFAULT false,
  acknowledged boolean NOT NULL DEFAULT false,
  acknowledged_at timestamptz,
  practical_signed_off boolean NOT NULL DEFAULT false,
  signed_off_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  signed_off_at timestamptz,
  qualified boolean NOT NULL DEFAULT false,
  completed_version int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, lesson_id)
);
ALTER TABLE lesson_progress ENABLE ROW LEVEL SECURITY;

-- ===== qualified recompute trigger =====
CREATE OR REPLACE FUNCTION recompute_qualified()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_requires_practical boolean;
BEGIN
  SELECT requires_practical INTO v_requires_practical FROM lessons WHERE id = NEW.lesson_id;
  NEW.qualified := NEW.quiz_passed AND NEW.acknowledged
    AND (NOT v_requires_practical OR NEW.practical_signed_off);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_qualified_on_progress ON lesson_progress;
CREATE TRIGGER set_qualified_on_progress
BEFORE INSERT OR UPDATE ON lesson_progress
FOR EACH ROW EXECUTE FUNCTION recompute_qualified();

-- ===== sign-off function (privileged) =====
CREATE OR REPLACE FUNCTION sign_off_practical(p_progress_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_is_manager boolean;
BEGIN
  SELECT role = 'manager' INTO v_is_manager FROM profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_is_manager, false) THEN
    RAISE EXCEPTION 'Only managers can sign off practical training';
  END IF;
  UPDATE lesson_progress
  SET practical_signed_off = true,
      signed_off_by = auth.uid(),
      signed_off_at = now()
  WHERE id = p_progress_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION sign_off_practical(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION sign_off_practical(uuid) TO authenticated;

-- ===== retraining function (privileged) =====
CREATE OR REPLACE FUNCTION require_retraining(p_lesson_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_is_manager boolean;
  v_new_version int;
BEGIN
  SELECT role = 'manager' INTO v_is_manager FROM profiles WHERE id = auth.uid();
  IF NOT COALESCE(v_is_manager, false) THEN
    RAISE EXCEPTION 'Only managers can require retraining';
  END IF;
  UPDATE lessons SET version = version + 1 WHERE id = p_lesson_id RETURNING version INTO v_new_version;
  UPDATE assignments SET assigned_version = v_new_version WHERE lesson_id = p_lesson_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION require_retraining(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION require_retraining(uuid) TO authenticated;

-- ===== new-user trigger =====
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO profiles (id, full_name) VALUES (NEW.id, coalesce(NEW.raw_user_meta_data->>'full_name',''));
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ===== views =====
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
JOIN lessons l ON l.id = a.lesson_id
JOIN categories c ON c.id = l.category_id
LEFT JOIN lesson_progress p ON p.lesson_id = l.id AND p.employee_id = e.id
WHERE e.active = true;

-- ===== grants =====
GRANT SELECT ON profiles TO authenticated;
GRANT SELECT, UPDATE (full_name) ON profiles TO authenticated;

GRANT SELECT ON categories TO authenticated;
GRANT INSERT, UPDATE, DELETE ON categories TO authenticated;

GRANT SELECT ON lessons TO authenticated;
GRANT INSERT, UPDATE, DELETE ON lessons TO authenticated;

GRANT SELECT ON assignments TO authenticated;
GRANT INSERT, UPDATE, DELETE ON assignments TO authenticated;

GRANT SELECT ON lesson_progress TO authenticated;
GRANT INSERT, UPDATE (quiz_score, quiz_total, quiz_passed, acknowledged, acknowledged_at, completed_version, last_attempt_at) ON lesson_progress TO authenticated;

GRANT SELECT ON employee_training TO authenticated;

-- ===== RLS policies =====

-- profiles
DROP POLICY IF EXISTS "profiles_select_all" ON profiles;
CREATE POLICY "profiles_select_all" ON profiles FOR SELECT
  TO authenticated USING (true);
DROP POLICY IF EXISTS "profiles_update_self" ON profiles;
CREATE POLICY "profiles_update_self" ON profiles FOR UPDATE
  TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

-- categories
DROP POLICY IF EXISTS "categories_read" ON categories;
CREATE POLICY "categories_read" ON categories FOR SELECT
  TO authenticated USING (true);
DROP POLICY IF EXISTS "categories_write_mgr" ON categories;
CREATE POLICY "categories_write_mgr" ON categories FOR INSERT
  TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'manager'));
DROP POLICY IF EXISTS "categories_update_mgr" ON categories;
CREATE POLICY "categories_update_mgr" ON categories FOR UPDATE
  TO authenticated USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'manager'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'manager'));
DROP POLICY IF EXISTS "categories_delete_mgr" ON categories;
CREATE POLICY "categories_delete_mgr" ON categories FOR DELETE
  TO authenticated USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'manager'));

-- lessons
DROP POLICY IF EXISTS "lessons_read" ON lessons;
CREATE POLICY "lessons_read" ON lessons FOR SELECT
  TO authenticated USING (true);
DROP POLICY IF EXISTS "lessons_write_mgr" ON lessons;
CREATE POLICY "lessons_write_mgr" ON lessons FOR INSERT
  TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'manager'));
DROP POLICY IF EXISTS "lessons_update_mgr" ON lessons;
CREATE POLICY "lessons_update_mgr" ON lessons FOR UPDATE
  TO authenticated USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'manager'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'manager'));
DROP POLICY IF EXISTS "lessons_delete_mgr" ON lessons;
CREATE POLICY "lessons_delete_mgr" ON lessons FOR DELETE
  TO authenticated USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'manager'));

-- assignments
DROP POLICY IF EXISTS "assignments_read" ON assignments;
CREATE POLICY "assignments_read" ON assignments FOR SELECT
  TO authenticated USING (true);
DROP POLICY IF EXISTS "assignments_write_mgr" ON assignments;
CREATE POLICY "assignments_write_mgr" ON assignments FOR INSERT
  TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'manager'));
DROP POLICY IF EXISTS "assignments_update_mgr" ON assignments;
CREATE POLICY "assignments_update_mgr" ON assignments FOR UPDATE
  TO authenticated USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'manager'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'manager'));
DROP POLICY IF EXISTS "assignments_delete_mgr" ON assignments;
CREATE POLICY "assignments_delete_mgr" ON assignments FOR DELETE
  TO authenticated USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'manager'));

-- lesson_progress
DROP POLICY IF EXISTS "progress_read_own_or_mgr" ON lesson_progress;
CREATE POLICY "progress_read_own_or_mgr" ON lesson_progress FOR SELECT
  TO authenticated USING (
    employee_id = auth.uid()
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'manager')
  );
DROP POLICY IF EXISTS "progress_insert_own" ON lesson_progress;
CREATE POLICY "progress_insert_own" ON lesson_progress FOR INSERT
  TO authenticated WITH CHECK (employee_id = auth.uid());
DROP POLICY IF EXISTS "progress_update_own" ON lesson_progress;
CREATE POLICY "progress_update_own" ON lesson_progress FOR UPDATE
  TO authenticated USING (employee_id = auth.uid()) WITH CHECK (employee_id = auth.uid());
