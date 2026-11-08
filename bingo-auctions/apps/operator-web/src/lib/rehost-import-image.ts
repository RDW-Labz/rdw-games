// rehost-import-image — download an external image and store it in BinGo's
// own 'lot-photos' bucket, returning the public own-storage URL.
//
// WHY (tester recap 2026-07-08): stock-photo import was unreliable because
// scraped/pasted image URLs from off-allowlist hosts (Google Shopping
// thumbnails, brand-store CDNs, AI-fallback results) were SILENTLY DROPPED by
// the client filterSafeImageUrls() and the DB is_safe_image_url() CHECK —
// both are hardcoded host allowlists. Rehosting at import time sidesteps the
// allowlists entirely: the returned URL is on our own Supabase storage host,
// which every layer already accepts, and the image can never rot or
// hotlink-block later. (The photo-rehost cron drain does the same thing
// after the fact; this does it up front for the import flows.)
//
// Validation mirrors lib/cron/photo-rehost-drain.ts: https-only + SSRF guard,
// image/* content types only (no SVG — script risk from our origin), 12 MB
// cap, bounded timeout. Never throws — returns { ok:false, error } instead.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { isSafeScrapeUrl } from '@/lib/safe-scrape-url';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 12 * 1024 * 1024;
const BUCKET = 'lot-photos';

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/** Path looks like a direct image link (used by scrape-url's fast path). */
export function looksLikeImageUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return /\.(jpe?g|png|webp|gif|avif)$/i.test(u.pathname);
  } catch {
    return false;
  }
}

export type RehostResult = { ok: true; url: string } | { ok: false; error: string };

/** Already on our own Supabase storage — no rehost needed (also prevents a
 *  catalog cache hit from minting a duplicate storage object every read). */
function isOwnStorageUrl(url: string): boolean {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
  return base !== '' && url.startsWith(`${base}/storage/v1/object/`);
}

/**
 * Fetch `imageUrl` and store it under {operatorId}/imports/ in lot-photos.
 * The first path segment = operatorId matches the bucket's RLS layout
 * (the admin client bypasses RLS; the convention keeps tooling consistent).
 */
export async function rehostImportImage(
  operatorId: string,
  imageUrl: string,
): Promise<RehostResult> {
  if (!isSafeScrapeUrl(imageUrl)) return { ok: false, error: 'invalid_url' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let bytes: ArrayBuffer;
  let contentType: string;
  try {
    const res = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
      },
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!EXT_BY_CONTENT_TYPE[contentType]) {
      return { ok: false, error: `not_an_image_${contentType || 'missing'}` };
    }
    const len = Number(res.headers.get('content-length') ?? '0');
    if (len > MAX_BYTES) return { ok: false, error: 'too_large' };
    bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) return { ok: false, error: 'too_large' };
    if (bytes.byteLength === 0) return { ok: false, error: 'empty_body' };
  } catch (err) {
    return { ok: false, error: ((err as Error).message ?? 'fetch_failed').slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }

  const admin = getSupabaseAdmin();
  const ext = EXT_BY_CONTENT_TYPE[contentType]!;
  const path = `${operatorId}/imports/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error: upErr } = await admin.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType, upsert: false });
  if (upErr) return { ok: false, error: `upload_${upErr.message.slice(0, 100)}` };

  const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(path);
  if (!pub?.publicUrl) return { ok: false, error: 'public_url_missing' };
  return { ok: true, url: pub.publicUrl };
}

/**
 * Rehost a scraped result's images (primary + up to 3 additional) in
 * parallel, swapping each for the own-storage copy. On a per-image failure
 * the ORIGINAL URL is kept — no regression vs. today (it then passes or
 * drops by allowlist exactly as before). Bounded so a Worker request can't
 * fan out unboundedly.
 */
export async function rehostScrapedImages<
  T extends { primary_image_url: string | null; additional_image_urls: string[] },
>(operatorId: string, data: T): Promise<T> {
  const MAX_ADDITIONAL = 3;
  const jobs: Array<Promise<void>> = [];
  const out = {
    ...data,
    additional_image_urls: [...(data.additional_image_urls ?? [])],
  };

  if (out.primary_image_url && !isOwnStorageUrl(out.primary_image_url)) {
    const src = out.primary_image_url;
    jobs.push(
      rehostImportImage(operatorId, src).then((r) => {
        if (r.ok) out.primary_image_url = r.url;
      }),
    );
  }
  out.additional_image_urls.slice(0, MAX_ADDITIONAL).forEach((src, i) => {
    if (isOwnStorageUrl(src)) return;
    jobs.push(
      rehostImportImage(operatorId, src).then((r) => {
        if (r.ok) out.additional_image_urls[i] = r.url;
      }),
    );
  });

  if (jobs.length > 0) await Promise.all(jobs);
  return out;
}
