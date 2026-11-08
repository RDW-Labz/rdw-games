// music-brainz-image.ts
//
// Two-step lookup: UPC → MusicBrainz release ID → Cover Art Archive front image.
//
// Step 1: GET https://musicbrainz.org/ws/2/release?query=barcode:{upc}&fmt=json
//   Returns { releases: [{ id: string, ... }] }
//   Use the first release ID if present.
//
// Step 2: HEAD https://coverartarchive.org/release/{id}/front-500
//   200 = image exists. No Content-Length check needed — CAA always returns
//   real images; there is no 1×1 placeholder convention.
//
// MusicBrainz REQUIRES a User-Agent header identifying the application.
// Omitting it causes 403 / rate-limiting per their policy.
//
// Returned image URL: the CAA front-500 URL (a stable redirect target).

export interface MusicBrainzImageResult {
  url: string;
  source: 'musicbrainz';
  bytes: number;
}

// Minimal shape we need from the MusicBrainz search response.
interface MbSearchResponse {
  releases?: Array<{ id: string }>;
}

const MB_USER_AGENT = 'BinGo Auctions/1.0 (https://bingoauctions.com)';

export async function fetchMusicBrainzImage(
  upc: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<MusicBrainzImageResult | null> {
  if (!/^\d{8,14}$/.test(upc)) return null;

  const fetchFn = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 3000;

  // ── Step 1: resolve UPC → MusicBrainz release ID ─────────────────────────
  const searchUrl = `https://musicbrainz.org/ws/2/release?query=barcode:${upc}&fmt=json`;
  const ctrl1 = new AbortController();
  const t1 = setTimeout(() => ctrl1.abort(), timeoutMs);

  let releaseId: string;
  try {
    const res = await fetchFn(searchUrl, {
      headers: { 'User-Agent': MB_USER_AGENT },
      signal: ctrl1.signal,
    });
    if (!res.ok) return null;

    const data = (await res.json()) as MbSearchResponse;
    const firstRelease = data.releases?.[0];
    if (!firstRelease) return null;
    releaseId = firstRelease.id;
  } catch {
    return null;
  } finally {
    clearTimeout(t1);
  }

  // ── Step 2: HEAD Cover Art Archive front image ────────────────────────────
  const coverUrl = `https://coverartarchive.org/release/${releaseId}/front-500`;
  const ctrl2 = new AbortController();
  const t2 = setTimeout(() => ctrl2.abort(), timeoutMs);

  try {
    const res = await fetchFn(coverUrl, {
      method: 'HEAD',
      headers: { 'User-Agent': MB_USER_AGENT },
      signal: ctrl2.signal,
    });
    if (!res.ok) return null;

    return { url: coverUrl, source: 'musicbrainz', bytes: 0 };
  } catch {
    return null;
  } finally {
    clearTimeout(t2);
  }
}
