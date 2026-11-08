// open-food-facts-image.ts
//
// Fetches product image URLs from the Open Food Facts public API.
// Free, no API key, no rate limit documented. Excellent coverage for
// consumer goods: grocery, drinks, snacks, tobacco, beauty, household.
//
// API: https://world.openfoodfacts.org/api/v2/product/{barcode}.json
// status === 1 → found; status === 0 → not found.
// Image URL preference: image_url → image_front_url → null.
//
// Returned URLs live on images.openfoodfacts.org (already in the SQL
// is_safe_image_url() allowlist since migration 0069).

export interface OpenFoodFactsImageResult {
  url: string;
  source: 'openfoodfacts';
  bytes: number;
}

// Minimal shape we care about from the OFF API response.
interface OffApiResponse {
  status: number;
  product?: {
    image_url?: string;
    image_front_url?: string;
  };
}

export async function fetchOpenFoodFactsImage(
  barcode: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<OpenFoodFactsImageResult | null> {
  if (!/^\d{8,14}$/.test(barcode)) return null;

  const apiUrl = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 3000);

  try {
    const fetchFn = opts.fetch ?? fetch;
    const res = await fetchFn(apiUrl, { signal: ctrl.signal });
    if (!res.ok) return null;

    const data = (await res.json()) as OffApiResponse;
    if (data.status !== 1 || !data.product) return null;

    const imageUrl = data.product.image_url || data.product.image_front_url;
    if (!imageUrl) return null;

    // We don't have a Content-Length from the API JSON; return 0 as sentinel.
    // Callers that need real byte counts should HEAD the returned URL separately.
    return { url: imageUrl, source: 'openfoodfacts', bytes: 0 };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
