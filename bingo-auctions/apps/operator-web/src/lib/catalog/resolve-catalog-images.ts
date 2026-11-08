// resolve-catalog-images.ts
//
// Catalog-first image resolver for lot creation (esp. QuickLot).
//
// Given a product identifier (UPC / ASIN / ISBN), returns image URLs from the
// platform-global product_lookups catalog. On a catalog MISS (no row, or a row
// with no image_urls), enriches via the image-enrichment package (Amazon ASIN /
// Open Food Facts UPC / Open Library ISBN / MusicBrainz UPC), writes the found
// images back into the catalog (self-warming), and returns them — so the next
// lot for the same identifier is an instant catalog hit.
//
// Owner model (2026-06-06): "QuickLot should pull the image URLs we upload to
// the catalog; ASINs/UPCs that don't have image URLs get enriched at that point
// so QuickLot can pull the updated record."
//
// Deliberately does NOT touch the search / matching pipeline
// (find_import_row_by_scan, Sonar/OpenRouter lookups) — this is purely catalog
// read-through + image enrichment, keyed by an already-known identifier.
//
// Service-role: product_lookups writes require current_operator_id() IS NOT
// NULL, which the service-role key bypasses (see upsert-photo-to-catalog).
// Callers must pass a service-role admin client.

import type { SupabaseClient } from '@supabase/supabase-js';
import { enrichImages } from '@auction-platform/image-enrichment';
import {
  upsertPhotoToCatalog,
  type IdentifierKind,
  type PhotoSource,
} from '@/lib/catalog/upsert-photo-to-catalog';

export interface ResolveCatalogImagesInput {
  /** Service-role client — RLS bypass needed for the catalog write-back. */
  admin: SupabaseClient;
  upc?: string | null;
  asin?: string | null;
  isbn?: string | null;
  /** Operator attributed for any enrichment write (logged, not gating). */
  contributedByOperatorId?: string;
}

export type ResolveOutcome = 'catalog_hit' | 'enriched' | 'miss';

export interface ResolveCatalogImagesResult {
  imageUrls: string[];
  /** 'catalog_hit' | 'enriched' | 'miss' — for logging/telemetry. */
  outcome: ResolveOutcome;
}

type CatalogRow = { upc: string; image_urls: string[] };

// Catalog primary-key convention (matches upsert-photo-to-catalog): ASIN is
// stored as 'asin:B0XXXXXXXX'; UPC/ISBN/EAN are stored as their raw digits.
function catalogKey(kind: IdentifierKind, value: string): string {
  return kind === 'asin' ? `asin:${value}` : value;
}

// Map an enrichment image source → the identifier kind it was keyed on, and
// the catalog PhotoSource tag to record on write-back.
const SOURCE_TO_KIND: Record<string, IdentifierKind> = {
  amazon: 'asin',
  openlibrary: 'isbn',
  openfoodfacts: 'upc',
  musicbrainz: 'upc',
};
const SOURCE_TO_PHOTO_SOURCE: Record<string, PhotoSource> = {
  amazon: 'enrichment_amazon',
  openfoodfacts: 'enrichment_openfoodfacts',
  openlibrary: 'enrichment_openlibrary',
  musicbrainz: 'enrichment_musicbrainz',
};

async function readCatalogImages(
  admin: SupabaseClient,
  kind: IdentifierKind,
  value: string,
): Promise<string[]> {
  const { data, error } = await admin
    .from('product_lookups')
    .select('upc, image_urls')
    .eq('upc', catalogKey(kind, value))
    .maybeSingle<CatalogRow>();
  if (error || !data) return [];
  return Array.isArray(data.image_urls) ? data.image_urls : [];
}

/**
 * Resolve catalog image URLs for a product identifier, enriching + caching on
 * a miss. Never throws — returns { imageUrls: [], outcome: 'miss' } on any
 * failure so callers can use it fire-and-forget during lot creation.
 */
export async function resolveCatalogImages(
  input: ResolveCatalogImagesInput,
): Promise<ResolveCatalogImagesResult> {
  const { admin } = input;
  const upc = input.upc?.trim() || null;
  const asin = input.asin?.trim() || null;
  const isbn = input.isbn?.trim() || null;

  if (!upc && !asin && !isbn) return { imageUrls: [], outcome: 'miss' };

  try {
    // 1) Catalog read-through. Probe the most specific identifier first
    //    (ASIN is 1:1 with a product, then UPC, then ISBN).
    const probes: Array<{ kind: IdentifierKind; value: string }> = [];
    if (asin) probes.push({ kind: 'asin', value: asin });
    if (upc) probes.push({ kind: 'upc', value: upc });
    if (isbn) probes.push({ kind: 'isbn', value: isbn });

    for (const p of probes) {
      const hit = await readCatalogImages(admin, p.kind, p.value);
      if (hit.length > 0) return { imageUrls: hit, outcome: 'catalog_hit' };
    }

    // 2) Catalog miss → enrich via the identifier-keyed image package.
    const enriched = await enrichImages({
      asin: asin ?? undefined,
      upc: upc ?? undefined,
      isbn: isbn ?? undefined,
    });
    if (enriched.images.length === 0) return { imageUrls: [], outcome: 'miss' };

    // 3) Write each found image back into the catalog (self-warming) under the
    //    identifier that produced it, then return them to the caller.
    const urls: string[] = [];
    for (const img of enriched.images) {
      const kind = SOURCE_TO_KIND[img.source];
      const photoSource = SOURCE_TO_PHOTO_SOURCE[img.source];
      const value = kind === 'asin' ? asin : kind === 'isbn' ? isbn : upc;
      if (kind && photoSource && value) {
        await upsertPhotoToCatalog({
          admin,
          identifierKind: kind,
          identifierValue: value,
          photoUrl: img.url,
          source: photoSource,
          contributedByOperatorId: input.contributedByOperatorId,
        });
      }
      urls.push(img.url);
    }

    // Dedup defensively — a UPC can match both Open Food Facts + MusicBrainz.
    return { imageUrls: Array.from(new Set(urls)), outcome: 'enriched' };
  } catch {
    return { imageUrls: [], outcome: 'miss' };
  }
}
