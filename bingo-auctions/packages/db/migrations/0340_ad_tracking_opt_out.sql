-- 0340 — the advertising opt-out the privacy policy promises.
--
-- Turning on the Meta Pixel and Conversions API makes BinGo a business that
-- shares personal information for cross-context behavioral advertising, as
-- California law uses that phrase. The privacy policy (Section 8) now says so
-- plainly, and it says you can opt out. This is the thing that makes that
-- sentence true rather than aspirational.
--
-- The prior text said "if our practices change, we will update this policy and
-- provide an opt-out mechanism BEFORE doing so" — so this ships with the
-- policy change and before the Pixel is switched on, not after.
--
-- ── WHY ON bidders, AND WHAT ABOUT VISITORS WHO ARE NOT SIGNED IN ───────────
-- This column covers the server-side half: the Conversions API sends events
-- keyed to a bidder, so the drain can check a bidder column. Signed-out
-- browsing is covered in the browser instead (a local opt-out plus Global
-- Privacy Control), because there is no account to hang a flag on and creating
-- a tracking identity for someone who has asked not to be tracked would be
-- self-defeating.
--
-- Default false is the honest default only because the policy discloses the
-- sharing and offers the control. GPC is honoured automatically on the client,
-- which is the case where a default of "off" is legally required.

BEGIN;

ALTER TABLE public.bidders
  ADD COLUMN IF NOT EXISTS ad_tracking_opt_out BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ad_tracking_opt_out_at TIMESTAMPTZ;

COMMENT ON COLUMN public.bidders.ad_tracking_opt_out IS
  'CCPA "do not share" for advertising. When true, meta-capi-drain must not send this bidder to Meta.';

-- The drain filters on this on every run, over a table that only grows.
CREATE INDEX IF NOT EXISTS bidders_ad_tracking_opt_out_idx
  ON public.bidders (id)
  WHERE ad_tracking_opt_out;

-- An opt-out must also stop events ALREADY queued but not yet delivered.
-- Without this, someone who opts out today still gets sent to Meta tomorrow by
-- rows the triggers enqueued this morning — which is exactly the promise the
-- policy makes and would break. Retiring rather than deleting keeps the audit
-- trail of what was suppressed and why.
CREATE OR REPLACE FUNCTION public.suppress_meta_events_on_opt_out()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.ad_tracking_opt_out AND NOT COALESCE(OLD.ad_tracking_opt_out, false) THEN
    UPDATE meta_events_outbox
       SET sent_at = now(),
           last_error = 'suppressed: bidder opted out of ad tracking'
     WHERE bidder_id = NEW.id
       AND sent_at IS NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_suppress_meta_events_on_opt_out ON public.bidders;
CREATE TRIGGER trg_suppress_meta_events_on_opt_out
  AFTER UPDATE OF ad_tracking_opt_out ON public.bidders
  FOR EACH ROW EXECUTE FUNCTION public.suppress_meta_events_on_opt_out();

COMMIT;
