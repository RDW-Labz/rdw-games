// image-enrichment — public API.
//
// Parallel image lookup across four free sources:
//   - Amazon product images (ASIN URL probe, no API key)
//   - Open Food Facts (UPC/EAN, free community API)
//   - MusicBrainz + Cover Art Archive (UPC, free, User-Agent required)
//   - Open Library Covers (ISBN, free)
//
// All sources are called in parallel via Promise.all. Individual source
// failures are swallowed — a network error on one source does not prevent
// results from the others.
//
// Design: injectable `fetch` on every call so callers can mock in tests
// and so server-side code can supply a custom fetch implementation.
//
// Imports are written WITHOUT `.js` extensions so webpack (Next.js / CF
// Workers build) can resolve them. Our tsconfig uses
// `moduleResolution: "bundler"` which accepts both forms; webpack only
// accepts the extensionless form. Same fix as PR #131 for scan-extract.

import { probeAmazonAsinImage } from './amazon-asin-image';
import { fetchOpenFoodFactsImage } from './open-food-facts-image';
import { fetchOpenLibraryImage } from './open-library-image';
import { fetchMusicBrainzImage } from './music-brainz-image';

// Re-export individual probe functions so callers can use a single source.
export { probeAmazonAsinImage } from './amazon-asin-image';
export type { AmazonImageProbeResult } from './amazon-asin-image';

export { fetchOpenFoodFactsImage } from './open-food-facts-image';
export type { OpenFoodFactsImageResult } from './open-food-facts-image';

export { fetchOpenLibraryImage } from './open-library-image';
export type { OpenLibraryImageResult } from './open-library-image';

export { fetchMusicBrainzImage } from './music-brainz-image';
export type { MusicBrainzImageResult } from './music-brainz-image';

export { detectIdentifier } from './detect-identifier';
export type { DetectedIdentifier, IdentifierKind } from './detect-identifier';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type ImageSource = 'amazon' | 'openfoodfacts' | 'openlibrary' | 'musicbrainz';

export interface EnrichmentInput {
  /** Amazon Standard Identification Number — 10-character alphanumeric. */
  asin?: string;
  /** UPC/EAN barcode — 8–14 digits. Used for Open Food Facts + MusicBrainz. */
  upc?: string;
  /** ISBN-10 or ISBN-13. Used for Open Library covers. */
  isbn?: string;
}

export interface ImageProbeResult {
  url: string;
  source: ImageSource;
  /** Byte size of the image. 0 when the source does not provide Content-Length. */
  bytes: number;
}

export interface EnrichmentResult {
  images: ImageProbeResult[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// enrichImages — fan-out across all relevant sources in parallel
// ---------------------------------------------------------------------------

export async function enrichImages(
  input: EnrichmentInput,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<EnrichmentResult> {
  const t0 = Date.now();
  const tasks: Promise<ImageProbeResult | null>[] = [];

  if (input.asin) tasks.push(probeAmazonAsinImage(input.asin, opts));
  if (input.upc) tasks.push(fetchOpenFoodFactsImage(input.upc, opts));
  if (input.upc) tasks.push(fetchMusicBrainzImage(input.upc, opts));
  if (input.isbn) tasks.push(fetchOpenLibraryImage(input.isbn, opts));

  const results = await Promise.all(tasks);
  const images = results.filter((r): r is ImageProbeResult => r !== null);

  return { images, durationMs: Date.now() - t0 };
}
