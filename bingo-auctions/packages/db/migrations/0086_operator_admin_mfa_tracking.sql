-- ============================================================================
-- 0086_operator_admin_mfa_tracking
--
-- LAUNCH_PLAN §3.1c — MFA (TOTP) enforcement for operator admins.
--
-- Adds a single tracking column on operator_users:
--
--   admin_first_seen_at  TIMESTAMPTZ
--
-- This column marks the first time a row whose role = 'admin' actually
-- signed in to the operator console (vs. the row simply existing in the
-- DB — staff are created with an invite + temp password, but `invited_at`
-- pre-dates their first browser session). The operator layout server
-- component stamps this column to NOW() on first admin-sign-in if NULL.
--
-- Used by the MFA-setup banner on the operator dashboard to compute a
-- 7-day grace period: the banner is dismissible only after
-- (NOW() - admin_first_seen_at) >= 7 days, but the underlying step-up
-- gates on sensitive pages STAY enforced regardless. So an admin can
-- dismiss the nag, but they cannot actually USE /staff, /billing,
-- /payouts, or /account until they've enrolled a TOTP factor and stepped
-- up to AAL2.
--
-- ── Why a column, not a derived value ────────────────────────────────────
-- We could derive "first admin sign-in" by joining auth.users.last_sign_in_at
-- with operator_users on the user_id, but:
--   • auth.users isn't directly readable from the user's session client
--     under RLS (Supabase deliberately hides it; we'd need service-role).
--   • last_sign_in_at gets BUMPED on every refresh — it's not "first".
-- So we maintain our own counter. Defaults NULL; the layout stamps it
-- once. After that it's immutable from app code.
--
-- ── RLS impact ───────────────────────────────────────────────────────────
-- operator_users_self_update (migration 0080) already lets a user UPDATE
-- their own row. The layout server action runs as the user's cookie
-- session, so the UPDATE that sets admin_first_seen_at is covered.
-- No new policy required.
-- ============================================================================

ALTER TABLE operator_users
  ADD COLUMN IF NOT EXISTS admin_first_seen_at TIMESTAMPTZ;

COMMENT ON COLUMN operator_users.admin_first_seen_at IS
  'Timestamp of the first time this admin actually loaded the operator console '
  '(vs. simply being invited). Stamped once by the operator layout server '
  'component when role = ''admin'' AND admin_first_seen_at IS NULL. Used to '
  'compute the 7-day MFA-enrollment grace period (LAUNCH_PLAN §3.1c). After '
  'the grace period the banner becomes dismissible, but the AAL2 step-up '
  'gates on /staff, /billing, /account, /payouts stay enforced regardless.';
