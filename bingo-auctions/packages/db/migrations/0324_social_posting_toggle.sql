-- 0324 — the social posting kill switch, defaulting OFF.
--
-- The runner (lib/social/runner.ts) gates on this. Without the column the gate
-- query errors, the result is null, and the run proceeds — a kill switch that
-- fails OPEN. For something that publishes publicly as the business several
-- times a day, that is the wrong direction to fail.
--
-- DEFAULT FALSE is deliberate and is the point of this migration. The Meta
-- credentials are being created right now; the moment they land in Worker
-- secrets the runner would otherwise start posting to the real Page on its next
-- cron fire, with copy nobody has read and against lots nobody has reviewed.
-- Posting is a one-way action — a deleted post was still seen — so it should
-- begin because a person switched it on, not because a secret appeared.
--
-- Turn it on from /marketing once a dry run looks right:
--   ?dry_run=1 on the cron route exercises selection, composition and row
--   writing without publishing anything.

BEGIN;

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS social_posting_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.platform_settings.social_posting_enabled IS
  '0324: master switch for organic social posting (FB Page / Instagram). '
  'Defaults FALSE — publishing starts only when a person enables it, never '
  'merely because credentials were configured.';

COMMIT;
