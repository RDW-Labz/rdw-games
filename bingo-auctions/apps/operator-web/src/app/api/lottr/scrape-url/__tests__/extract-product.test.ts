// Unit tests for the universal product extractor (4-rung ladder).
//
// Strategy: import only the pure extraction functions exported from route.ts,
// avoiding Next.js runtime imports (NextResponse etc) that would fail in Node.
//
// Each test loads a trimmed HTML fixture from ./fixtures/ and verifies the
// expected fields are populated from the correct rung.

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

import {
  extractProduct,
  extractOpenGraph,
  extractSchemaMeta,
  extractHtmlFallback,
  extractJsonLdBlocks,
  findProduct,
  decodeHtmlEntities,
  isHollowResult,
} from '../route';

// ─── Fixture loader ────────────────────────────────────────────────────────────

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf-8');
}

// ─── decodeHtmlEntities ────────────────────────────────────────────────────────

describe('decodeHtmlEntities', () => {
  it('decodes common HTML entities', () => {
    expect(decodeHtmlEntities('Joss &amp; Main')).toBe('Joss & Main');
    expect(decodeHtmlEntities('&quot;quoted&quot;')).toBe('"quoted"');
    expect(decodeHtmlEntities('path&#x2F;sub')).toBe('path/sub');
  });
});

// ─── JSON-LD helpers ───────────────────────────────────────────────────────────

describe('extractJsonLdBlocks + findProduct', () => {
  it('finds a top-level Product block', () => {
    const html = fixture('amazon-jsonld.html');
    const blocks = extractJsonLdBlocks(html);
    const product = findProduct(blocks);
    expect(product).not.toBeNull();
    expect(product?.['@type']).toBe('Product');
    expect(product?.name).toContain('DEWALT');
  });

  it('finds a Product nested inside an array of LD blocks (target fixture)', () => {
    const html = fixture('target-jsonld.html');
    const blocks = extractJsonLdBlocks(html);
    const product = findProduct(blocks);
    expect(product).not.toBeNull();
    expect(product?.name).toContain('KitchenAid');
  });

  it('returns null when no Product block is present', () => {
    const html = fixture('og-only.html');
    const blocks = extractJsonLdBlocks(html);
    expect(findProduct(blocks)).toBeNull();
  });
});

// ─── Rung 1: JSON-LD path — Amazon ────────────────────────────────────────────

describe('extractProduct — Amazon (JSON-LD path)', () => {
  const html = fixture('amazon-jsonld.html');
  const warnings: string[] = [];
  const data = extractProduct(
    html,
    'https://www.amazon.com/dp/B00606WNBY',
    true,
    warnings,
  );

  it('populates title from JSON-LD name', () => {
    expect(data.title).toContain('DEWALT');
  });

  it('populates msrp_cents from JSON-LD offers.price', () => {
    expect(data.msrp_cents).toBe(12900);
  });

  it('populates primary_image_url from JSON-LD image array', () => {
    expect(data.primary_image_url).toMatch(/^https:\/\/m\.media-amazon\.com/);
  });

  it('populates additional_image_urls (second image)', () => {
    expect(data.additional_image_urls.length).toBeGreaterThanOrEqual(1);
  });

  it('populates brand from JSON-LD brand.name', () => {
    expect(data.brand).toBe('DEWALT');
  });

  it('populates upc from JSON-LD gtin12', () => {
    expect(data.upc).toBe('885911279437');
  });

  it('populates asin from URL path', () => {
    expect(data.asin).toBe('B00606WNBY');
  });

  it('populates item_condition as New', () => {
    expect(data.item_condition).toBe('New');
  });

  it('emits no warnings for a complete JSON-LD page', () => {
    expect(warnings).toHaveLength(0);
  });
});

// ─── Rung 1: JSON-LD path — Wayfair ───────────────────────────────────────────

describe('extractProduct — Wayfair (JSON-LD path)', () => {
  const html = fixture('wayfair-jsonld.html');
  const warnings: string[] = [];
  const data = extractProduct(html, 'https://www.wayfair.com/furniture/pdp/joss-main-sofa', false, warnings);

  it('extracts title', () => {
    expect(data.title).toContain('Joss');
  });

  it('extracts msrp_cents', () => {
    expect(data.msrp_cents).toBe(54999);
  });

  it('extracts brand', () => {
    expect(data.brand).toContain('Joss');
  });

  it('has no asin (non-Amazon)', () => {
    expect(data.asin).toBeNull();
  });

  it('emits no warnings', () => {
    expect(warnings).toHaveLength(0);
  });
});

// ─── Rung 1: JSON-LD path — Target (array of LD blocks) ───────────────────────

describe('extractProduct — Target (JSON-LD array)', () => {
  const html = fixture('target-jsonld.html');
  const warnings: string[] = [];
  const data = extractProduct(html, 'https://www.target.com/p/kitchenaid-stand-mixer/-/A-12345', false, warnings);

  it('extracts title from second LD block', () => {
    expect(data.title).toContain('KitchenAid');
  });

  it('extracts msrp_cents', () => {
    expect(data.msrp_cents).toBe(27999);
  });

  it('extracts upc from gtin13', () => {
    expect(data.upc).toBe('0883049337646');
  });

  it('emits no warnings', () => {
    expect(warnings).toHaveLength(0);
  });
});

// ─── Rung 1: JSON-LD path — Home Depot ────────────────────────────────────────

describe('extractProduct — Home Depot (JSON-LD)', () => {
  const html = fixture('homedepot-jsonld.html');
  const warnings: string[] = [];
  const data = extractProduct(html, 'https://www.homedepot.com/p/Milwaukee-Impact-Driver/123', false, warnings);

  it('extracts title', () => {
    expect(data.title).toContain('Milwaukee');
  });

  it('extracts brand', () => {
    expect(data.brand).toBe('Milwaukee');
  });

  it('extracts msrp_cents', () => {
    expect(data.msrp_cents).toBe(14900);
  });

  it('emits no warnings', () => {
    expect(warnings).toHaveLength(0);
  });
});

// ─── Rung 1: JSON-LD path — Lowe's ────────────────────────────────────────────

describe('extractProduct — Lowes (JSON-LD)', () => {
  const html = fixture('lowes-jsonld.html');
  const warnings: string[] = [];
  const data = extractProduct(html, 'https://www.lowes.com/pd/CRAFTSMAN-circular-saw/123', false, warnings);

  it('extracts title', () => {
    expect(data.title).toContain('CRAFTSMAN');
  });

  it('extracts msrp_cents', () => {
    expect(data.msrp_cents).toBe(7900);
  });

  it('extracts upc', () => {
    expect(data.upc).toBe('885911678902');
  });

  it('emits no warnings', () => {
    expect(warnings).toHaveLength(0);
  });
});

// ─── Rung 2: OpenGraph-only path ──────────────────────────────────────────────

describe('extractOpenGraph (isolated)', () => {
  it('extracts all OG fields', () => {
    const html = fixture('og-only.html');
    const og = extractOpenGraph(html);
    expect(og.title).toBe('Acme Widget Pro 3000');
    expect(og.image).toContain('widget-pro-3000.jpg');
    expect(og.description).toBe('The ultimate widget for all your needs.');
    expect(og.priceCents).toBe(4999);
    expect(og.brand).toBe('Acme');
  });
});

describe('extractProduct — OG-only page (rung 2)', () => {
  const html = fixture('walmart-opengraph.html');
  const warnings: string[] = [];
  const data = extractProduct(html, 'https://www.walmart.com/ip/roomba/12345', false, warnings);

  it('falls through to OG for title', () => {
    expect(data.title).toContain('iRobot Roomba');
  });

  it('falls through to OG for image', () => {
    expect(data.primary_image_url).toContain('walmartimages.com');
  });

  it('falls through to OG for price', () => {
    expect(data.msrp_cents).toBe(17900);
  });

  it('falls through to OG for brand', () => {
    expect(data.brand).toBe('iRobot');
  });

  it('emits no warnings (title+image+price all present)', () => {
    expect(warnings).toHaveLength(0);
  });
});

// ─── Rung 3: schema.org itemprop meta ─────────────────────────────────────────

describe('extractSchemaMeta (isolated)', () => {
  it('extracts all schema.org itemprop fields', () => {
    const html = fixture('schema-meta-only.html');
    const sm = extractSchemaMeta(html);
    expect(sm.title).toBe('Mid-Century Brass Floor Lamp');
    expect(sm.image).toContain('brass-lamp.jpg');
    expect(sm.description).toContain('Hand-crafted');
    expect(sm.priceCents).toBe(18500);
    expect(sm.brand).toBe('LegacyCo');
  });
});

describe('extractProduct — schema-meta-only page (rung 3)', () => {
  const html = fixture('schema-meta-only.html');
  const warnings: string[] = [];
  const data = extractProduct(html, 'https://www.legacystore.example.com/lamps/brass', false, warnings);

  it('populates title from itemprop', () => {
    expect(data.title).toContain('Brass Floor Lamp');
  });

  it('populates price from itemprop', () => {
    expect(data.msrp_cents).toBe(18500);
  });

  it('populates image from itemprop', () => {
    expect(data.primary_image_url).toContain('brass-lamp.jpg');
  });

  it('populates brand from itemprop', () => {
    expect(data.brand).toBe('LegacyCo');
  });
});

// ─── Rung 4: HTML fallback ────────────────────────────────────────────────────

describe('extractHtmlFallback (isolated)', () => {
  it('extracts title from <title> and strips common suffixes', () => {
    const html = fixture('html-fallback-only.html');
    const fb = extractHtmlFallback(html);
    expect(fb.title).toContain('Antique Oak Dresser');
    // Suffix was already clean (no Amazon/eBay/etc suffix here)
  });

  it('strips Amazon title suffix', () => {
    const fb = extractHtmlFallback(
      '<html><head><title>Some Product - Amazon.com</title></head><body></body></html>',
    );
    expect(fb.title).toBe('Some Product');
  });

  it('picks first reasonable img src', () => {
    const html = fixture('html-fallback-only.html');
    const fb = extractHtmlFallback(html);
    expect(fb.image).toContain('antique-oak-dresser-main.jpg');
  });

  it('skips tracker pixel images (too-short URL)', () => {
    const html =
      '<html><head><title>Test</title></head><body>' +
      '<img src="https://t.co/abc" />' + // too short (<30 chars from http...)
      '<img src="https://cdn.example.com/products/real-product-image-large.jpg" /></body></html>';
    const fb = extractHtmlFallback(html);
    expect(fb.image).toContain('real-product-image-large.jpg');
  });
});

describe('extractProduct — HTML-fallback-only page (rung 4)', () => {
  const html = fixture('html-fallback-only.html');
  const warnings: string[] = [];
  const data = extractProduct(html, 'https://liquidation-store.example.com/dresser/42', false, warnings);

  it('populates title from <title>', () => {
    expect(data.title).toContain('Antique Oak Dresser');
  });

  it('populates primary_image_url from first <img>', () => {
    expect(data.primary_image_url).toContain('antique-oak-dresser-main.jpg');
  });

  it('warns about missing price (no structured data)', () => {
    expect(warnings).toContain('price_unavailable');
  });

  it('does not warn about title or image (both found via fallback)', () => {
    expect(warnings).not.toContain('title_missing');
    expect(warnings).not.toContain('image_missing');
  });
});

// ─── Rung 1+2 merge: JSON-LD title/brand kept, OG fills missing price+image ──

describe('extractProduct — JSON-LD + OG merge', () => {
  const html = fixture('jsonld-plus-og-merge.html');
  const warnings: string[] = [];
  const data = extractProduct(html, 'https://www.bestbuy.com/site/bosch-drill/12345.p', false, warnings);

  it('uses JSON-LD title (not OG — merge semantics, OG does not overwrite)', () => {
    expect(data.title).toBe('Bosch PS31-2A 12V Max 3/8 In. Drill/Driver Kit');
    expect(data.title).not.toContain('should NOT overwrite');
  });

  it('uses JSON-LD brand', () => {
    expect(data.brand).toBe('Bosch');
  });

  it('fills missing image from OG (JSON-LD had no image)', () => {
    expect(data.primary_image_url).toContain('bbystatic.com');
  });

  it('fills missing price from OG (JSON-LD had no offers)', () => {
    expect(data.msrp_cents).toBe(9900);
  });

  it('emits no warnings (title+image+price all filled across rungs)', () => {
    expect(warnings).toHaveLength(0);
  });
});

// ─── Edge cases ────────────────────────────────────────────────────────────────

describe('extractProduct — edge cases', () => {
  it('returns safe defaults for completely empty HTML', () => {
    const warnings: string[] = [];
    const data = extractProduct('<html></html>', 'https://example.com/p/1', false, warnings);
    expect(data.title).toBe('Imported product');
    expect(data.msrp_cents).toBeNull();
    expect(data.primary_image_url).toBeNull();
    expect(warnings).toContain('title_missing');
    expect(warnings).toContain('price_unavailable');
    expect(warnings).toContain('image_missing');
  });

  it('ASIN is null for non-Amazon URL even with identical path format', () => {
    const warnings: string[] = [];
    const data = extractProduct('<html></html>', 'https://www.walmart.com/dp/B00606WNBY', false, warnings);
    expect(data.asin).toBeNull();
  });

  it('ASIN extracted for Amazon gp/product path', () => {
    const warnings: string[] = [];
    const html = fixture('amazon-jsonld.html');
    const data = extractProduct(html, 'https://www.amazon.com/gp/product/B07KHZ36B6', true, warnings);
    expect(data.asin).toBe('B07KHZ36B6');
  });

  it('additional_image_urls capped at 6', () => {
    const many = Array.from({ length: 10 }, (_, i) => `https://cdn.example.com/img/${i}.jpg`).join('","');
    const html = `<html><head><script type="application/ld+json">{"@type":"Product","name":"Big","image":["${many}"],"offers":{"price":1}}</script></head></html>`;
    const warnings: string[] = [];
    const data = extractProduct(html, 'https://www.amazon.com/dp/B0001', false, warnings);
    expect(data.additional_image_urls.length).toBeLessThanOrEqual(6);
  });
});

// ─── False-success detection (Batch D) ────────────────────────────────────────
//
// isHollowResult gates whether a 200-OK direct scrape that parsed nothing
// usable gets returned as ok:true (it must NOT) or escalated to AI / signalled
// as needs_fallback. This is the fix for the "shaky import shows an empty form"
// complaint.

describe('isHollowResult', () => {
  it('flags a completely empty extraction as hollow', () => {
    const warnings: string[] = [];
    const data = extractProduct('<html></html>', 'https://example.com/p/1', false, warnings);
    expect(isHollowResult(data)).toBe(true);
  });

  it('treats the "Imported product" sentinel title as no real title', () => {
    expect(
      isHollowResult({
        title: 'Imported product',
        msrp_cents: null,
        primary_image_url: null,
        additional_image_urls: [],
        description: null,
        brand: null,
        upc: null,
        asin: null,
        item_condition: null,
        variant_asins: [],
        specs: null,
      }),
    ).toBe(true);
  });

  it('is NOT hollow when a real title is present (even with no price/image)', () => {
    expect(
      isHollowResult({
        title: 'DeWalt 20V Drill',
        msrp_cents: null,
        primary_image_url: null,
        additional_image_urls: [],
        description: null,
        brand: null,
        upc: null,
        asin: null,
        item_condition: null,
        variant_asins: [],
        specs: null,
      }),
    ).toBe(false);
  });

  it('is NOT hollow when only a price is present', () => {
    expect(
      isHollowResult({
        title: 'Imported product',
        msrp_cents: 1999,
        primary_image_url: null,
        additional_image_urls: [],
        description: null,
        brand: null,
        upc: null,
        asin: null,
        item_condition: null,
        variant_asins: [],
        specs: null,
      }),
    ).toBe(false);
  });

  it('is NOT hollow when only an image is present', () => {
    expect(
      isHollowResult({
        title: '',
        msrp_cents: null,
        primary_image_url: 'https://cdn.example.com/x.jpg',
        additional_image_urls: [],
        description: null,
        brand: null,
        upc: null,
        asin: null,
        item_condition: null,
        variant_asins: [],
        specs: null,
      }),
    ).toBe(false);
  });

  it('is NOT hollow for a well-formed JSON-LD extraction', () => {
    const html = fixture('amazon-jsonld.html');
    const warnings: string[] = [];
    const data = extractProduct(html, 'https://www.amazon.com/dp/B00606WNBY', true, warnings);
    expect(isHollowResult(data)).toBe(false);
  });
});
