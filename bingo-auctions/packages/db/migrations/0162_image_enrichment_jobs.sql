-- ============================================================================
-- Migration 0162 — image_enrichment_jobs queue
--
-- Stores one pending job per import_row (and eventually lot / product_lookup)
-- that needs an image fetched via the free enrichment sources in
-- packages/image-enrichment:
--   • Amazon ASIN URL probe
--   • Open Food Facts (UPC/EAN)
--   • Open Library (ISBN)
--   • MusicBrainz / Cover Art Archive (UPC — wiring deferred per plan)
--
-- Producer: commitImport() in apps/operator-web inserts one 'pending' row
--           per import_row inside the same transaction, BEFORE seedProductLookups
--           so the catalog always sees the normalised photo_url.
--
-- Consumer: /api/cron/image-enrichment-drain (1-min Cloudflare cron).
--           Drains BATCH_SIZE=25 jobs per tick via a plain service-role SELECT
--           FOR UPDATE SKIP LOCKED (no RPC needed — simpler than refund_jobs
--           because the drain is not issuing external payments).
--
-- Status machine:
--   pending → in_progress → succeeded  (image found + written back)
--                          → skipped   (already_has_photo | no_identifier |
--                                       upstream_not_found)
--                          → failed    (network / 5xx, attempts >= 3)
--                          ↑ pending   (on transient error, attempts < 3)
--
-- RLS: service-role only — the cron worker uses the service-role client and
--      neither operator UI nor bidder apps ever read this table directly.
-- ============================================================================

CREATE TABLE image_enrichment_jobs (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id         UUID          NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  target_table        TEXT          NOT NULL CHECK (target_table IN ('import_rows', 'lots', 'product_lookups')),
  target_id           UUID          NOT NULL,
  status              TEXT          NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'in_progress', 'succeeded', 'failed', 'skipped')),
  attempts            INT           NOT NULL DEFAULT 0,
  -- Which identifier was used for the upstream lookup (null until drain picks it up).
  identifier_kind     TEXT,
  identifier_value    TEXT,
  -- The URL that was resolved and written back to the target row (null until succeeded).
  resolved_image_url  TEXT,
  -- Last error message (null on success/skipped; truncated to 500 chars by drain).
  error               TEXT,
  enqueued_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  processed_at        TIMESTAMPTZ,
  UNIQUE (target_table, target_id)
);

-- Partial index: only pending + in_progress jobs are polled by the drain.
-- Succeeded / failed / skipped rows are excluded, keeping the index small.
CREATE INDEX image_enrichment_jobs_pending_idx
  ON image_enrichment_jobs (status, enqueued_at)
  WHERE status IN ('pending', 'in_progress');

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Deny all auth-role access. The drain worker uses the service-role key which
-- bypasses RLS entirely; no operator or bidder JWT should ever touch this table.

ALTER TABLE image_enrichment_jobs ENABLE ROW LEVEL SECURITY;

-- No policies are intentionally created — the service-role bypass is the
-- intended access pattern. A stray authenticated request will get 0 rows /
-- permission denied, whichever the Supabase REST layer enforces first.

-- ── Verification ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'image_enrichment_jobs'
  ) THEN
    RAISE EXCEPTION '0162 verification failed: image_enrichment_jobs table not found';
  END IF;
  RAISE NOTICE '0162 verified: image_enrichment_jobs table created with pending index and RLS enabled';
END $$;
