// upsert-photo-to-catalog.ts
//
// Upsert a photo URL to product_lookups for a given identifier.
// Format-coupled: stores ASIN as 'asin:B0XXXXXXXX' per existing catalog convention.
// Idempotent: skips if URL already in image_urls.
//
// Why cross-operator: when operator A's staff takes a photo of UPC=X (or a
// successful enrichment fires for UPC=X), other operators scanning UPC=X
// later get that photo automatically via drain step 1.5 (catalog read-through).
// Self-warming catalog.
//
// Service-role requirement: product_lookups RLS write policy requires
// current_operator_id() IS NOT NULL — which the service-role key bypasses.
// All callers must pass a service-role admin client.

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalisePhotoUrl } from '@/lib/imports/normalise-photo-url';

export type IdentifierKind = 'upc' | 'asin' | 'isbn';

export type PhotoSource =
  | 'staff_photo'
  | 'enrichment_amazon'
  | 'enrichment_openfoodfacts'
  | 'enrichment_openlibrary'
  | 'enrichment_musicbrainz';

export interface UpsertPhotoOptions {
  /** Service-role client — RLS bypass needed for cross-operator write. */
  admin: SupabaseClient;
  identifierKind: IdentifierKind;
  identifierValue: string;
  photoUrl: string;
  source: PhotoSource;
  /** Operator who contributed (logged but does not gate visibility). */
  contributedByOperatorId?: string;
}

export type UpsertPhotoResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_url' | 'already_in_catalog' | 'db_error'; detail?: string };

type CatalogRow = {
  upc: string;
  image_urls: string[];
  sources: string[];
};

/**
 * Write a photo URL into the platform-global product_lookups catalog.
 *
 * If no row exists for the identifier, inserts a minimal seed row
 * (image only — no title/pricing).  If a row exists, appends the URL
 * to image_urls and merges the source tag, both idempotently.
 *
 * Never throws — callers can fire-and-forget safely.
 */
export async function upsertPhotoToCatalog(
  opts: UpsertPhotoOptions,
): Promise<UpsertPhotoResult> {
  // Validate URL through the same normaliser used everywhere else.
  const url = normalisePhotoUrl(opts.photoUrl);
  if (!url) return { ok: false, reason: 'invalid_url' };

  // Catalog primary-key convention: ASIN is stored as 'asin:B0XXXXXXXX'.
  // UPC/ISBN/EAN are stored as their raw digit string.
  const catalogKey =
    opts.identifierKind === 'asin'
      ? `asin:${opts.identifierValue}`
      : opts.identifierValue;

  try {
    // Fetch the existing row to check for the URL before we write.
    const { data: existing, error: fetchErr } = await opts.admin
      .from('product_lookups')
      .select('upc, image_urls, sources')
      .eq('upc', catalogKey)
      .maybeSingle<CatalogRow>();

    if (fetchErr) {
      console.error('[upsert-photo-to-catalog] fetch failed:', fetchErr.message);
      return { ok: false, reason: 'db_error', detail: fetchErr.message };
    }

    if (existing) {
      // Idempotency guard — skip if the URL is already present.
      if (existing.image_urls.includes(url)) {
        return { ok: false, reason: 'already_in_catalog' };
      }

      // Append the new URL and merge the source tag (deduplicated).
      const { error: updateErr } = await opts.admin
        .from('product_lookups')
        .update({
          image_urls: [...existing.image_urls, url],
          sources: Array.from(new Set([...existing.sources, opts.source])),
          // updated_at is managed by the product_lookups_touch_updated_at trigger
          // but we set identity_refreshed_at to now so it's clear this row was
          // touched with new photo data.
          identity_refreshed_at: new Date().toISOString(),
        })
        .eq('upc', catalogKey);

      if (updateErr) {
        console.error('[upsert-photo-to-catalog] update failed:', updateErr.message);
        return { ok: false, reason: 'db_error', detail: updateErr.message };
      }

      return { ok: true };
    }

    // No existing row — insert a seed row with just the image.
    // title/brand/pricing remain NULL; the enrichment pipeline or a
    // subsequent lookup will fill those in via the existing upsertLookup
    // path once a real enrichment fires.
    const { error: insertErr } = await opts.admin
      .from('product_lookups')
      .insert({
        upc: catalogKey,
        image_urls: [url],
        sources: [opts.source],
        // 'medium' reflects that a staff photo or verified enrichment
        // provides a reasonable signal even without full title/pricing.
        confidence: 'medium',
        identity_refreshed_at: new Date().toISOString(),
      });

    if (insertErr) {
      console.error('[upsert-photo-to-catalog] insert failed:', insertErr.message);
      return { ok: false, reason: 'db_error', detail: insertErr.message };
    }

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[upsert-photo-to-catalog] unexpected error:', msg);
    return { ok: false, reason: 'db_error', detail: msg };
  }
}
