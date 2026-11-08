import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { serpConfigured, searchSerp, parsePriceCents } from '../serp';

const saved: Record<string, string | undefined> = {};
const KEYS = ['BRIGHTDATA_API_TOKEN', 'BRIGHTDATA_SERP_ZONE', 'BRIGHTDATA_API_URL'] as const;
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

function mockSerp(json: unknown, init: { ok?: boolean } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: init.ok ?? true,
    status: 200,
    text: async () => JSON.stringify(json),
  } as unknown as Response);
}

describe('parsePriceCents', () => {
  it('parses numbers and currency strings', () => {
    expect(parsePriceCents(19.99)).toBe(1999);
    expect(parsePriceCents('$1,299.00')).toBe(129900);
    expect(parsePriceCents('about 5 dollars')).toBe(500);
    expect(parsePriceCents('n/a')).toBeNull();
    expect(parsePriceCents(undefined)).toBeNull();
  });
});

describe('serpConfigured', () => {
  it('false without token, true with', () => {
    delete process.env['BRIGHTDATA_API_TOKEN'];
    expect(serpConfigured()).toBe(false);
    process.env['BRIGHTDATA_API_TOKEN'] = 'tok';
    expect(serpConfigured()).toBe(true);
  });
});

describe('searchSerp', () => {
  it('returns [] (no fetch) when unconfigured', async () => {
    delete process.env['BRIGHTDATA_API_TOKEN'];
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(await searchSerp('cordless drill')).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps shopping results to hits and posts zone+brd_json url', async () => {
    process.env['BRIGHTDATA_API_TOKEN'] = 'tok';
    const spy = mockSerp({
      shopping: [
        { title: 'DeWalt 20V Drill', link: 'https://x.com/p/1', price: '$129.00', image: 'https://img/1.jpg', source: 'Walmart' },
        { title: '', link: 'https://x.com/p/2' }, // skipped: no title
      ],
    });
    const hits = await searchSerp('dewalt drill', 6);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.product.title).toBe('DeWalt 20V Drill');
    expect(hits[0]?.product.msrp_cents).toBe(12900);
    expect(hits[0]?.product.image_urls).toEqual(['https://img/1.jpg']);
    expect(hits[0]?.product.sources).toEqual(['serp']);
    expect(hits[0]?.product.prices[0]?.retailer).toBe('Walmart');
    // request shape
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.zone).toBe('serp_api');
    expect(body.url).toContain('tbm=shop');
    expect(body.url).toContain('brd_json=1');
  });

  it('falls back to organic results, respects limit, and never throws', async () => {
    process.env['BRIGHTDATA_API_TOKEN'] = 'tok';
    mockSerp({ organic: Array.from({ length: 10 }, (_, i) => ({ title: `Item ${i}`, link: `https://x/${i}` })) });
    const hits = await searchSerp('thing', 3);
    expect(hits).toHaveLength(3);

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    expect(await searchSerp('thing')).toEqual([]);
  });
});
