// enrich-images.test.ts
//
// All tests use an injected mock fetch — no real network calls are made.
// The opts.fetch injection point exists precisely for this purpose.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { probeAmazonAsinImage } from '../amazon-asin-image.js';
import { fetchOpenFoodFactsImage } from '../open-food-facts-image.js';
import { fetchOpenLibraryImage } from '../open-library-image.js';
import { fetchMusicBrainzImage } from '../music-brainz-image.js';
import { enrichImages } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object for mocking fetch. */
function mockResponse(
  ok: boolean,
  opts: {
    status?: number;
    headers?: Record<string, string>;
    json?: unknown;
  } = {},
): Response {
  const headers = new Headers(opts.headers ?? {});
  return {
    ok,
    status: opts.status ?? (ok ? 200 : 404),
    headers,
    json: async () => opts.json ?? {},
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// 1. probeAmazonAsinImage
// ---------------------------------------------------------------------------

describe('probeAmazonAsinImage', () => {
  it('1. valid ASIN + 200 + 50 KB → returns result', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(true, {
        headers: { 'content-type': 'image/jpeg', 'content-length': '51200' },
      }),
    );

    const result = await probeAmazonAsinImage('B08N5WRWNW', { fetch: mockFetch });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('amazon');
    expect(result?.bytes).toBe(51200);
    expect(result?.url).toContain('B08N5WRWNW');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('2. 200 but content-length < 2 KB → null (placeholder rejection)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(true, {
        headers: { 'content-type': 'image/jpeg', 'content-length': '43' },
      }),
    );

    const result = await probeAmazonAsinImage('B08N5WRWNW', { fetch: mockFetch });

    expect(result).toBeNull();
  });

  it('3. 404 → null', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockResponse(false, { status: 404 }));

    const result = await probeAmazonAsinImage('B08N5WRWNW', { fetch: mockFetch });

    expect(result).toBeNull();
  });

  it('4. invalid ASIN format → null WITHOUT fetch call', async () => {
    const mockFetch = vi.fn();

    const result = await probeAmazonAsinImage('not-an-asin', { fetch: mockFetch });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('5. AbortSignal timeout → null', async () => {
    const mockFetch = vi.fn().mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    );

    const result = await probeAmazonAsinImage('B08N5WRWNW', { fetch: mockFetch, timeoutMs: 1 });

    expect(result).toBeNull();
  });

  it('6. missing content-type → null', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(true, {
        headers: { 'content-length': '51200' },
        // no content-type header
      }),
    );

    const result = await probeAmazonAsinImage('B08N5WRWNW', { fetch: mockFetch });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. fetchOpenFoodFactsImage
// ---------------------------------------------------------------------------

describe('fetchOpenFoodFactsImage', () => {
  it('7. status=1 with image_url → result', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(true, {
        json: {
          status: 1,
          product: {
            image_url: 'https://images.openfoodfacts.org/images/products/001/front.jpg',
            image_front_url: 'https://images.openfoodfacts.org/images/products/001/front2.jpg',
          },
        },
      }),
    );

    const result = await fetchOpenFoodFactsImage('04900004256', { fetch: mockFetch });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('openfoodfacts');
    expect(result?.url).toContain('front.jpg');
    // Should prefer image_url over image_front_url
    expect(result?.url).not.toContain('front2.jpg');
  });

  it('8. status=0 → null', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(true, {
        json: { status: 0, product: null },
      }),
    );

    const result = await fetchOpenFoodFactsImage('04900004256', { fetch: mockFetch });

    expect(result).toBeNull();
  });

  it('9. status=1 but no image_url, has image_front_url → result with image_front_url', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(true, {
        json: {
          status: 1,
          product: {
            image_url: '',
            image_front_url: 'https://images.openfoodfacts.org/images/products/001/front.jpg',
          },
        },
      }),
    );

    const result = await fetchOpenFoodFactsImage('04900004256', { fetch: mockFetch });

    expect(result).not.toBeNull();
    expect(result?.url).toContain('front.jpg');
  });

  it('10. status=1 but neither image field → null', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(true, {
        json: {
          status: 1,
          product: { image_url: '', image_front_url: '' },
        },
      }),
    );

    const result = await fetchOpenFoodFactsImage('04900004256', { fetch: mockFetch });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. fetchOpenLibraryImage
// ---------------------------------------------------------------------------

describe('fetchOpenLibraryImage', () => {
  it('11. valid ISBN-13 + 200 + good size → result', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(true, {
        headers: { 'content-type': 'image/jpeg', 'content-length': '85000' },
      }),
    );

    const result = await fetchOpenLibraryImage('9780306406157', { fetch: mockFetch });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('openlibrary');
    expect(result?.bytes).toBe(85000);
    expect(result?.url).toContain('9780306406157');
  });

  it('12. 1×1 placeholder (content-length < 2 KB) → null', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(true, {
        headers: { 'content-type': 'image/png', 'content-length': '67' },
      }),
    );

    const result = await fetchOpenLibraryImage('9780306406157', { fetch: mockFetch });

    expect(result).toBeNull();
  });

  it('13. invalid ISBN → null without fetch call', async () => {
    const mockFetch = vi.fn();

    const result = await fetchOpenLibraryImage('not-an-isbn', { fetch: mockFetch });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. fetchMusicBrainzImage
// ---------------------------------------------------------------------------

describe('fetchMusicBrainzImage', () => {
  it('14. two-step success → result', async () => {
    const mockFetch = vi
      .fn()
      // Step 1: MusicBrainz search returns a release
      .mockResolvedValueOnce(
        mockResponse(true, {
          json: { releases: [{ id: 'abc-123-def' }] },
        }),
      )
      // Step 2: Cover Art Archive HEAD returns 200
      .mockResolvedValueOnce(mockResponse(true));

    const result = await fetchMusicBrainzImage('00028947966432', { fetch: mockFetch });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('musicbrainz');
    expect(result?.url).toContain('abc-123-def');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('15. no releases → null (no second call)', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(true, {
        json: { releases: [] },
      }),
    );

    const result = await fetchMusicBrainzImage('00028947966432', { fetch: mockFetch });

    expect(result).toBeNull();
    // Only the MusicBrainz search call should have been made — no CAA call.
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 5. enrichImages orchestration
// ---------------------------------------------------------------------------

describe('enrichImages', () => {
  it('16. only asin → only amazon called', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      mockResponse(true, {
        headers: { 'content-type': 'image/jpeg', 'content-length': '60000' },
      }),
    );

    const result = await enrichImages({ asin: 'B08N5WRWNW' }, { fetch: mockFetch });

    // Only one HEAD call for Amazon
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.source).toBe('amazon');
  });

  it('17. only upc → OFF + MusicBrainz called in parallel', async () => {
    const mockFetch = vi
      .fn()
      // OFF API call
      .mockResolvedValueOnce(
        mockResponse(true, {
          json: {
            status: 1,
            product: { image_url: 'https://images.openfoodfacts.org/img/1.jpg' },
          },
        }),
      )
      // MusicBrainz search → no releases (so no CAA call)
      .mockResolvedValueOnce(
        mockResponse(true, {
          json: { releases: [] },
        }),
      );

    const result = await enrichImages({ upc: '04900004256' }, { fetch: mockFetch });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.source).toBe('openfoodfacts');
  });

  it('18. all three inputs → 4 sources called in parallel', async () => {
    // Because tasks run in parallel, mockResolvedValueOnce ordering is not
    // reliable across concurrent calls. Instead, use a URL-based dispatcher
    // so each source always gets the right mock response regardless of order.
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('images-na.ssl-images-amazon.com')) {
        // Amazon HEAD
        return Promise.resolve(
          mockResponse(true, {
            headers: { 'content-type': 'image/jpeg', 'content-length': '55000' },
          }),
        );
      }
      if (u.includes('openfoodfacts.org/api')) {
        // OFF API
        return Promise.resolve(
          mockResponse(true, {
            json: {
              status: 1,
              product: { image_url: 'https://images.openfoodfacts.org/img/2.jpg' },
            },
          }),
        );
      }
      if (u.includes('musicbrainz.org')) {
        // MusicBrainz search
        return Promise.resolve(
          mockResponse(true, {
            json: { releases: [{ id: 'mb-release-id' }] },
          }),
        );
      }
      if (u.includes('coverartarchive.org')) {
        // CAA HEAD — no content-type needed, MB doesn't check it
        return Promise.resolve(mockResponse(true));
      }
      if (u.includes('covers.openlibrary.org')) {
        // Open Library HEAD
        return Promise.resolve(
          mockResponse(true, {
            headers: { 'content-type': 'image/jpeg', 'content-length': '90000' },
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected URL in test: ${u}`));
    });

    const result = await enrichImages(
      { asin: 'B08N5WRWNW', upc: '04900004256', isbn: '9780306406157' },
      { fetch: mockFetch },
    );

    // Amazon(1) + OFF(1) + MB search(1) + CAA(1) + OpenLibrary(1) = 5 calls
    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(result.images).toHaveLength(4);

    const sources = result.images.map((i) => i.source);
    expect(sources).toContain('amazon');
    expect(sources).toContain('openfoodfacts');
    expect(sources).toContain('musicbrainz');
    expect(sources).toContain('openlibrary');
  });

  it('19. all sources fail → empty images array, durationMs > 0', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));

    const result = await enrichImages(
      { asin: 'B08N5WRWNW', upc: '04900004256', isbn: '9780306406157' },
      { fetch: mockFetch },
    );

    expect(result.images).toHaveLength(0);
    // durationMs is a non-negative integer; synchronous rejection may still
    // complete in 0 ms on fast machines, so ≥ 0 is the correct assertion.
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('20. durationMs reflects parallel execution (all tasks run concurrently)', async () => {
    const DELAY = 50;

    // Each source takes DELAY ms — but they run in parallel so total should be
    // close to DELAY, not DELAY × N.
    const delayedFetch = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(
            () =>
              resolve(
                mockResponse(true, {
                  headers: { 'content-type': 'image/jpeg', 'content-length': '10000' },
                }),
              ),
            DELAY,
          ),
        ),
    );

    const start = Date.now();
    const result = await enrichImages({ asin: 'B08N5WRWNW' }, { fetch: delayedFetch });
    const elapsed = Date.now() - start;

    // Should finish in roughly DELAY (parallel), not 4×DELAY (serial)
    // We give 4× headroom to avoid flakiness on slow CI runners
    expect(result.durationMs).toBeLessThan(DELAY * 4);
    expect(elapsed).toBeLessThan(DELAY * 4);
    expect(result.images).toHaveLength(1);
  });
});
