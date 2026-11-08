// Self-host stock product images by mirroring them into the
// `stock-images` Supabase Storage bucket (migration 0074).
//
// Why we don't just store retailer URLs:
//   The platform was hot-linking product photos straight from retailer
//   CDNs (mac.bid, m.media-amazon.com, etc). That breaks under three
//   conditions that all show up at scale:
//     • the CDN owner blocks our Cloudflare Worker IPs
//     • the retailer rotates their CDN keys, 404'ing every cached URL
//     • the retailer's ToS forbids hotlinking
//
//   Mirroring once at save-time gives us:
//     • a stable URL we control (https://<ref>.supabase.co/storage/v1/object/public/stock-images/<hash>.jpg)
//     • automatic dedupe across operators (SHA-256 filename)
//     • CDN independence post-launch
//
// Mirror flow:
//   1. Caller passes an array of source URLs.
//   2. For each URL we filter via isSafeImageUrl — anything not on the
//      allowlist is silently dropped (same security boundary as
//      product_lookups.image_urls writes).
//   3. Fetch with a 5s timeout + 10MB cap; on any error skip and
//      continue (best-effort — a partial mirror is better than failing
//      a lot save).
//   4. Hash the bytes to derive the storage filename.
//   5. Check the bucket — skip upload if a file with this hash already
//      exists (cross-operator dedupe).
//   6. Upload with the correct content-type and return the public URL.
//
// All operations are idempotent. Re-mirroring an already-mirrored URL is
// a no-op (hash already exists in the bucket) and returns the same
// canonical URL.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isSafeImageUrl } from '../normalize/images';

const BUCKET = 'stock-images';

// Conservative limits — most product photos are <200KB; we cap at 10MB
// to match the bucket's file_size_limit (migration 0074).
const MAX_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

// MIME → extension for the filename.
function extForMime(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return '';
  }
}

// ── Untrusted-host guards (allowAnyHttpsHost mode, 2026-07-10) ──────────────
//
// When mirroring a page-vouched image from a host that is NOT on the
// allowlist, the URL is attacker-influenced-in-theory (it came out of a
// fetched retailer page). Two extra checks close the gap the allowlist
// used to provide:
//   1. SSRF guard — https only, a real DNS hostname (no IP literals,
//      no localhost/.internal/.local), default port only.
//   2. Magic-byte sniff — the downloaded bytes must actually start with
//      a JPEG/PNG/WebP/GIF signature, not just claim an image
//      content-type.

function isSafeMirrorTarget(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.port && u.port !== '443') return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  // IPv6 literal / bracketed
  if (host.startsWith('[') || host.includes(':')) return false;
  // IPv4 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  // Local / internal names
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    !host.includes('.')
  ) {
    return false;
  }
  return true;
}

function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // GIF: "GIF8"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  return null;
}

// SHA-256 → lowercase hex. Uses Web Crypto so it works on the Cloudflare
// Workers runtime (no Node `crypto` module needed). The cast on `bytes`
// works around TS5+ inferring `Uint8Array<ArrayBufferLike>` (which
// includes SharedArrayBuffer); `crypto.subtle.digest` only accepts the
// strict `BufferSource`, so we narrow.
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build the public URL for a hash that already lives in the bucket.
 * Pure string template — no I/O — so callers can construct a URL
 * before checking existence if that helps their caching.
 */
export function stockImagePublicUrl(
  supabase: SupabaseClient,
  filename: string,
): string {
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(filename);
  return data.publicUrl;
}

export type MirrorImageOptions = {
  /** Accept any https public host, not just ALLOWED_IMAGE_HOSTS.
   *
   *  For page-vouched enrichment candidates (og:image / JSON-LD images
   *  extracted from a retailer product page we fetched ourselves). In
   *  this mode the allowlist check is replaced by an SSRF guard
   *  (isSafeMirrorTarget) and the downloaded bytes must pass a
   *  magic-byte sniff — content-type alone is not trusted. Server-side
   *  callers only. Default false = original allowlist behavior. */
  allowAnyHttpsHost?: boolean;
  /** Hard cap on a single image, in bytes. Default MAX_BYTES (10 MB).
   *
   *  The whole image is held in JS memory as an ArrayBuffer before it can be
   *  hashed and uploaded — there is no streaming path through Supabase
   *  Storage's JS client. On a server that is nothing; on a warehouse tablet
   *  already holding a camera session and a page of decoded photos it is the
   *  difference between finishing and being jetsam'd. Mobile callers pass a
   *  smaller cap. */
  maxBytes?: number;
};

/**
 * Mirror a single retailer URL into the `stock-images` bucket.
 *
 * Returns the canonical Supabase Storage URL on success, or `null` on
 * any failure (fetch error, oversize, disallowed MIME, allowlist
 * rejection, network timeout). Callers should treat null as "skip this
 * one" — never fatal.
 *
 * Idempotent: re-mirroring an already-mirrored URL returns the same
 * canonical URL without re-uploading.
 */
export async function mirrorImageToStorage(
  supabase: SupabaseClient,
  url: string,
  opts?: MirrorImageOptions,
): Promise<string | null> {
  if (!url || typeof url !== 'string') return null;
  if (opts?.allowAnyHttpsHost) {
    if (!isSafeMirrorTarget(url)) return null;
  } else if (!isSafeImageUrl(url)) {
    return null;
  }

  // Short-circuit on any URL we already own:
  //   - stock-images bucket → return as-is (re-saves are cheap)
  //   - lot-photos / floor-plans / dispute-photos / etc → operator-
  //     captured asset, no need to re-host
  // The Supabase project hostname is the canonical signal — anything
  // served from it is already permanent.
  if (/\.supabase\.co\/storage\/v1\/object\//i.test(url)) return url;

  // Fetch with timeout + size cap.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let bytes: Uint8Array;
  let mime: string;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;

    const cap = opts?.maxBytes ?? MAX_BYTES;
    // Cheap check first: a CDN that declares its size lets us bail before
    // allocating anything at all. Many omit the header, hence the second check.
    const lenHeader = res.headers.get('content-length');
    if (lenHeader && Number(lenHeader) > cap) return null;

    const buf = await res.arrayBuffer();
    if (buf.byteLength > cap) return null;
    bytes = new Uint8Array(buf);
    mime = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  // Untrusted hosts: never trust the content-type header — the bytes
  // themselves must carry a known image signature, and the sniffed MIME
  // (not the claimed one) is what gets stored.
  if (opts?.allowAnyHttpsHost) {
    const sniffed = sniffImageMime(bytes);
    if (!sniffed) return null;
    mime = sniffed;
  }

  const ext = extForMime(mime);
  if (!ext) return null;

  const hash = await sha256Hex(bytes);
  const filename = `${hash}.${ext}`;

  // Try to upload. Supabase Storage returns a "Duplicate" error on a
  // hash collision (same file), which means we can skip — the file is
  // already there. Any other error → null and let the caller continue.
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(filename, bytes, {
      contentType: mime,
      cacheControl: 'public, max-age=31536000, immutable',
      upsert: false, // we WANT the duplicate error so we don't re-upload
    });

  if (error) {
    // The dedupe path: 409 Conflict / "Duplicate". Anything else =
    // genuine failure.
    const msg = error.message?.toLowerCase() ?? '';
    if (!msg.includes('duplicate') && !msg.includes('already exists')) {
      return null;
    }
  }

  return stockImagePublicUrl(supabase, filename);
}

/**
 * Mirror an array of retailer URLs in parallel. Failures and disallowed
 * hosts are silently dropped. Order is preserved for successful URLs so
 * the "hero" image (usually index 0) stays at index 0.
 *
 * Concurrency cap of 4 to avoid hammering one retailer CDN with bursts
 * of requests when an operator saves a lot with many photos.
 */
export async function mirrorImagesToStorage(
  supabase: SupabaseClient,
  urls: string[],
): Promise<string[]> {
  if (!urls || urls.length === 0) return [];

  const out: (string | null)[] = new Array(urls.length).fill(null);

  // Sliding window of 4 concurrent fetches.
  const CONCURRENCY = 4;
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= urls.length) return;
      const u = urls[i];
      if (!u) continue;
      out[i] = await mirrorImageToStorage(supabase, u);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  return out.filter((u): u is string => u !== null);
}
