// open-library-image.ts
//
// Fetches book cover images from the Open Library Covers API using ISBN.
// Free, no API key. Covers are hosted on covers.openlibrary.org.
//
// URL pattern: https://covers.openlibrary.org/b/isbn/{ISBN}-L.jpg
//   - Returns 200 with image data if a cover exists.
//   - Returns a redirect to a 1×1 placeholder if no cover exists.
//
// Placeholder rejection: same Content-Length < 2 KB rule as Amazon.
//
// ISBN validation: accepts ISBN-10 (9 digits + optional X check digit)
// or ISBN-13 (exactly 13 digits).

export interface OpenLibraryImageResult {
  url: string;
  source: 'openlibrary';
  bytes: number;
}

/** Validates ISBN-10 (e.g. "0306406152" or "030640615X") or ISBN-13. */
function isValidIsbn(isbn: string): boolean {
  return /^\d{13}$/.test(isbn) || /^\d{9}[\dX]$/i.test(isbn);
}

export async function fetchOpenLibraryImage(
  isbn: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<OpenLibraryImageResult | null> {
  if (!isValidIsbn(isbn)) return null;

  const url = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 3000);

  try {
    const fetchFn = opts.fetch ?? fetch;
    const res = await fetchFn(url, { method: 'HEAD', signal: ctrl.signal });
    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return null;

    const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10);
    if (contentLength < 2048) return null; // reject 1×1 placeholder

    return { url, source: 'openlibrary', bytes: contentLength };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
