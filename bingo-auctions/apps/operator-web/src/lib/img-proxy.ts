// img-proxy.ts — rewrite Supabase storage URLs to the edge-cached proxy.
//
// After the photo re-host (mig 0227) every catalog image serves from
// Supabase storage, which bills egress per byte. The /img/[...path] route
// proxies those objects through bingoauctions.com with Cloudflare edge
// caching, so a lot photo viewed 10,000 times costs ONE Supabase read.
//
// Isomorphic on purpose: NEXT_PUBLIC_SUPABASE_URL is inlined client-side,
// so the client components (SafeImg/SafeLotImage) can rewrite too.
//
// Non-storage URLs (remaining retail-CDN hotlinks, /art/ placeholders)
// pass through untouched — their egress isn't ours.

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
const PUBLIC_PREFIX = `${SUPABASE_URL}/storage/v1/object/public/`;
const APP_URL = 'https://bingoauctions.com';

// Buckets the proxy route will serve — keep in sync with ALLOWED_BUCKETS in
// app/img/[...path]/route.ts.
const PROXIED_BUCKETS = ['lot-photos/', 'operator-logos/'];

/**
 * Rewrite an own-storage public URL to the cached /img/ proxy path.
 * `absolute` for contexts that leave the site (emails, OG tags).
 */
export function cdnImageUrl(url: string, opts?: { absolute?: boolean }): string {
  if (!SUPABASE_URL || !url.startsWith(PUBLIC_PREFIX)) return url;
  const rest = url.slice(PUBLIC_PREFIX.length);
  if (!PROXIED_BUCKETS.some((b) => rest.startsWith(b))) return url;
  const path = `/img/${rest}`;
  return opts?.absolute ? `${APP_URL}${path}` : path;
}
