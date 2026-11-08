-- ============================================================================
-- Migration 0205 — operator_role_capabilities + operator_role_can()
--                  (Staff Role Matrix, Phase 1 — INERT)
--
-- See docs/security/ROLE-MATRIX-PLAN-2026-06-13.md for the full design.
--
-- WHAT THIS IS
-- ------------
-- A single source of truth for "which role can do what." Today the answer is
-- duplicated + hardcoded across RLS policies, RPCs, and API routes (each with
-- its own literal role list like IN ('admin','manager','lead')). Adding the
-- 'lead' role (0202) meant hunting every site. This replaces that with a
-- capability table + a function both the DB and the apps can ask.
--
-- PHASE 1 IS INERT. Nothing reads operator_role_can() yet — this migration only
-- ADDS a table + seed + function. Zero behavior change. Phase 2 swaps the
-- existing hardcoded gates onto operator_role_can() (behavior-preserving,
-- reviewed before merge); Phase 3 closes the gaps (manual_checkout / mark-paid
-- / bidder.suspend currently "any staff"); Phase 4 adds the operator UI.
--
-- ROLE LADDER (monotonic — each role inherits everything below it):
--   picker  c  lead  c  manager  c  admin
-- Decision 2026-06-13: NO separate 'cashier' role — 'lead' is the single counter
-- role (checkout + in-window refunds). A cashier tier can be seeded later with
-- zero logic change if wanted.
--
-- SEED = TODAY'S EFFECTIVE GATES (so Phase 2 wiring preserves behavior):
--   * floor + counter actions (intake/putaway/lot, pickup verify/sign,
--     manual_checkout, take_payment) are "any staff" TODAY -> every role gets
--     them here. (Phase 3 may tighten manual_checkout/take_payment to lead+.)
--   * refund.in_window -> lead, manager, admin   (refund-items route:135)
--   * auction publish/cancel, inventory.dispose, payment.mark_paid_offline,
--     audit.view -> manager, admin               (0096 / 0146 / 0157 / invoices)
--   * settings.edit, policy.edit, staff.manage, payouts.manage,
--     refund.override -> admin                    (settings actions / staff route)
--
-- Super-admin (platform jmacluer@gmail.com) is a separate email-pinned
-- break-glass and is intentionally NOT modeled here.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.operator_role_capabilities (
  role       public.operator_user_role NOT NULL,
  capability text NOT NULL,
  PRIMARY KEY (role, capability)
);

COMMENT ON TABLE public.operator_role_capabilities IS
  'Single source of truth for role -> capability (Staff Role Matrix, mig 0205). '
  'Global reference data, not tenant-scoped. Seeded to reproduce the gates that '
  'existed at 0205. Read it via operator_role_can(); edit deliberately.';

-- Reference data — which role can do what is not tenant-sensitive. Readable by
-- any authenticated staff so the future Roles & Permissions UI can render it.
-- No write policy: seeded by migration only (admin editing comes in Phase 4).
ALTER TABLE public.operator_role_capabilities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_role_capabilities_read ON public.operator_role_capabilities;
CREATE POLICY operator_role_capabilities_read ON public.operator_role_capabilities
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.operator_role_capabilities TO authenticated;

-- Seed (monotonic by construction: each tier CROSS JOINs the roles at or above
-- it). Idempotent via ON CONFLICT.
INSERT INTO public.operator_role_capabilities (role, capability)
-- Tier 0 — floor + counter: every role (reproduces "any staff" today).
SELECT r.role, c.capability
FROM (VALUES
  ('inventory.intake'), ('inventory.putaway'), ('inventory.lot'),
  ('pickup.verify'), ('pickup.sign'), ('pickup.manual_checkout'),
  ('checkout.take_payment')
) AS c(capability)
CROSS JOIN (VALUES
  ('picker'::public.operator_user_role), ('lead'), ('manager'), ('admin')
) AS r(role)
UNION ALL
-- Tier 1 — in-window refunds: lead and up.
SELECT r.role, c.capability
FROM (VALUES ('refund.in_window')) AS c(capability)
CROSS JOIN (VALUES
  ('lead'::public.operator_user_role), ('manager'), ('admin')
) AS r(role)
UNION ALL
-- Tier 2 — operations: manager and up.
SELECT r.role, c.capability
FROM (VALUES
  ('auction.publish'), ('auction.cancel'), ('inventory.dispose'),
  ('payment.mark_paid_offline'), ('audit.view')
) AS c(capability)
CROSS JOIN (VALUES
  ('manager'::public.operator_user_role), ('admin')
) AS r(role)
UNION ALL
-- Tier 3 — owner: admin only.
SELECT r.role, c.capability
FROM (VALUES
  ('settings.edit'), ('policy.edit'), ('staff.manage'),
  ('payouts.manage'), ('refund.override')
) AS c(capability)
CROSS JOIN (VALUES ('admin'::public.operator_user_role)) AS r(role)
ON CONFLICT (role, capability) DO NOTHING;

-- The single question RLS / RPCs / app routes will ask (Phase 2+).
-- SECURITY DEFINER so it can read the matrix under any caller; STABLE; returns
-- FALSE for non-staff (current_operator_role() is NULL -> no row matches).
CREATE OR REPLACE FUNCTION public.operator_role_can(p_capability text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.operator_role_capabilities orc
    WHERE orc.role = public.current_operator_role()
      AND orc.capability = p_capability
  );
$$;

COMMENT ON FUNCTION public.operator_role_can(text) IS
  'TRUE if the calling operator user role grants the capability (Staff Role '
  'Matrix, mig 0205). Single gate for RLS/RPC/app. Phase 1: no callers yet.';

REVOKE ALL ON FUNCTION public.operator_role_can(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_role_can(text) TO authenticated;

COMMIT;
