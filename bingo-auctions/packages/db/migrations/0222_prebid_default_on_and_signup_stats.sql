-- 0222 — pre-bidding on by default + bidder signup stats RPC
--
-- Owner, 2026-07-04 (same evening 0221 shipped): "set it to where we default
-- that way and the auctions we made can have bids now" + "how can I see how
-- many bidders sign up".
--
-- 1. auctions.prebid_enabled DEFAULT true — every new auction (manual form,
--    auto-build, any path that doesn't set the column) allows preview
--    bidding. The console checkbox still turns it off per auction.
-- 2. Backfill: every existing draft/scheduled auction flips to
--    prebid_enabled = true, so the already-built auctions accept bids
--    immediately. Live/closed auctions are untouched (the flag only matters
--    before starts_at).
-- 3. bidder_signup_stats() — SECURITY DEFINER, operator-staff-gated counts
--    for the console Bidders page header. The Bidders page previously
--    derived its roster from PAID invoices only, so fresh signups were
--    invisible to the operator. BinGo is single-operator: platform-wide
--    bidder counts ARE the operator's counts. Tombstoned (deleted_at)
--    accounts are excluded. Returns no PII — counts only.
--
-- Idempotent: SET DEFAULT + scoped UPDATE + CREATE OR REPLACE.

BEGIN;

ALTER TABLE public.auctions
  ALTER COLUMN prebid_enabled SET DEFAULT true;

UPDATE public.auctions
SET prebid_enabled = true
WHERE status IN ('draft', 'scheduled')
  AND prebid_enabled = false;

CREATE OR REPLACE FUNCTION public.bidder_signup_stats()
RETURNS TABLE (
  total_bidders  bigint,
  last_7_days    bigint,
  last_24_hours  bigint,
  with_card      bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Operator staff only — the console Bidders page is the sole caller.
  IF NOT EXISTS (
    SELECT 1 FROM public.operator_users ou WHERE ou.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    count(*)::bigint,
    count(*) FILTER (WHERE b.created_at > now() - interval '7 days')::bigint,
    count(*) FILTER (WHERE b.created_at > now() - interval '24 hours')::bigint,
    count(*) FILTER (WHERE b.default_payment_method_id IS NOT NULL)::bigint
  FROM public.bidders b
  WHERE b.deleted_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.bidder_signup_stats() TO authenticated;

COMMIT;
