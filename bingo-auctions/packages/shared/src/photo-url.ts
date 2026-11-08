// photo-url.ts — pure helpers for choosing which URL a photo loads from.
//
// Why this exists (2026-09-24): Supabase bills Storage image transformations
// per DISTINCT ORIGIN IMAGE transformed in a billing cycle (Pro includes 100,
// then $5 per 1,000). Width, quality and cache TTL do not change that count:
// one photo resized at five widths is still one origin, and one photo resized
// once is still one origin. The only lever is how many different photos go
// through /storage/v1/render/image/ at all. Lot photos are already small
// (field-mobile uploads and photo-rehost-drain cap the long side at 1200px;
// prod lot-photos median 248 KB, p90 454 KB on 2026-09-24), so display
// surfaces load the stored object directly.
//
// The fallback chain is for viewers: try each candidate once, in order, then
// show a placeholder. The index only moves forward, so a failing image can
// never bounce between two URLs.

const OBJECT_SEGMENT = '/storage/v1/object/public/';
const RENDER_SEGMENT = '/storage/v1/render/image/public/';

// Query parameters the render endpoint consumes. Anything else (e.g. the
// PhotoEditor's ?v= cache-buster) belongs to the object and is kept.
const TRANSFORM_PARAMS = ['width', 'height', 'resize', 'quality', 'format'];

/** True for a Supabase Storage render (transform) URL. */
export function isStorageTransformUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    return new URL(url).pathname.includes(RENDER_SEGMENT);
  } catch {
    return false;
  }
}

/**
 * The untransformed object URL for a photo. A Supabase render URL becomes the
 * matching public object URL with the transform parameters removed; every
 * other URL (object URLs, retailer CDNs, file:// URIs, relative paths) comes
 * back unchanged. Never throws.
 */
export function originalPhotoUrl(url: string): string {
  if (!url.includes(RENDER_SEGMENT)) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  u.pathname = u.pathname.replace(RENDER_SEGMENT, OBJECT_SEGMENT);
  for (const p of TRANSFORM_PARAMS) u.searchParams.delete(p);
  return u.toString();
}

/**
 * Ordered, de-duplicated list of URLs a viewer should try for one photo:
 * the optional preferred source (a cached proxy path, a pre-sized variant)
 * first, then the original object. Empty when there is nothing to load, in
 * which case the caller shows its placeholder straight away.
 */
export function photoSourceChain(
  url: string | null | undefined,
  preferred?: string | null,
): string[] {
  const chain: string[] = [];
  const add = (u: string | null | undefined) => {
    if (typeof u !== 'string') return;
    const t = u.trim();
    if (t.length > 0 && !chain.includes(t)) chain.push(t);
  };
  add(preferred);
  if (typeof url === 'string' && url.trim().length > 0) add(originalPhotoUrl(url.trim()));
  return chain;
}

/**
 * Next attempt after the source at `attempt` failed. Returns `chainLength`
 * once every source has failed, meaning "show the placeholder", and stays
 * there on further errors. Monotonic by construction, so no retry loop.
 */
export function nextPhotoAttempt(attempt: number, chainLength: number): number {
  const len = Math.max(0, Math.floor(chainLength));
  if (!Number.isFinite(attempt) || attempt < 0) return Math.min(1, len);
  return Math.min(Math.floor(attempt) + 1, len);
}
