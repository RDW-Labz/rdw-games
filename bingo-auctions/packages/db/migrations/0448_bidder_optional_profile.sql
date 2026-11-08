-- 0448 — bidders: optional profile fields offered once after the mandatory
-- ZIP step (phone + explicit SMS consent, "how did you hear about us?").
--
-- WHY
--   PR "Bidders: ZIP required once before the next bid or checkout; optional
--   phone (with text consent) and how-you-heard". After the bidder saves a
--   ZIP (0434), the app/web offer — once, skippable — a phone number with an
--   EXPLICIT, separate, unchecked text-message consent checkbox, and a fixed-
--   choice "how did you hear about us?" question. Phone alone is never
--   consent; no box, no texts, no consent record.
--
-- WHAT
--   1. bidders gets five new columns:
--        sms_consent_at             when the bidder checked the SMS consent
--                                   box (NULL = never consented via this
--                                   flow).
--        sms_consent_text_version   the exact consent copy version shown at
--                                   that moment (packages/shared's
--                                   SMS_CONSENT_TEXT_VERSION) — NOT NULL
--                                   whenever sms_consent_at is, so a consent
--                                   row is always traceable to the words the
--                                   bidder actually read, even after the
--                                   copy is revised in a later app build.
--        heard_about                one of a fixed set of codes, or 'other'.
--        heard_about_other          free text, <= 100 chars, only meaningful
--                                   when heard_about = 'other'.
--        optional_profile_prompted_at
--                                   when the bidder was first offered this
--                                   step (Skip counts) — makes "offered once"
--                                   possible without re-asking a bidder who
--                                   already said no thanks.
--   2. set_my_optional_profile(...): the only way any of the five columns are
--      written. "Skip" calls it with every argument at its default (still
--      stamps optional_profile_prompted_at so the step isn't shown again);
--      "Save" calls it with whichever fields the bidder filled in.
--
-- ── WHO CAN WRITE THESE COLUMNS ──────────────────────────────────────────────
--   Unlike 0434's postal_code (which needed a guard trigger because, at the
--   time, `authenticated` still held a table-level UPDATE grant — see that
--   migration's header), 0435 already REVOKEd UPDATE on bidders from anon and
--   authenticated and re-granted it back on exactly seven named columns. These
--   five new columns are simply never added to that re-grant, so a direct
--   PostgREST UPDATE on them is already rejected by Postgres's own privilege
--   check (missing table-level AND missing column-level UPDATE) — no trigger
--   needed. Only set_my_optional_profile (SECURITY DEFINER, so it runs as the
--   function owner, not as `authenticated`) can write them. phone is already
--   column-UPDATE-granted by 0435 (profile/edit.tsx writes it directly); this
--   RPC updates it too so one Save tap is one round trip, but that does not
--   change who may write phone — both paths remain "the bidder, their own
--   row" under RLS bidders_self_update (0133).
--
-- ── VALIDATION ───────────────────────────────────────────────────────────────
--   heard_about: CHECK against the fixed list (also enforced in the RPC, so
--     the bidder gets 22023 invalid_heard_about instead of a raw constraint
--     violation). heard_about_other: CHECK <= 100 chars (RPC also truncates,
--     belt and suspenders — a client bug must not 500 the whole call).
--   sms_consent_text_version: CHECK that it is set whenever sms_consent_at is
--     — a consent timestamp with no recorded copy version is a compliance gap
--     this table must not allow, even via a future direct service-role write.
--
-- ── LOCKS (Rule 9) ───────────────────────────────────────────────────────────
--   ALTER TABLE bidders takes a brief ACCESS EXCLUSIVE lock (every bid, login
--   and checkout reads bidders). Column adds are metadata-only (nullable, no
--   default); VALIDATE CONSTRAINT scans once (~1.4k rows, all NULL — instant).
--   lock_timeout 3s: fails fast instead of queueing bids behind a long
--   transaction — just rerun. Window: 05:00–07:00 CT (DB-lock window; this
--   migration needs no app release to go first — the ZIP block itself needs
--   no migration at all, and the app/web fail soft before this one is applied,
--   same pattern as 0434).
--
-- Rollback: scripts/prod-rig/0448_ROLLBACK_bidder_optional_profile.sql
-- Proven on the Docker rig (rig0431, scratch db s0448, postgres template +
-- 0434 + 0435 + 0436 + 0438 applied first, since the template predates all
-- four): clean apply, set_my_optional_profile exercised for skip / phone-only
-- / consent / heard_about='other' / switching away from 'other' (clears
-- heard_about_other), and direct-UPDATE-denied confirmed for every new column
-- as `authenticated`.

SET lock_timeout = '3s';

BEGIN;

-- ── 1. Columns ──────────────────────────────────────────────────────────────

ALTER TABLE public.bidders
  ADD COLUMN IF NOT EXISTS sms_consent_at               timestamptz NULL,
  ADD COLUMN IF NOT EXISTS sms_consent_text_version     text NULL,
  ADD COLUMN IF NOT EXISTS heard_about                  text NULL,
  ADD COLUMN IF NOT EXISTS heard_about_other             text NULL,
  ADD COLUMN IF NOT EXISTS optional_profile_prompted_at timestamptz NULL,
  DROP CONSTRAINT IF EXISTS bidders_heard_about_allowed,
  ADD CONSTRAINT bidders_heard_about_allowed
    CHECK (heard_about IS NULL OR heard_about IN (
      'bingo_customer', 'friend_referral', 'social_media',
      'search_engine', 'drive_by', 'other'
    )) NOT VALID,
  DROP CONSTRAINT IF EXISTS bidders_heard_about_other_length,
  ADD CONSTRAINT bidders_heard_about_other_length
    CHECK (heard_about_other IS NULL OR char_length(heard_about_other) <= 100) NOT VALID,
  DROP CONSTRAINT IF EXISTS bidders_sms_consent_needs_version,
  ADD CONSTRAINT bidders_sms_consent_needs_version
    CHECK (sms_consent_at IS NULL OR sms_consent_text_version IS NOT NULL) NOT VALID;

ALTER TABLE public.bidders VALIDATE CONSTRAINT bidders_heard_about_allowed;
ALTER TABLE public.bidders VALIDATE CONSTRAINT bidders_heard_about_other_length;
ALTER TABLE public.bidders VALIDATE CONSTRAINT bidders_sms_consent_needs_version;

COMMENT ON COLUMN public.bidders.sms_consent_at IS
  '0448: when the bidder checked the explicit SMS-consent box. NULL = no '
  'consent on record via this flow — never infer consent from phone alone. '
  'Written only via set_my_optional_profile().';
COMMENT ON COLUMN public.bidders.sms_consent_text_version IS
  '0448: packages/shared SMS_CONSENT_TEXT_VERSION the bidder actually saw '
  'when they consented. Required whenever sms_consent_at is set.';
COMMENT ON COLUMN public.bidders.heard_about IS
  '0448: fixed-choice "how did you hear about us?" code, or ''other''. '
  'Written only via set_my_optional_profile().';
COMMENT ON COLUMN public.bidders.heard_about_other IS
  '0448: free text (<= 100 chars), meaningful only when heard_about = ''other''.';
COMMENT ON COLUMN public.bidders.optional_profile_prompted_at IS
  '0448: when the bidder was first offered the optional profile step '
  '(phone/SMS consent/heard-about). Set on Skip too, so it is offered once.';

-- ── 2. set_my_optional_profile ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_my_optional_profile(
  p_phone                    text    DEFAULT NULL,
  p_sms_consent              boolean DEFAULT false,
  p_sms_consent_text_version text    DEFAULT NULL,
  p_heard_about              text    DEFAULT NULL,
  p_heard_about_other        text    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid         uuid := auth.uid();
  v_phone       text := nullif(btrim(coalesce(p_phone, '')), '');
  v_heard       text := nullif(btrim(coalesce(p_heard_about, '')), '');
  v_heard_other text;
  v_version     text := nullif(btrim(coalesce(p_sms_consent_text_version, '')), '');
  v_row         bidders%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  IF v_heard IS NOT NULL AND v_heard NOT IN (
    'bingo_customer', 'friend_referral', 'social_media',
    'search_engine', 'drive_by', 'other'
  ) THEN
    RAISE EXCEPTION 'invalid_heard_about' USING ERRCODE = '22023';
  END IF;

  -- Belt and suspenders with the CHECK constraint above: truncate here too so
  -- a too-long value fails with a clear error code, not a raw constraint
  -- violation from PostgREST.
  v_heard_other := CASE WHEN v_heard = 'other'
                        THEN left(nullif(btrim(coalesce(p_heard_about_other, '')), ''), 100)
                        ELSE NULL END;

  IF p_sms_consent AND v_version IS NULL THEN
    RAISE EXCEPTION 'consent_version_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM bidders WHERE id = v_uid AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bidder_not_found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE bidders SET
    phone = coalesce(v_phone, v_row.phone),
    -- No consent box checked this call → leave whatever is already on
    -- record untouched (never silently granted, never silently revoked by
    -- an unrelated Save).
    sms_consent_at = CASE WHEN p_sms_consent THEN now() ELSE v_row.sms_consent_at END,
    sms_consent_text_version =
      CASE WHEN p_sms_consent THEN v_version ELSE v_row.sms_consent_text_version END,
    -- heard_about not provided this call (Skip, or a phone/consent-only Save)
    -- → preserve whatever was already recorded. Provided → replace, and
    -- heard_about_other follows it (cleared when switching away from
    -- 'other', so a stale free-text answer never outlives its reason code).
    heard_about = coalesce(v_heard, v_row.heard_about),
    heard_about_other = CASE WHEN v_heard IS NULL THEN v_row.heard_about_other ELSE v_heard_other END,
    optional_profile_prompted_at = coalesce(v_row.optional_profile_prompted_at, now())
  WHERE id = v_uid;
END;
$function$;

COMMENT ON FUNCTION public.set_my_optional_profile(text, boolean, text, text, text) IS
  '0448: the calling bidder sets their own optional phone / SMS consent / '
  'how-they-heard-about-us. Skip calls this with every argument defaulted — '
  'still stamps optional_profile_prompted_at so the step is offered once. '
  '22023 invalid_heard_about / consent_version_required; 42501 '
  'not_authenticated; P0002 bidder_not_found.';

REVOKE ALL ON FUNCTION public.set_my_optional_profile(text, boolean, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_my_optional_profile(text, boolean, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_my_optional_profile(text, boolean, text, text, text) TO authenticated;

COMMIT;
