-- Rollback for 0448_bidder_optional_profile.sql (file lives in
-- ~/Documents/bingo-migrations-pending/, owner-copied — not in this repo).
--
-- Revert the app/web release that calls set_my_optional_profile first, or
-- make sure it is not live: both fail soft when the RPC is missing (the
-- optional-profile step never appears, profile screen hides those fields),
-- same pattern as 0434.
--
-- DESTRUCTIVE: dropping the columns deletes every phone / SMS-consent record
-- / heard-about answer bidders have given through this flow. Export first if
-- they should be kept (sms_consent_at especially — that is the TCPA-style
-- consent record):
--   SELECT id, phone, sms_consent_at, sms_consent_text_version,
--          heard_about, heard_about_other, optional_profile_prompted_at
--     FROM public.bidders
--    WHERE sms_consent_at IS NOT NULL OR heard_about IS NOT NULL;
--
-- Locks: DROP COLUMN takes a brief ACCESS EXCLUSIVE on bidders (metadata-only,
-- no rewrite). Window: 05:00–07:00 CT, or any hour if 0448 is actively
-- breaking something (this migration's own grants are additive-only — it
-- never touched the 0435 lockdown — so a 0448 rollback should never be urgent
-- on its own).
--
-- NOTE: phone is NOT dropped here — it is 0435's column (bidders may update
-- it directly), not 0448's; set_my_optional_profile merely also writes it.
-- Rolling back 0448 removes the RPC and the four new columns; phone itself,
-- and whatever value is in it, is untouched.

SET lock_timeout = '3s';

BEGIN;

DROP FUNCTION IF EXISTS public.set_my_optional_profile(text, boolean, text, text, text);

ALTER TABLE public.bidders
  DROP CONSTRAINT IF EXISTS bidders_sms_consent_needs_version,
  DROP CONSTRAINT IF EXISTS bidders_heard_about_other_length,
  DROP CONSTRAINT IF EXISTS bidders_heard_about_allowed,
  DROP COLUMN IF EXISTS optional_profile_prompted_at,
  DROP COLUMN IF EXISTS heard_about_other,
  DROP COLUMN IF EXISTS heard_about,
  DROP COLUMN IF EXISTS sms_consent_text_version,
  DROP COLUMN IF EXISTS sms_consent_at;

COMMIT;
