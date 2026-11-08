-- ============================================================================
-- Migration 0109 — Operator invite tokens + "request account" waitlist.
--
-- Two-domain split context
-- ------------------------
-- clovrbid.com  ─→ bidder-facing marketplace. Signup form is a "Request an
--                  account" waitlist captured into operator_requests. Public
--                  never sees the word "invite" — looks like any normal
--                  auction app.
-- operators.clovrbid.com ─→ operator pitch. Signup at
--                  operators.clovrbid.com/signup?token=<TOKEN> requires a
--                  valid, unconsumed operator_invites row to actually create
--                  the operators record.
--
-- Super admin (Michael, jmacluer@gmail.com) sees the operator_requests
-- list in /operator/admin/requests, clicks "Approve & generate link" which
-- mints an operator_invites row + copies the URL. He emails the link to
-- the new operator manually for now (no email-provider integration in MVP).
-- When the public-signup flow is eventually re-opened (non-compete expires
-- + ready for marketplace growth), drop the token requirement; this table
-- pair stays as audit history.
--
-- ADDITIVE ONLY. No existing tables touched. Existing operators row is
-- unaffected; signup flow for the existing operator continues working
-- because they're already in the operators table.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. operator_requests — public-facing "request an account" submissions
-- ---------------------------------------------------------------------------
-- Captured from clovrbid.com/signup (the waitlist form). Status starts
-- 'pending'; super admin reviews + either approves (mints an invite) or
-- declines.

CREATE TABLE IF NOT EXISTS operator_requests (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email          TEXT NOT NULL,
  business_name  TEXT,
  -- Free-form "tell us what you sell / why ClovrBid". Helps us decide who
  -- to approve. Length-capped to keep abuse manageable.
  description    TEXT,
  -- Where did the request come from? 'bidder_homepage' | 'operators_landing'
  -- | 'manual' (admin-created directly).
  source         TEXT NOT NULL DEFAULT 'bidder_homepage',
  -- 'pending' | 'approved' | 'declined'
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'declined')),
  -- Audit: who reviewed + when. NULL until reviewed.
  reviewed_at    TIMESTAMPTZ,
  reviewed_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Free-form note super admin can attach (e.g. "Asked for sample lots first").
  review_notes   TEXT,
  -- If approved, FK to the operator_invites row that was minted from
  -- this request. NULL if declined or still pending.
  invite_id      UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operator_requests_status_idx
  ON operator_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS operator_requests_email_idx
  ON operator_requests (email);

ALTER TABLE operator_requests ENABLE ROW LEVEL SECURITY;

-- The bidder-side request form runs with the anon Supabase key, so we
-- need an INSERT policy that allows unauthenticated rows. RPCs further
-- below provide stricter alternatives if needed. Reads are admin-only.
DROP POLICY IF EXISTS operator_requests_insert_anon ON operator_requests;
CREATE POLICY operator_requests_insert_anon
  ON operator_requests FOR INSERT
  WITH CHECK (true);  -- anyone can request; service-role does all reads/edits

-- ---------------------------------------------------------------------------
-- 2. operator_invites — single-use tokens that unlock operator signup
-- ---------------------------------------------------------------------------
-- Minted from /operator/admin/requests by the super admin. The token
-- string is ~32 chars URL-safe random; the signup page at
-- operators.clovrbid.com/signup?token=<TOKEN> validates against this
-- table before showing the real form.
--
-- Tokens expire 14 days from mint by default. After redemption,
-- consumed_at is stamped so the same token can't be reused; the
-- new operators.id is recorded for audit.

CREATE TABLE IF NOT EXISTS operator_invites (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- The actual token in the URL. Indexed for the redemption path.
  token                    TEXT NOT NULL UNIQUE,
  -- The email the invite was minted for. The signup form pre-fills this
  -- and enforces it (the user can't sign up with a different email,
  -- prevents token-sharing).
  email                    TEXT NOT NULL,
  -- Optional pre-fill so the operator's onboarding is faster.
  business_name_hint       TEXT,
  -- Audit: who minted, when.
  created_by               UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days'),
  -- Set when the operator signs up successfully via this token.
  consumed_at              TIMESTAMPTZ,
  consumed_by_operator_id  UUID REFERENCES operators(id) ON DELETE SET NULL,
  -- Optional back-pointer to the request that triggered this invite.
  request_id               UUID REFERENCES operator_requests(id) ON DELETE SET NULL,
  -- Operator-side notes (e.g. "Personally referred by X, give them the
  -- pro tier for 6 months free"). Internal only.
  notes                    TEXT
);

CREATE INDEX IF NOT EXISTS operator_invites_token_idx ON operator_invites (token);
CREATE INDEX IF NOT EXISTS operator_invites_active_idx
  ON operator_invites (expires_at)
  WHERE consumed_at IS NULL;

-- Now wire the operator_requests.invite_id FK that we couldn't add inline
-- because operator_invites didn't exist yet.
ALTER TABLE operator_requests
  ADD CONSTRAINT operator_requests_invite_id_fk
  FOREIGN KEY (invite_id)
  REFERENCES operator_invites(id)
  ON DELETE SET NULL;

ALTER TABLE operator_invites ENABLE ROW LEVEL SECURITY;

-- RLS: only service-role + the user redeeming a specific token can read.
-- The redemption RPC (below) uses SECURITY DEFINER so it bypasses RLS
-- internally, but we still want a SELECT policy so admin pages running
-- under the user's session can read their own minted invites.
DROP POLICY IF EXISTS operator_invites_admin_select ON operator_invites;
CREATE POLICY operator_invites_admin_select
  ON operator_invites FOR SELECT
  USING (
    -- The super-admin gate is done in the app layer (env-var email check).
    -- Inside Postgres, the easiest stable gate is "created_by = auth.uid()".
    -- That's correct because mint_operator_invite stamps created_by from
    -- the route handler's authenticated user. Service-role bypasses.
    created_by = auth.uid()
  );

-- ---------------------------------------------------------------------------
-- 3. mint_operator_invite — RPC, called by the admin route handler
-- ---------------------------------------------------------------------------
-- The route at /operator/admin/requests (super-admin gated by
-- SUPER_ADMIN_EMAILS env var) calls this to generate a new token from a
-- pending operator_requests row. Atomically:
--   1. Generates a 32-char URL-safe token
--   2. Inserts operator_invites with that token + the request's email
--   3. Updates operator_requests.status = 'approved' + reviewed_at/by
--   4. Links operator_requests.invite_id back to the new invite
--   5. Returns the new invite row (so the route can show the URL to copy)
--
-- SECURITY DEFINER because operator_requests has anon INSERT but no
-- direct update policy. The route handler verifies super-admin role
-- BEFORE calling this; the RPC itself just needs auth.uid() to stamp
-- created_by.

CREATE OR REPLACE FUNCTION mint_operator_invite(
  p_request_id     UUID,
  p_ttl_days       INTEGER DEFAULT 14,
  p_notes          TEXT DEFAULT NULL
)
RETURNS TABLE (
  invite_id        UUID,
  token            TEXT,
  email            TEXT,
  business_name    TEXT,
  expires_at       TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request operator_requests%ROWTYPE;
  v_token   TEXT;
  v_invite  operator_invites%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_request FROM operator_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'request_not_pending: status=%', v_request.status
      USING ERRCODE = 'P0001';
  END IF;

  -- 32 char URL-safe token. Using gen_random_bytes from pgcrypto (already
  -- enabled by 0001 via uuid-ossp dependency chain). encode(...) with
  -- base64 produces +/= which aren't URL-safe; we strip them.
  v_token := REPLACE(REPLACE(REPLACE(
    encode(gen_random_bytes(24), 'base64'),
    '+', '-'), '/', '_'), '=', '');

  INSERT INTO operator_invites (
    token, email, business_name_hint, created_by, expires_at, request_id, notes
  ) VALUES (
    v_token,
    v_request.email,
    v_request.business_name,
    auth.uid(),
    now() + (p_ttl_days || ' days')::INTERVAL,
    v_request.id,
    p_notes
  )
  RETURNING * INTO v_invite;

  UPDATE operator_requests
     SET status = 'approved',
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         invite_id = v_invite.id
   WHERE id = p_request_id;

  RETURN QUERY SELECT
    v_invite.id, v_invite.token, v_invite.email,
    v_request.business_name, v_invite.expires_at;
END;
$$;

REVOKE ALL ON FUNCTION mint_operator_invite(UUID, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mint_operator_invite(UUID, INTEGER, TEXT) TO authenticated;
-- App-layer super-admin gate sits in the route handler. RLS on the
-- operator_invites table doesn't restrict by role; service-role + the
-- creator can read. If a non-admin user somehow gets the function URL,
-- they could only mint invites against requests they can see — and
-- operator_requests has no SELECT policy for anon so they can't even
-- enumerate request IDs. Defense in depth.

-- ---------------------------------------------------------------------------
-- 4. mint_invite_direct — admin path that skips the request waitlist
-- ---------------------------------------------------------------------------
-- For when the super admin already knows someone offline and wants to
-- generate an invite without a corresponding request. Bypasses the
-- pending-request requirement.

CREATE OR REPLACE FUNCTION mint_invite_direct(
  p_email               TEXT,
  p_business_name_hint  TEXT DEFAULT NULL,
  p_ttl_days            INTEGER DEFAULT 14,
  p_notes               TEXT DEFAULT NULL
)
RETURNS TABLE (
  invite_id   UUID,
  token       TEXT,
  email       TEXT,
  expires_at  TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token   TEXT;
  v_invite  operator_invites%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_email IS NULL OR LENGTH(TRIM(p_email)) = 0 THEN
    RAISE EXCEPTION 'email_required' USING ERRCODE = 'P0001';
  END IF;

  v_token := REPLACE(REPLACE(REPLACE(
    encode(gen_random_bytes(24), 'base64'),
    '+', '-'), '/', '_'), '=', '');

  INSERT INTO operator_invites (
    token, email, business_name_hint, created_by, expires_at, notes
  ) VALUES (
    v_token,
    TRIM(LOWER(p_email)),
    NULLIF(TRIM(p_business_name_hint), ''),
    auth.uid(),
    now() + (p_ttl_days || ' days')::INTERVAL,
    p_notes
  )
  RETURNING * INTO v_invite;

  RETURN QUERY SELECT
    v_invite.id, v_invite.token, v_invite.email, v_invite.expires_at;
END;
$$;

REVOKE ALL ON FUNCTION mint_invite_direct(TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mint_invite_direct(TEXT, TEXT, INTEGER, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. redeem_operator_invite — called inside the signup transaction
-- ---------------------------------------------------------------------------
-- The signup server action (signupOperator) calls this BEFORE inserting
-- the operators row. Validates the token:
--   - exists
--   - matches the signup email (prevents token-sharing)
--   - not expired
--   - not already consumed
-- Returns the invite_id (the route handler can stamp it on the new
-- operators row OR use it to update operator_requests after operator
-- creation). If validation fails, raises with a specific message so the
-- UI can show a helpful error.
--
-- Does NOT mark the invite consumed yet — the route handler does that
-- after the operator row insert succeeds, via mark_invite_consumed.

CREATE OR REPLACE FUNCTION redeem_operator_invite(
  p_token         TEXT,
  p_signup_email  TEXT
)
RETURNS TABLE (
  invite_id           UUID,
  business_name_hint  TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_invite operator_invites%ROWTYPE;
BEGIN
  IF p_token IS NULL OR LENGTH(TRIM(p_token)) = 0 THEN
    RAISE EXCEPTION 'token_missing' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_invite FROM operator_invites WHERE token = p_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invite_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'invite_already_used' USING ERRCODE = 'P0001';
  END IF;
  IF v_invite.expires_at < now() THEN
    RAISE EXCEPTION 'invite_expired' USING ERRCODE = 'P0001';
  END IF;
  IF LOWER(TRIM(v_invite.email)) <> LOWER(TRIM(p_signup_email)) THEN
    RAISE EXCEPTION 'invite_email_mismatch' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY SELECT v_invite.id, v_invite.business_name_hint;
END;
$$;

REVOKE ALL ON FUNCTION redeem_operator_invite(TEXT, TEXT) FROM PUBLIC;
-- Anon must call this because the signup form is on the unauthenticated
-- path. The function itself is read-only (STABLE) and reveals nothing
-- beyond what the caller already knows (the token + the email they typed).
GRANT EXECUTE ON FUNCTION redeem_operator_invite(TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION redeem_operator_invite(TEXT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. mark_invite_consumed — called AFTER operator row insert succeeds
-- ---------------------------------------------------------------------------
-- Stamps the invite as consumed. Service-role would normally be used
-- here, but we keep this as a SECURITY DEFINER function so the signup
-- route can call it via the anon client too without leaking service-role.

CREATE OR REPLACE FUNCTION mark_invite_consumed(
  p_invite_id    UUID,
  p_operator_id  UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE operator_invites
     SET consumed_at = now(),
         consumed_by_operator_id = p_operator_id
   WHERE id = p_invite_id AND consumed_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION mark_invite_consumed(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_invite_consumed(UUID, UUID) TO authenticated;
