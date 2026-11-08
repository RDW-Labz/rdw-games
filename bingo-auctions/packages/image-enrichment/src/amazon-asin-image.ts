// amazon-asin-image.ts
//
// Probes Amazon's predictable product-image URL patterns using HEAD requests.
// No API key required — all URLs are deterministic from the ASIN alone.
//
// Strategy: try each URL variant in sequence and return the first real image
// found. Sequential (not parallel) so we stop hammering Amazon the moment we
// get a hit.
//
// Placeholder rejection: Amazon returns a 1×1 white pixel (~43 bytes) for
// ASINs with no image at a given URL. Content-Length < 2 KB is treated as a
// placeholder and causes the ladder to fall through to the next variant.
// Content-Type is also checked to ensure the response is an actual image.
//
// Worst-case timing: 5 variants × 3 s timeout = 15 s per ASIN. In practice
// the drain worker's per-batch timeout bounds this further.

export interface AmazonImageProbeResult {
  url: string;
  source: 'amazon';
  bytes: number;
}

// ---------------------------------------------------------------------------
// URL variant ladder — ordered from most-likely hit to least-likely.
// ---------------------------------------------------------------------------

const AMAZON_URL_VARIANTS: ReadonlyArray<(asin: string) => string> = [
  // Standard legacy thumbnail — works for most older/established products.
  (asin) => `https://images-na.ssl-images-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg`,
  // Main product image at SL500 size — common for newer listings.
  (asin) => `https://images-na.ssl-images-amazon.com/images/P/${asin}.01.MAIN._SL500_.jpg`,
  // Bare L-size variant — used by many older product SKUs.
  (asin) => `https://images-na.ssl-images-amazon.com/images/P/${asin}.01.L.jpg`,
  // SL500 without .01 infix — alternate naming used for some product families.
  (asin) => `https://images-na.ssl-images-amazon.com/images/P/${asin}._SL500_.jpg`,
  // media-amazon CDN — newer products that are only hosted here.
  (asin) => `https://m.media-amazon.com/images/I/${asin}._AC_SL500_.jpg`,
];

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function probeAmazonAsinImage(
  asin: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<AmazonImageProbeResult | null> {
  if (!/^[A-Z0-9]{10}$/.test(asin)) return null;

  for (const buildUrl of AMAZON_URL_VARIANTS) {
    const result = await probeSingleVariant(buildUrl(asin), opts);
    if (result) return result;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal: probe one URL variant
// ---------------------------------------------------------------------------

async function probeSingleVariant(
  url: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number },
): Promise<AmazonImageProbeResult | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 3000);

  try {
    const fetchFn = opts.fetch ?? fetch;
    const res = await fetchFn(url, { method: 'HEAD', signal: ctrl.signal });
    if (!res.ok) return null;

    const ct = res.headers.get('content-type') ?? '';
    if (!ct.startsWith('image/')) return null;

    const bytes = parseInt(res.headers.get('content-length') ?? '0', 10);
    if (bytes < 2048) return null; // reject 1×1 placeholder (~43 bytes)

    return { url, source: 'amazon', bytes };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
