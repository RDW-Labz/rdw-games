-- 0232 — share-click telemetry (marketing scoreboard)
--
-- Owner, 2026-07-05: "are people using the share buttons?" — clicks were
-- only visible in PostHog, not the console. Tiny append-only counter table,
-- written by POST /api/telemetry/share-click (fire-and-forget beacons from
-- ShareBar / ReferralCard / WinShareCard), read by the /marketing
-- scoreboard. No PII: medium + optional lot_code + timestamp.
--
-- RLS with no policies: writes go through the service-role route, reads
-- through server console code. Idempotent.

CREATE TABLE IF NOT EXISTS public.share_clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which affordance was used. Storefront lot buttons: copy / facebook /
  -- native. Referral surfaces: referral_copy / referral_native / win_copy /
  -- win_native.
  medium TEXT NOT NULL CHECK (medium IN (
    'copy', 'facebook', 'native',
    'referral_copy', 'referral_native',
    'win_copy', 'win_native'
  )),
  lot_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS share_clicks_created_idx ON public.share_clicks (created_at);

ALTER TABLE public.share_clicks ENABLE ROW LEVEL SECURITY;
