-- ============================================================================
-- Migration 0081: policy_versions + terms_acceptances
--
-- Implements E-SIGN Act compliant consent persistence. Every time a user
-- affirmatively agrees to a legal document, a row is written here with the
-- document version, timestamp, IP, user-agent, and method of consent.
--
-- Published docs are gated by policy_versions.published = TRUE. The seed
-- rows below ship with published = FALSE — flip to TRUE after lawyer review.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- policy_versions: tracks published snapshots of each legal document
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policy_versions (
  slug            TEXT        NOT NULL,
  version         INT         NOT NULL,
  content_hash    TEXT        NOT NULL,  -- SHA-256 of rendered markdown
  effective_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published       BOOLEAN     NOT NULL DEFAULT FALSE,

  PRIMARY KEY (slug, version)
);

CREATE INDEX policy_versions_lookup_idx
  ON policy_versions (slug, published, effective_at DESC);

-- RLS: anyone may read published rows; only service-role can write
ALTER TABLE policy_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "policy_versions: public read published"
  ON policy_versions
  FOR SELECT
  USING (published = TRUE);

-- (Service-role bypasses RLS entirely — no explicit write policy needed)

-- ---------------------------------------------------------------------------
-- terms_acceptances: immutable audit trail of every consent event
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS terms_acceptances (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  slug            TEXT        NOT NULL,
  version         INT         NOT NULL,
  accepted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address      TEXT,
  user_agent      TEXT,
  consent_method  TEXT        NOT NULL,  -- 'signup_checkbox' | 'first_bid' | 'reaccept_on_version_bump' | ...

  FOREIGN KEY (slug, version) REFERENCES policy_versions (slug, version)
);

CREATE INDEX terms_acceptances_user_slug_idx
  ON terms_acceptances (user_id, slug, accepted_at DESC);

-- RLS
ALTER TABLE terms_acceptances ENABLE ROW LEVEL SECURITY;

-- Bidder/operator can see their own consent records
CREATE POLICY "terms_acceptances: user reads own"
  ON terms_acceptances
  FOR SELECT
  USING (user_id = auth.uid());

-- Only inserts via record_consent() RPC (SECURITY DEFINER). No direct user insert.
-- No DELETE allowed — audit trail is immutable.

-- ---------------------------------------------------------------------------
-- Seed version=1 rows for each legal document (published=FALSE)
-- content_hash is a placeholder until the markdown is finalised by lawyer.
-- ---------------------------------------------------------------------------
INSERT INTO policy_versions (slug, version, content_hash, effective_at, published)
VALUES
  ('terms',              1, 'pending-lawyer-review', now(), FALSE),
  ('privacy',            1, 'pending-lawyer-review', now(), FALSE),
  ('bidder-agreement',   1, 'pending-lawyer-review', now(), FALSE),
  ('operator-agreement', 1, 'pending-lawyer-review', now(), FALSE),
  ('dmca-policy',        1, 'pending-lawyer-review', now(), FALSE)
ON CONFLICT (slug, version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- RPC: get_active_policy_versions()
-- Returns the latest published version per slug. Callable anonymously so
-- the signup UI can fetch current versions before the user authenticates.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_active_policy_versions()
RETURNS TABLE (slug TEXT, version INT, effective_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT ON (slug)
    slug,
    version,
    effective_at
  FROM policy_versions
  WHERE published = TRUE
  ORDER BY slug, effective_at DESC;
$$;

GRANT EXECUTE ON FUNCTION get_active_policy_versions() TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- RPC: record_consent(p_slug, p_version, p_consent_method)
-- SECURITY DEFINER so it can write to terms_acceptances even from the
-- signup flow where the user may have just been created. Pulls user identity
-- from auth.uid() and captures IP + UA from PostgREST request headers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_consent(
  p_slug           TEXT,
  p_version        INT,
  p_consent_method TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id   UUID;
  v_ip        TEXT;
  v_ua        TEXT;
  v_id        UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'record_consent: caller is not authenticated';
  END IF;

  -- PostgREST exposes request headers via current_setting(); tolerate missing.
  BEGIN
    v_ip := current_setting('request.headers.x-forwarded-for', true);
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
  END;

  BEGIN
    v_ua := current_setting('request.headers.user-agent', true);
  EXCEPTION WHEN OTHERS THEN
    v_ua := NULL;
  END;

  INSERT INTO terms_acceptances (user_id, slug, version, ip_address, user_agent, consent_method)
  VALUES (v_user_id, p_slug, p_version, v_ip, v_ua, p_consent_method)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION record_consent(TEXT, INT, TEXT) TO authenticated;
