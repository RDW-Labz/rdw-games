// Open Food Facts (and Open Products Facts) image lookup.
//
// Why this exists:
//   The Sonar-based image enrichment in image-enrich.ts asks Perplexity
//   to "only return image URLs you actually saw." Sonar is a reasoning
//   model — it cannot reliably extract direct CDN URLs from retailer
//   pages. Empirically, every scan during dogfooding burned ~$0.005-0.01
//   and came back with image_urls=[].
//
//   Open Food Facts is an open-data, no-key, community-curated database
//   covering ~3M consumer products globally (food, drinks, snacks,
//   tobacco, beauty, pet food, household goods). Coverage on a typical
//   liquidation manifest of grocery/CPG items: ~100% from spot checks.
//   The shared Open Products Facts companion DB picks up non-food SKUs.
//
//   Cost: $0 per call. No API key. No rate limit (be polite).
//
// API shape:
//   GET https://world.openfoodfacts.org/api/v2/product/{barcode}.json
//   →   { status_verbose: "product found"|"product not found",
//           product: {
//             product_name, brands,
//             image_url, image_front_url, image_front_small_url,
//             image_ingredients_url, image_packaging_url, ...
//           } }
//
//   Cascade: try openfoodfacts.org first; on miss try openproductsfacts.org
//   (sister project for non-food). Both share the same wire format.
//
// Returned URLs always live on the host `images.openfoodfacts.org`,
// which must be in the ALLOWED_IMAGE_HOSTS list (normalize/images.ts)
// AND the SQL is_safe_image_url() allowlist.

import { normalizeUpc } from '../normalize/upc';

const ENDPOINTS = [
  'https://world.openfoodfacts.org/api/v2/product',
  'https://world.openproductsfacts.org/api/v2/product',
];

const MAX_IMAGES_TO_RETURN = 3;
const FETCH_TIMEOUT_MS = 4000;

type OffProduct = {
  product_name?: string;
  brands?: string;
  image_url?: string;
  image_front_url?: string;
  image_front_small_url?: string;
  image_ingredients_url?: string;
  image_packaging_url?: string;
  // Selected language-specific keys (en, fr, es, etc.) appear as
  // image_front_<lang>_url — we don't try to enumerate, the catch-all
  // gathers anything matching the image_*url shape via dynamic indexing
  // below.
  [key: string]: unknown;
};

type OffResponse = {
  status?: number;
  status_verbose?: string;
  product?: OffProduct;
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('OFF timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// Extract every image_*_url field from a product. Open Food Facts adds
// per-language variants (image_front_en_url, image_front_fr_url, etc.)
// and section variants (image_ingredients_url, image_packaging_url).
// We pull them all and dedupe — the auction listing typically uses the
// front-of-pack, but extras are useful for the lot photo strip.
function extractImageUrls(product: OffProduct): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const pushIf = (val: unknown): void => {
    if (typeof val !== 'string') return;
    const v = val.trim();
    if (!v) return;
    // We don't filter by host here — the caller wraps with
    // filterSafeImageUrls AFTER. Anything OFF returns lives on
    // images.openfoodfacts.org by design.
    if (seen.has(v)) return;
    seen.add(v);
    ordered.push(v);
  };

  // Priority order: front-of-pack first (best for listing thumbnail),
  // then generic, then sections.
  pushIf(product.image_front_url);
  pushIf(product.image_url);
  pushIf(product.image_front_small_url);
  for (const [k, v] of Object.entries(product)) {
    if (!k.startsWith('image_') || !k.endsWith('_url')) continue;
    pushIf(v);
  }
  return ordered;
}

/**
 * Look up a product on Open Food Facts (or Open Products Facts) by UPC.
 * Returns an empty array on miss, network error, or invalid response.
 * Never throws.
 *
 * Cost: free. Latency: typically <500ms; bounded to 4s by FETCH_TIMEOUT_MS.
 */
export async function enrichImagesFromOpenFoodFacts(upc: string | null | undefined): Promise<string[]> {
  const clean = normalizeUpc(upc ?? '');
  if (!clean) return [];

  for (const endpoint of ENDPOINTS) {
    let resp: Response;
    try {
      resp = await withTimeout(
        fetch(`${endpoint}/${encodeURIComponent(clean)}.json`, {
          headers: {
            // OFF asks every client to identify itself in User-Agent so
            // they can contact maintainers if a bot misbehaves. Friendly
            // contact = the operator-web's domain.
            'User-Agent': 'auction-platform/0.1 (https://project-9ymiy.vercel.app)',
            Accept: 'application/json',
          },
        }),
        FETCH_TIMEOUT_MS,
      );
    } catch {
      continue; // try next endpoint
    }
    if (!resp.ok) continue;

    let body: OffResponse;
    try {
      body = (await resp.json()) as OffResponse;
    } catch {
      continue;
    }

    // OFF v2: status=1 = found, status=0 = not found. Some legacy
    // endpoints return status as text in status_verbose. Check both.
    const found =
      body.status === 1 ||
      body.status_verbose === 'product found' ||
      Boolean(body.product?.product_name);
    if (!found || !body.product) continue;

    const urls = extractImageUrls(body.product);
    if (urls.length > 0) return urls.slice(0, MAX_IMAGES_TO_RETURN);
  }

  return [];
}
