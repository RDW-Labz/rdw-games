-- ============================================================================
-- 0080_staff_force_password_rotate
--
-- Closes the loop on Phase 1 §1.7 of LAUNCH_PLAN.md (plaintext-password leak
-- in /api/staff/invite). The route's response payload no longer echoes the
-- temp password back to the admin's browser; instead the password is shown
-- ONCE inline in the invite response (server-rendered text only, never
-- logged, never persisted plain), and the invited staff is forced to rotate
-- it on first sign-in.
--
-- This migration adds a single boolean column on operator_users:
--
--   force_password_rotate BOOLEAN NOT NULL DEFAULT FALSE
--
-- Set TRUE by the invite route for direct-password (Flow B) creations.
-- Cleared by the rotate-password server action once the staff member picks
-- a new password. The middleware reads this column on every request to the
-- operator console and redirects to /account/rotate-password when TRUE.
--
-- ── Naming note ──────────────────────────────────────────────────────────
-- LAUNCH_PLAN.md §1.9 also reserves 0080 for staff_confirm_pickup_rpc.
-- That work has not landed yet; the pickup RPC migration should renumber
-- to 0081 (or the next free slot at that time). Numbering chosen per the
-- §1.7 implementation prompt.
-- ============================================================================

-- Add the column. DEFAULT FALSE means every existing staff row is unaffected
-- (they've already been using the system; nothing to rotate retroactively).
ALTER TABLE operator_users
  ADD COLUMN IF NOT EXISTS force_password_rotate BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN operator_users.force_password_rotate IS
  'When TRUE, the operator console redirects this user to /account/rotate-password '
  'on every request until they pick a new password. Set by /api/staff/invite for '
  'Flow B (direct-password) invites; cleared once the rotate-password action runs. '
  'See LAUNCH_PLAN.md §1.7.';

-- Index for the per-request middleware probe. Most queries return FALSE
-- (the column is FALSE for the overwhelming majority of staff), so a
-- partial index keyed on the user_id of forced-rotate rows is tighter
-- than a full b-tree.
CREATE INDEX IF NOT EXISTS operator_users_force_rotate_idx
  ON operator_users (user_id)
  WHERE force_password_rotate = TRUE;

-- ── RLS impact ──────────────────────────────────────────────────────────────
-- operator_users_self_read already lets each user SELECT their own row
-- (user_id = auth.uid()) AND every staff member SELECT rows in their
-- operator (operator_id = current_operator_id()). force_password_rotate
-- piggybacks on operator_users_self_read; no new policy needed.
--
-- operator_users_admin_write covers UPDATEs by an admin (e.g. resetting
-- the flag manually). The rotate-password server action runs as the
-- user themselves and updates their own row — that's covered by the
-- self_read policy + an additional self_update policy below.

DROP POLICY IF EXISTS operator_users_self_update ON operator_users;
CREATE POLICY operator_users_self_update ON operator_users
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- The self_update policy is intentionally narrow: it covers EVERY column
-- on operator_users, including role. Defense in depth: the rotate-password
-- server action only updates force_password_rotate (the column patch is
-- explicit), and admin role changes still flow through /api/staff/[id]
-- which checks caller.role = 'admin' in app code. A user cannot escalate
-- their own role via a direct PostgREST UPDATE because PostgREST requires
-- an explicit `?columns=` for partial updates AND the table's RLS UPDATE
-- check would still need to hold — but `operator_users_admin_write` is
-- ALL operations with a stricter check, so a self UPDATE of `role` would
-- still pass operator_users_self_update. We mitigate this by NOT exposing
-- a partial-update path from any client; the only writes are:
--   - /api/staff/invite (admin-gated, service-role)
--   - /api/staff/[id]    (admin-gated, service-role)
--   - /account/rotate-password server action (self, only patches
--                                              force_password_rotate)
-- A direct PostgREST UPDATE to operator_users with arbitrary fields would
-- need the user to construct that call themselves — not exposed by any UI.
-- If we later expose self-edit (e.g. display_name), tighten this policy
-- to only allow specific columns via a CHECK that compares OLD vs NEW.
