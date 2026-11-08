import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveCatalogImages } from '../resolve-catalog-images';
import { enrichImages } from '@auction-platform/image-enrichment';
import { upsertPhotoToCatalog } from '@/lib/catalog/upsert-photo-to-catalog';

vi.mock('@auction-platform/image-enrichment', () => ({ enrichImages: vi.fn() }));
vi.mock('@/lib/catalog/upsert-photo-to-catalog', () => ({
  upsertPhotoToCatalog: vi.fn().mockResolvedValue({ ok: true }),
}));

const enrichMock = vi.mocked(enrichImages);
const upsertMock = vi.mocked(upsertPhotoToCatalog);

// Mock service-role client whose product_lookups read is keyed by the catalog
// key passed to .eq('upc', key). `catalog` maps catalogKey → image_urls.
function mockAdmin(
  catalog: Record<string, string[]>,
  opts: { fetchError?: boolean } = {},
): SupabaseClient {
  return {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockImplementation((_col: string, key: string) => ({
          maybeSingle: vi.fn().mockResolvedValue(
            opts.fetchError
              ? { data: null, error: { message: 'boom' } }
              : {
                  data: catalog[key]
                    ? { upc: key, image_urls: catalog[key] }
                    : null,
                  error: null,
                },
          ),
        })),
      }),
    }),
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  enrichMock.mockReset();
  upsertMock.mockReset();
  upsertMock.mockResolvedValue({ ok: true });
});

describe('resolveCatalogImages', () => {
  it('returns miss with no identifiers and never enriches', async () => {
    const r = await resolveCatalogImages({ admin: mockAdmin({}) });
    expect(r).toEqual({ imageUrls: [], outcome: 'miss' });
    expect(enrichMock).not.toHaveBeenCalled();
  });

  it('catalog hit on ASIN returns cached images without enriching', async () => {
    const admin = mockAdmin({ 'asin:B01ABCDEFG': ['https://img/a.jpg'] });
    const r = await resolveCatalogImages({
      admin,
      asin: 'B01ABCDEFG',
      upc: '0001112223',
    });
    expect(r.outcome).toBe('catalog_hit');
    expect(r.imageUrls).toEqual(['https://img/a.jpg']);
    expect(enrichMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('falls through to a UPC catalog hit when the ASIN is absent', async () => {
    const admin = mockAdmin({ '0001112223': ['https://img/u.jpg'] });
    const r = await resolveCatalogImages({ admin, upc: '0001112223' });
    expect(r.outcome).toBe('catalog_hit');
    expect(r.imageUrls).toEqual(['https://img/u.jpg']);
  });

  it('catalog miss → enriches, writes back to the catalog, returns images', async () => {
    const admin = mockAdmin({}); // empty catalog
    enrichMock.mockResolvedValue({
      images: [
        { url: 'https://m.media-amazon.com/x.jpg', source: 'amazon', bytes: 1000 },
      ],
      durationMs: 5,
    });
    const r = await resolveCatalogImages({ admin, asin: 'B01ABCDEFG' });
    expect(r.outcome).toBe('enriched');
    expect(r.imageUrls).toEqual(['https://m.media-amazon.com/x.jpg']);
    expect(enrichMock).toHaveBeenCalledWith({
      asin: 'B01ABCDEFG',
      upc: undefined,
      isbn: undefined,
    });
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        identifierKind: 'asin',
        identifierValue: 'B01ABCDEFG',
        source: 'enrichment_amazon',
        photoUrl: 'https://m.media-amazon.com/x.jpg',
      }),
    );
  });

  it('miss + enrichment finds nothing → miss, no write-back', async () => {
    const admin = mockAdmin({});
    enrichMock.mockResolvedValue({ images: [], durationMs: 3 });
    const r = await resolveCatalogImages({ admin, upc: '0001112223' });
    expect(r).toEqual({ imageUrls: [], outcome: 'miss' });
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('treats a catalog read error as a miss and still enriches', async () => {
    const admin = mockAdmin({}, { fetchError: true });
    enrichMock.mockResolvedValue({
      images: [{ url: 'https://off/u.jpg', source: 'openfoodfacts', bytes: 0 }],
      durationMs: 2,
    });
    const r = await resolveCatalogImages({ admin, upc: '0001112223' });
    expect(r.outcome).toBe('enriched');
    expect(r.imageUrls).toEqual(['https://off/u.jpg']);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        identifierKind: 'upc',
        source: 'enrichment_openfoodfacts',
      }),
    );
  });

  it('dedupes when one UPC matches multiple sources', async () => {
    const admin = mockAdmin({});
    enrichMock.mockResolvedValue({
      images: [
        { url: 'https://dup/x.jpg', source: 'openfoodfacts', bytes: 0 },
        { url: 'https://dup/x.jpg', source: 'musicbrainz', bytes: 0 },
      ],
      durationMs: 4,
    });
    const r = await resolveCatalogImages({ admin, upc: '0001112223' });
    expect(r.imageUrls).toEqual(['https://dup/x.jpg']);
  });
});
