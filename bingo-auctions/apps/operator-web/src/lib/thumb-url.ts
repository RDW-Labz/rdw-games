// thumb-url.ts — derive a small thumbnail variant of a stored image URL.
//
// Why: list/table views render 60px thumbnails but were loading the FULL
// resolution original (the inventory table used <Image unoptimized>, which
// bypasses Next's optimizer entirely). On a bucket tab with dozens of lots —
// especially now that heroes are mirrored stock / rehosted photos at a ~138 KB
// median — that's dozens of full-size downloads painting in as they land (the
// "images load slowly right-to-left" report, 2026-07-11).
//
// Strategy, per host:
//   • Supabase Storage → the stored object, untransformed. This used to go
//     through the render/image transform endpoint, but Supabase bills
//     transformations per DISTINCT ORIGIN IMAGE per billing cycle (100
//     included on Pro, then $5 per 1,000), so every lot scrolled past in a
//     500-row bucket tab added one billable origin — 2026-09-24 the project
//     was ~39x over quota. Width/quality tweaks can't reduce that count, only
//     not transforming can. Stored photos are already small (median 248 KB,
//     long side capped at 1200px on upload), and ThumbImg lazy-loads, so the
//     byte cost is only for rows actually on screen. A render URL that's
//     already stored is mapped back to its object for the same reason.
//   • Wayfair wfcdn → its native path resizer (resize-hN-wN), the same trick
//     photo-rehost-drain uses to request a specific render size. Free to us.
//   • Any other host → returned unchanged (external CDNs vary; the <img> still
//     displays at 60px, just without the byte saving).
//
// Returns null for empty/invalid input so callers can render their placeholder.

import { isStorageTransformUrl, originalPhotoUrl } from '@auction-platform/shared';

export function thumbUrl(url: string | null | undefined, size = 120): string | null {
  if (!url || typeof url !== 'string') return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  // Supabase render URL → its untransformed object (never request a transform).
  if (isStorageTransformUrl(url)) return originalPhotoUrl(url);

  // Wayfair CDN: the render size is a path segment, not a query param.
  if (u.hostname === 'secure.img1-fg.wfcdn.com' || u.hostname.endsWith('.wfcdn.com')) {
    return url.replace(/resize-h\d{1,4}-w\d{1,4}/, `resize-h${size}-w${size}`);
  }

  return url;
}
