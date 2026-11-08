// normalise-photo-url.ts
//
// Pure function — no imports, no side effects.
//
// Converts raw manifest photo_url values into either a valid absolute
// HTTP/S URL or null. This runs in two places (defense in depth):
//
//   1. commitImport() — before the row is written to import_rows.photo_url,
//      so 'NA' strings never land in the DB.
//   2. image-enrichment-drain step 1 — skip enrichment if the row already
//      has a real photo_url (it was supplied by the manifest and survived
//      the allowlist trigger).
//
// Placeholder set is case-insensitive after trim. Covers the values seen in
// real Wayfair, Amazon, and BinGo manifests: '' / 'NA' / 'N/A' / 'null' /
// 'none' / '-'.

const PHOTO_PLACEHOLDERS = new Set(['', 'na', 'n/a', 'null', 'none', '-']);

// "No image available" placeholder graphics: these ARE valid http(s) URLs (so
// they pass the placeholder-set + protocol checks), but they point at a
// retailer's grey stand-in image, not a real product photo. Wayfair ships
// secure.img1-fg.wfcdn.com/.../default_image.jpg for SKUs with no photo —
// ~35% of a typical Wayfair returns manifest. Storing them shows bidders a
// broken-looking "image coming soon" box, which is worse than no image (an
// empty photo can be filled later by enrichment or a staff photo). Matched
// case-insensitively as a substring of the full URL. Kept tight to markers
// that never legitimately appear in a real product-image filename.
const PLACEHOLDER_URL_MARKERS = [
  'default_image',
  'no-image',
  'no_image',
  'noimage',
  'placeholder',
  'image-coming-soon',
  'coming-soon',
];

/**
 * Returns a trimmed absolute HTTP/S URL, or null.
 *
 * Returns null when:
 *  - raw is not a string
 *  - raw trims to a known placeholder ('', 'na', 'n/a', 'null', 'none', '-')
 *  - raw does not start with http:// or https:// (case-insensitive)
 *  - the URL is a "no image available" placeholder graphic (e.g. Wayfair's
 *    default_image.jpg) — see PLACEHOLDER_URL_MARKERS
 */
export function normalisePhotoUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (PHOTO_PLACEHOLDERS.has(trimmed.toLowerCase())) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_URL_MARKERS.some((marker) => lower.includes(marker))) return null;
  return trimmed;
}
