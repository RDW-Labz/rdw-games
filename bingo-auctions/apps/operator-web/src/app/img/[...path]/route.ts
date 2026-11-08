// GET /img/{bucket}/{...key} — edge-cached proxy for own Supabase storage.
//
// Why: after the photo re-host (mig 0227) ~5 GB of lot photos serve from
// Supabase storage, and every bidder pageview bills Supabase egress. This
// route fronts those objects with Cloudflare's cache (Workers Cache API +
// cf fetch hints), so repeat views serve from the edge for free. Callers
// rewrite URLs via lib/img-proxy.ts (applied in SafeImg/SafeLotImage, OG
// metadata, digest emails).
//
// NOT an open proxy: bucket allowlist + '..' rejection means it can only
// serve our own PUBLIC buckets — the same bytes anyone can already fetch
// straight from Supabase. Query strings (PhotoEditor's ?v= cache-busters)
// are part of the cache key and forwarded upstream.

export const runtime = 'nodejs';

const ALLOWED_BUCKETS = new Set(['lot-photos', 'operator-logos']);
const YEAR = 'public, max-age=31536000, immutable';

type WorkersCaches = { caches?: { default?: Cache } };

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (!path || path.length < 2) return new Response('not found', { status: 404 });
  if (!ALLOWED_BUCKETS.has(path[0]!)) return new Response('not found', { status: 404 });
  if (path.some((seg) => seg.includes('..') || seg.length === 0)) {
    return new Response('not found', { status: 404 });
  }

  const reqUrl = new URL(req.url);
  const key = path.map((seg) => encodeURIComponent(seg)).join('/');
  const origin = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${key}${reqUrl.search}`;

  // Workers edge cache. `caches.default` exists in the Cloudflare runtime;
  // guarded so local `next dev` (plain Node) just skips caching.
  const cache = (globalThis as unknown as WorkersCaches).caches?.default;
  const cacheKey = new Request(reqUrl.toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const upstream = await fetch(origin, {
    // cf hints double-dip into Cloudflare's fetch-level cache when honored.
    cf: { cacheEverything: true, cacheTtl: 31536000 },
  } as RequestInit);

  if (!upstream.ok) {
    // Short-cache misses so a transiently missing object isn't 404'd forever.
    return new Response('not found', {
      status: 404,
      headers: { 'cache-control': 'public, max-age=60' },
    });
  }

  const headers = new Headers();
  headers.set('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream');
  const len = upstream.headers.get('content-length');
  if (len) headers.set('content-length', len);
  headers.set('cache-control', YEAR);

  const res = new Response(upstream.body, { status: 200, headers });
  if (cache) {
    try {
      await cache.put(cacheKey, res.clone());
    } catch {
      // Cache write failure must never break image serving.
    }
  }
  return res;
}
