-- ============================================================================
-- 0074_stock_images_bucket — self-hosted stock product images
--
-- Why this exists:
--   The platform was hot-linking product images from retailer CDNs
--   (media.mac.bid, m.media-amazon.com, etc.). That works in dev but
--   creates three problems at launch:
--     1. CDN owners may block our Worker IPs without notice → broken
--        images for every operator.
--     2. URLs rotate (Amazon refreshes its CDN keys, mac.bid moves
--        items between buckets) → 404s for cached product_lookups rows.
--     3. Some retailers' ToS forbid hotlinking — a polite cease & desist
--        becomes a noisy fix-it migration later.
--
-- Solution:
--   A new `stock-images` Supabase Storage bucket that holds a copy of
--   every stock photo the platform references. Server-side mirroring
--   (see packages/domain-lotting/src/lookup/mirror-images.ts) fetches
--   each retailer URL once, computes its SHA-256, and uploads to this
--   bucket at `<hash>.<ext>`. The hash filename gives automatic dedupe
--   across operators — two operators scanning the same product share
--   the same physical bytes.
--
-- Read access:
--   PUBLIC. These are product photos shown to bidders on every lot
--   page; no auth needed.
--
-- Write access:
--   Service role ONLY. The mirror helper runs server-side from
--   operator-web's Cloudflare Worker (and field-mobile via the API
--   proxy). Bidders, operator staff, and pickers never write here
--   directly — they upload to `lot-photos` and friends instead, which
--   have their own RLS policies (migration 0004).
--
-- Object path convention:
--   `<sha256>.<ext>` at the bucket root. Flat namespace because the
--   hash is globally unique; no operator prefix needed (and we want
--   cross-operator dedupe).
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'stock-images',
  'stock-images',
  true,                                   -- public read
  10 * 1024 * 1024,                       -- 10MB max (way above any product photo)
  ARRAY[                                  -- still allow only image types
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Read policy: bucket is public, but RLS on storage.objects still
-- requires an explicit policy. Anyone (anon, authenticated, or service
-- role) can read.
DROP POLICY IF EXISTS "stock-images public read" ON storage.objects;
CREATE POLICY "stock-images public read" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'stock-images');

-- Write/delete policies: no rows for non-service-role callers. The
-- service role bypasses RLS entirely, so the mirror helper just works.
-- (We deliberately do NOT add an authenticated-user write policy —
-- preventing accidental client-side uploads to this bucket.)

INSERT INTO _schema_migrations (filename, applied_by)
VALUES ('0074_stock_images_bucket.sql', 'manual')
ON CONFLICT (filename) DO NOTHING;
