-- Enable pg_cron, then add the two table-backed work queues that replace
-- BullMQ. Notifications already ride the existing notifications_outbox
-- table; this migration adds the two queues that need their own state.
--
-- Why table-backed queues instead of pgmq:
--   1. The notifications_outbox pattern is already battle-tested here.
--   2. We get RLS, foreign keys, and standard observability (SELECT *) for free.
--   3. pgmq's killer features (visibility timeout, atomic VT renewal) only
--      pay off when many concurrent consumers race for messages — not our
--      shape, which is one pg_cron drain at a time.
--   4. One less Supabase extension to depend on long-term.

-- pg_cron is available in Supabase prod but not in CI's vanilla postgres image.
-- The DO block attempts the extension; if unavailable it silently continues so
-- that the rest of this migration (queue tables, RLS) still applies in CI.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION
  WHEN feature_not_supported THEN NULL; -- extension not compiled in
  WHEN others THEN
    IF SQLERRM NOT LIKE '%extension "pg_cron" is not available%'
       AND SQLERRM NOT LIKE '%could not open extension control file%' THEN
      RAISE;
    END IF;
END;
$$;

-- Product cache warm queue. Replaces BullMQ 'product-cache-warm'.
-- Each row is one UPC to enrich via eBay's API. UPC is the primary key
-- so duplicate enqueues collapse — same de-dup semantics as BullMQ's
-- jobId. Drained by a Cloudflare Worker /api/cron/cache-warm-drain
-- route since it needs to fetch eBay.
CREATE TABLE IF NOT EXISTS public.product_cache_warm_jobs (
  upc text PRIMARY KEY,
  source text NOT NULL DEFAULT 'import',
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  attempt_count int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error text
);

-- Partial index for the drain SELECT — only rows that haven't permanently
-- failed. Keeps the scan tiny once attempt_count saturates.
CREATE INDEX IF NOT EXISTS product_cache_warm_jobs_pending_idx
  ON public.product_cache_warm_jobs (enqueued_at)
  WHERE attempt_count < 5;

-- Build-invoice queue. Replaces BullMQ 'build-invoices' with debounced
-- per-auction semantics. finalize_due_lots() upserts here when a lot
-- wins; multiple staggered closes in the same auction coalesce into one
-- run_at (the latest), giving us the same 30s debounce as the BullMQ
-- delay used to.
CREATE TABLE IF NOT EXISTS public.build_invoice_jobs (
  auction_id uuid PRIMARY KEY REFERENCES public.auctions(id) ON DELETE CASCADE,
  run_at timestamptz NOT NULL,
  attempt_count int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error text
);

CREATE INDEX IF NOT EXISTS build_invoice_jobs_ready_idx
  ON public.build_invoice_jobs (run_at)
  WHERE attempt_count < 5;

-- Service-role only. No bidder or operator should be able to touch these.
ALTER TABLE public.product_cache_warm_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.build_invoice_jobs ENABLE ROW LEVEL SECURITY;
-- No policies = no access for authenticated/anon. Service role bypasses RLS.
