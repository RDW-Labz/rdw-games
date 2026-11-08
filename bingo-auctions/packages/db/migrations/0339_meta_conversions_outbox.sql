-- 0339 — server-side conversion events for Meta, queued at the source.
--
-- Owner asked for the Pixel and Conversions API so ad spend can be measured
-- and optimised. Today neither exists: a grep for fbq(, connect.facebook.net,
-- fbevents and any CAPI endpoint returns nothing, so Meta currently cannot be
-- told that anything happened, and its delivery algorithm has nothing to learn
-- from.
--
-- ── WHY THE EVENTS COME OFF THE DATABASE, NOT AN HTTP ROUTE ──────────────────
-- The obvious place to fire a conversion is the request handler that caused
-- it. There isn't one. `place_bid(uuid, bigint)` is a SECURITY DEFINER RPC the
-- bidder app and the web client call directly against PostgREST — no Next.js
-- route sits in that path — and a browser Pixel cannot cover it either,
-- because most bidding happens in the native app where there is no browser.
--
-- So the only place that sees every bid, from every client, is Postgres. These
-- triggers enqueue; a cron drain delivers. That also makes delivery
-- retryable and keeps a network call off the bidding hot path, which matters:
-- 23.6% of all bids land in the final minute-rush before a lot closes, and a
-- slow Graph API call there would be felt by the bidder.
--
-- ── WHICH EVENTS, AND WHY THESE ─────────────────────────────────────────────
-- Measured before choosing, because Meta needs roughly 50 conversions per ad
-- set per week to leave the learning phase:
--
--   Purchase             ~1,610/wk   dense, carries value
--   Lead (first bid)     21-30/wk    the event that actually creates value,
--                                    but currently BELOW the learning floor
--   CompleteRegistration ~25/wk      sparse
--
-- First-bid is the true value event — a bidder is worth $233 lifetime against
-- an $8.64 average sale — but at 21-30/wk it cannot carry optimisation alone.
-- Emitting all three lets the dense one (Purchase, with value) drive learning
-- and value-based lookalikes off the high-LTV buyers, while Lead stays
-- available as the optimisation target once volume supports it. Choosing the
-- target is a campaign setting, not a schema change.
--
-- ── NO PII IN THIS TABLE ────────────────────────────────────────────────────
-- The outbox stores the bidder id and lets the drain resolve and hash contact
-- details at send time. Meta requires SHA-256 of email/phone, never plaintext,
-- and this table is one more place a raw email would otherwise sit at rest.

BEGIN;

CREATE TABLE IF NOT EXISTS public.meta_events_outbox (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Meta's standard event name: Purchase / Lead / CompleteRegistration.
  event_name     TEXT NOT NULL CHECK (event_name IN ('Purchase', 'Lead', 'CompleteRegistration')),
  -- Deduplication key shared with the browser Pixel when both fire. Meta
  -- collapses a server and browser event carrying the same event_id, which is
  -- what stops double-counting once the Pixel is live.
  event_id       TEXT NOT NULL UNIQUE,
  bidder_id      UUID REFERENCES public.bidders(id) ON DELETE SET NULL,
  -- Cents, for Purchase. Null on the others; Meta treats a valueless event as
  -- a plain conversion, which is correct for a signup.
  value_cents    BIGINT,
  -- When the thing actually happened. Meta rejects events older than 7 days,
  -- so the drain checks this rather than assuming the queue is short.
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at        TIMESTAMPTZ,
  attempt_count  INT NOT NULL DEFAULT 0,
  last_error     TEXT
);

-- The drain's only query: unsent, oldest first.
CREATE INDEX IF NOT EXISTS meta_events_outbox_pending_idx
  ON public.meta_events_outbox (occurred_at)
  WHERE sent_at IS NULL;

-- Nothing but the service role touches this. No policies: RLS on with zero
-- policies denies every anon/authenticated read, and the drain runs as
-- service_role which bypasses RLS. Same posture as `workers`.
ALTER TABLE public.meta_events_outbox ENABLE ROW LEVEL SECURITY;

-- ── Lead: the bidder's FIRST manual bid ─────────────────────────────────────
-- `place_bid` also inserts proxy rows on OTHER bidders' behalf when a max bid
-- is outbid (see apps/operator-web/src/app/profile/my-bids/page.tsx), so
-- is_auto rows are not a human deciding to bid and must not count — including
-- for "was this their first", or an auto-row would consume the milestone and
-- the real first bid would never fire.
CREATE OR REPLACE FUNCTION public.enqueue_meta_first_bid()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.is_auto, false) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM bids b
    WHERE b.bidder_id = NEW.bidder_id
      AND COALESCE(b.is_auto, false) = false
      AND b.id <> NEW.id
      AND b.placed_at <= NEW.placed_at
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO meta_events_outbox (event_name, event_id, bidder_id, occurred_at)
  VALUES ('Lead', 'firstbid:' || NEW.bidder_id::text, NEW.bidder_id, NEW.placed_at)
  ON CONFLICT (event_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_meta_first_bid ON public.bids;
CREATE TRIGGER trg_meta_first_bid
  AFTER INSERT ON public.bids
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_meta_first_bid();

-- ── Purchase: an invoice becomes paid ───────────────────────────────────────
-- Keyed on the invoice, so the Square webhook re-firing payment.updated (which
-- it does on every refund — see mig 0331) cannot enqueue a second Purchase.
CREATE OR REPLACE FUNCTION public.enqueue_meta_purchase()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- invoice_status is an ENUM. An earlier cut of this wrote
  -- `COALESCE(OLD.status, '')`, which asks Postgres to coerce '' into that
  -- enum and throws 22P02 — inside an AFTER UPDATE trigger, that aborts the
  -- UPDATE, so it would have failed EVERY invoice status change in
  -- production, including every payment. Caught by exercising the trigger
  -- against a real invoice in a rolled-back transaction rather than reading
  -- it and calling it obvious.
  --
  -- IS DISTINCT FROM is null-safe and never leaves the enum's own type.
  IF NEW.status IS DISTINCT FROM 'paid'::invoice_status
     OR OLD.status IS NOT DISTINCT FROM 'paid'::invoice_status THEN
    RETURN NEW;
  END IF;

  INSERT INTO meta_events_outbox (event_name, event_id, bidder_id, value_cents, occurred_at)
  VALUES (
    'Purchase',
    'invoice:' || NEW.id::text,
    NEW.bidder_id,
    NEW.total_cents,
    COALESCE(NEW.paid_at, now())
  )
  ON CONFLICT (event_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_meta_purchase ON public.invoices;
CREATE TRIGGER trg_meta_purchase
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_meta_purchase();

-- ── CompleteRegistration: a bidder account is created ───────────────────────
CREATE OR REPLACE FUNCTION public.enqueue_meta_registration()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO meta_events_outbox (event_name, event_id, bidder_id, occurred_at)
  VALUES ('CompleteRegistration', 'signup:' || NEW.id::text, NEW.id, COALESCE(NEW.created_at, now()))
  ON CONFLICT (event_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_meta_registration ON public.bidders;
CREATE TRIGGER trg_meta_registration
  AFTER INSERT ON public.bidders
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_meta_registration();

COMMIT;
