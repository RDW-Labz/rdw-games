-- 0341 — give the Conversions API something to attribute a click to.
--
-- The events shipped in 0339 carry hashed email, phone and a bidder id. Meta
-- can match those to a PERSON, but it cannot tie the conversion back to the ad
-- CLICK that caused it, because nothing in the payload came from the browser
-- session that clicked. The practical result is that Ads Manager under-reports:
-- real conversions land, fewer get credited to the campaign that produced them,
-- and a campaign that is working can look like one that is not. That is the
-- most expensive kind of measurement error — it argues for switching off the
-- thing that is making money.
--
-- _fbp and _fbc are the two cookies Meta's own Pixel sets for exactly this
-- purpose:
--   _fbp — browser id, set on first Pixel load ("fb.1.<ts>.<random>")
--   _fbc — click id, set only when the landing URL carried ?fbclid=...
--          ("fb.1.<ts>.<fbclid>"), so its presence means "this person arrived
--          from a Meta ad" and it is the field that actually earns attribution.
--
-- ── WHY THESE COLUMNS AND NOT AN IP ADDRESS ─────────────────────────────────
-- Meta's other route to good website-event matching is client_ip_address plus
-- client_user_agent. That was deliberately not taken. Storing bidder IPs would
-- be a new category of personal information collected for advertising, and the
-- privacy policy would have to grow a paragraph about it. _fbp/_fbc are
-- identifiers Meta itself already set in that browser and already reads; they
-- add no new surveillance surface, and the policy amendment is one sentence.
--
-- ── OPT-OUT ─────────────────────────────────────────────────────────────────
-- The BELOW trigger clears both values when a bidder opts out. Retaining an
-- advertising click id for someone who has said "do not share" would be the
-- same violation as sending it — the opt-out has to erase the identifier, not
-- merely stop reading it. Capture is refused at the API layer too, so an
-- opted-out bidder can never repopulate them.

BEGIN;

ALTER TABLE public.bidders
  ADD COLUMN IF NOT EXISTS meta_fbp TEXT,
  ADD COLUMN IF NOT EXISTS meta_fbc TEXT,
  ADD COLUMN IF NOT EXISTS meta_attribution_at TIMESTAMPTZ;

COMMENT ON COLUMN public.bidders.meta_fbp IS
  'Meta _fbp browser cookie, raw. Sent unhashed in Conversions API user_data.';
COMMENT ON COLUMN public.bidders.meta_fbc IS
  'Meta _fbc click cookie, raw. Present only if the bidder arrived via an ad click (fbclid).';
COMMENT ON COLUMN public.bidders.meta_attribution_at IS
  'When the click identifiers were last captured. Used to prefer a fresher _fbc.';

-- Opting out erases the identifiers rather than leaving them for later.
--
-- Separate from 0340's trigger on purpose: that one is AFTER UPDATE, which
-- cannot alter the row, and retiming it would change the semantics of the
-- outbox suppression it already performs. A BEFORE trigger is also the only
-- place where clearing costs no extra write.
CREATE OR REPLACE FUNCTION public.clear_meta_attribution_on_opt_out()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.ad_tracking_opt_out AND NOT COALESCE(OLD.ad_tracking_opt_out, false) THEN
    NEW.meta_fbp := NULL;
    NEW.meta_fbc := NULL;
    NEW.meta_attribution_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_clear_meta_attribution_on_opt_out ON public.bidders;
CREATE TRIGGER trg_clear_meta_attribution_on_opt_out
  BEFORE UPDATE OF ad_tracking_opt_out ON public.bidders
  FOR EACH ROW EXECUTE FUNCTION public.clear_meta_attribution_on_opt_out();

COMMIT;
