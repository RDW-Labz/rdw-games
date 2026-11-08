-- 0281_workers_pin.sql — per-worker PIN identity for shared warehouse devices
--
-- Staff request 2026-07-21 (#2): company work phones share one login and staff
-- have no access to a company email inbox, so the personal-email / magic-link
-- model is unusable. Chosen direction: the device signs in ONCE as a company
-- staff (operator_users) account, then each worker identifies with a short PIN.
--
-- This is Phase 1 — the DB foundation only. It is ADDITIVE and RLS-gated and does
-- NOT change how the device authenticates (the existing operator_users gate is
-- untouched). A `worker` is a login-less person: no auth.users row, no Supabase
-- session. PIN verification is an APP-LEVEL identity used for attribution, UX,
-- and role-gating; DB row access is still authorized as the signed-in station
-- account via RLS. (A stronger per-worker-JWT model is overkill for internal
-- warehouse attribution.)
--
-- PINs are hashed with pgcrypto bcrypt (crypt/gen_salt('bf')); plaintext is never
-- stored. verify_worker_pin enforces a lockout after repeated failures.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── workers ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id     uuid NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,
  display_name    text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  pin_hash        text NOT NULL,
  role            operator_user_role NOT NULL DEFAULT 'picker',
  is_active       boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_by      uuid REFERENCES public.operator_users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One active worker name per operator (case-insensitive) so the picker list is
-- unambiguous; inactive names can be reused.
CREATE UNIQUE INDEX IF NOT EXISTS workers_operator_active_name_uidx
  ON public.workers (operator_id, lower(btrim(display_name)))
  WHERE is_active;
CREATE INDEX IF NOT EXISTS workers_operator_active_idx
  ON public.workers (operator_id) WHERE is_active;

COMMENT ON TABLE public.workers IS
  '0281: login-less per-worker PIN identity for shared warehouse devices. Not tied '
  'to auth.users. Used for lot attribution (lots.lotted_by_worker), app UX, and '
  'role-gating; DB access is still authorized as the signed-in station account.';

-- Attribution: which worker created the lot (the real person on a shared device).
-- Distinct from lots.lotted_by (auth.uid() of the station account, mig 0279).
ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS lotted_by_worker uuid REFERENCES public.workers(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.lots.lotted_by_worker IS
  '0281: worker (PIN identity) who created this lot on a shared device. Preferred '
  'over lotted_by for the Worker Productivity report when present.';

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Direct table access: staff of the operator may SELECT (never pin_hash via the
-- app — reads go through list_active_workers). Writes go through the SECURITY
-- DEFINER manager RPCs below, so no INSERT/UPDATE/DELETE policies are granted.
ALTER TABLE public.workers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workers_select_same_operator ON public.workers;
CREATE POLICY workers_select_same_operator ON public.workers
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.operator_users ou
      WHERE ou.user_id = auth.uid() AND ou.operator_id = workers.operator_id
    )
  );

-- ── helpers ──────────────────────────────────────────────────────────────────
-- Caller's operator_users row (station account), or NULL if not staff.
CREATE OR REPLACE FUNCTION public._caller_operator_user(p_operator_id uuid)
RETURNS public.operator_users
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT ou.* FROM public.operator_users ou
  WHERE ou.user_id = auth.uid() AND ou.operator_id = p_operator_id
  LIMIT 1;
$$;

-- ── list_active_workers: names for the clock-in picker (NO pin_hash) ───────────
CREATE OR REPLACE FUNCTION public.list_active_workers(p_operator_id uuid)
RETURNS TABLE(id uuid, display_name text, role operator_user_role)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF (public._caller_operator_user(p_operator_id)).id IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT w.id, w.display_name, w.role
      FROM public.workers w
     WHERE w.operator_id = p_operator_id AND w.is_active
     ORDER BY lower(w.display_name);
END;
$$;

-- ── verify_worker_pin: clock in. Lockout after MAX_FAILS for LOCK_MINUTES ──────
CREATE OR REPLACE FUNCTION public.verify_worker_pin(p_worker_id uuid, p_pin text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  MAX_FAILS   constant integer := 5;
  LOCK_MINS   constant integer := 15;
  v_worker    public.workers%ROWTYPE;
BEGIN
  SELECT * INTO v_worker FROM public.workers WHERE id = p_worker_id;
  IF NOT FOUND OR NOT v_worker.is_active THEN
    RETURN json_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- Caller must be staff of the worker's operator (station account on-device).
  IF (public._caller_operator_user(v_worker.operator_id)).id IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  IF v_worker.locked_until IS NOT NULL AND v_worker.locked_until > now() THEN
    RETURN json_build_object('ok', false, 'reason', 'locked',
      'locked_until', v_worker.locked_until);
  END IF;

  IF v_worker.pin_hash = extensions.crypt(p_pin, v_worker.pin_hash) THEN
    UPDATE public.workers
       SET failed_attempts = 0, locked_until = NULL, updated_at = now()
     WHERE id = p_worker_id;
    RETURN json_build_object('ok', true, 'worker', json_build_object(
      'id', v_worker.id, 'display_name', v_worker.display_name,
      'role', v_worker.role, 'operator_id', v_worker.operator_id));
  END IF;

  -- Wrong PIN — count it, lock if over the threshold.
  UPDATE public.workers
     SET failed_attempts = failed_attempts + 1,
         locked_until = CASE WHEN failed_attempts + 1 >= MAX_FAILS
                             THEN now() + make_interval(mins => LOCK_MINS) END,
         updated_at = now()
   WHERE id = p_worker_id;
  RETURN json_build_object('ok', false, 'reason', 'bad_pin');
END;
$$;

-- ── manager-only mutations ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._require_manager(p_operator_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_role operator_user_role;
BEGIN
  SELECT (public._caller_operator_user(p_operator_id)).role INTO v_role;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;
  -- admin(4) / manager(3) may manage workers; lead/picker may not.
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'requires_manager' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_worker(
  p_operator_id uuid, p_display_name text, p_pin text,
  p_role operator_user_role DEFAULT 'picker'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE v_id uuid; v_caller uuid;
BEGIN
  PERFORM public._require_manager(p_operator_id);
  IF p_pin !~ '^[0-9]{4,8}$' THEN
    RAISE EXCEPTION 'pin_must_be_4_to_8_digits' USING ERRCODE = '22023';
  END IF;
  v_caller := (public._caller_operator_user(p_operator_id)).id;
  INSERT INTO public.workers (operator_id, display_name, pin_hash, role, created_by)
  VALUES (p_operator_id, btrim(p_display_name),
          extensions.crypt(p_pin, extensions.gen_salt('bf')), p_role, v_caller)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_worker_pin(p_worker_id uuid, p_pin text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE v_operator uuid;
BEGIN
  SELECT operator_id INTO v_operator FROM public.workers WHERE id = p_worker_id;
  IF v_operator IS NULL THEN
    RAISE EXCEPTION 'worker_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._require_manager(v_operator);
  IF p_pin !~ '^[0-9]{4,8}$' THEN
    RAISE EXCEPTION 'pin_must_be_4_to_8_digits' USING ERRCODE = '22023';
  END IF;
  UPDATE public.workers
     SET pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')),
         failed_attempts = 0, locked_until = NULL, updated_at = now()
   WHERE id = p_worker_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.deactivate_worker(p_worker_id uuid)
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
  UPDATE public.workers SET is_active = false, updated_at = now() WHERE id = p_worker_id;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_worker_pin(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_active_workers(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_worker_pin(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_worker(uuid, text, text, operator_user_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_worker_pin(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.deactivate_worker(uuid) TO authenticated;

COMMIT;
