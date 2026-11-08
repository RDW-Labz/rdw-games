// pricing.test.ts
//
// Vitest unit + smoke tests for the OpenRouter-backed pricing helpers
// (fetchPrices, lookupCode, fetchStockPhotos).
//
// Two suites live here:
//
//   1. "pricing (mocked fetch)" — always runs. Stubs globalThis.fetch with
//      a controlled response and asserts the OpenRouter request shape: URL,
//      auth header, model from the web_search_lookup / image_enrich task,
//      and that the user-supplied prompt content makes it through unchanged.
//
//   2. "pricing (live OpenRouter)" — skipif OPENROUTER_API_KEY is unset.
//      Mirrors the gating pattern PR #38 introduced for
//      packages/db/test/place_bid.load.test.ts. When a real key is present
//      (e.g. on a developer machine with .env loaded), the suite makes one
//      cheap real call to confirm the round-trip works end-to-end and the
//      response normalizes cleanly.
//
// Run via:
//   npm test --workspace=@auction-platform/domain-lotting
//
// To run the live smoke locally:
//   $env:OPENROUTER_API_KEY="sk-or-..."; npm test --workspace=@auction-platform/domain-lotting

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchPrices, fetchStockPhotos, lookupCode } from '../pricing';
import { setLottingConfig } from '../../config';

// Sample OpenRouter response that matches the OrResponse shape complete()
// expects (choices[0].message.content string + usage block).
function mockOrResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 100,
        cost: 0.001,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

// ---------------------------------------------------------------------------
// Mocked-fetch suite — runs always.
// ---------------------------------------------------------------------------

describe('pricing (mocked fetch)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Reset config so each test gets a fresh openrouterKey.
    setLottingConfig({ openrouterKey: 'sk-or-test-fake-key' });
    fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('fetchPrices: POSTs to OpenRouter with bearer auth and JSON body', async () => {
    fetchSpy.mockResolvedValue(
      mockOrResponse(
        JSON.stringify({
          prices: [{ retailer: 'Amazon', price: 19.99, url: 'https://amazon.com/x' }],
          msrp: 24.99,
          avg: 19.99,
          startBid: 6,
          fullTitle: 'Test Product',
          specs: 'Spec line',
          stockPhotos: ['https://m.media-amazon.com/images/test.jpg'],
        }),
      ) as unknown as Response,
    );

    const result = await fetchPrices('DeWalt drill DCD771C2');

    // Result was normalized through normalizePriceData.
    expect(result).not.toBeNull();
    expect(result?.prices[0]?.retailer).toBe('Amazon');
    expect(result?.msrp).toBe(24.99);

    // Verify the request shape.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as RequestInit;

    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer sk-or-test-fake-key',
    );
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      max_tokens?: number;
      response_format?: { type: string };
    };
    // web_search_lookup default model: openai/gpt-4o-search-preview.
    expect(body.model).toBe('openai/gpt-4o-search-preview');
    // gpt-4o-search-preview rejects response_format with web_search,
    // so complete() strips it on this task. Confirm it's absent.
    expect(body.response_format).toBeUndefined();
    // User prompt is forwarded verbatim.
    expect(body.messages[0]?.role).toBe('user');
    expect(body.messages[0]?.content).toContain('DeWalt drill DCD771C2');
  });

  it('lookupCode: passes the cleaned UPC into the prompt', async () => {
    fetchSpy.mockResolvedValue(
      mockOrResponse(
        JSON.stringify({
          title: 'Test Drill',
          brand: 'DeWalt',
          model: 'DCD771C2',
          category: 'Tools & Hardware',
          description: 'A drill.',
          prices: [{ retailer: 'Amazon', price: 99 }],
          msrp: 129,
          avg: 99,
          startBid: 30,
          specs: 'Cordless',
          stockPhotos: [],
          confidence: 'high',
        }),
      ) as unknown as Response,
    );

    // " 885-911 540858 " → cleaned to "885911540858".
    const result = await lookupCode(' 885-911 540858 ');
    expect(result).not.toBeNull();
    expect(result?.upc).toBe('885911540858');
    expect(result?.brand).toBe('DeWalt');

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]?.content).toContain('885911540858');
    expect(body.messages[0]?.content).toContain('UPC/EAN barcode');
  });

  it('fetchStockPhotos: uses image_enrich task model (perplexity/sonar)', async () => {
    fetchSpy.mockResolvedValue(
      mockOrResponse(
        JSON.stringify({
          images: [
            'https://m.media-amazon.com/images/a.jpg',
            'https://i5.walmartimages.com/b.jpg',
          ],
        }),
      ) as unknown as Response,
    );

    const photos = await fetchStockPhotos({
      brand: 'DeWalt',
      model: 'DCD771C2',
      title: '20V cordless drill',
    });

    expect(photos.length).toBe(2);
    expect(photos[0]).toContain('m.media-amazon.com');

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as {
      model: string;
    };
    // image_enrich default model: perplexity/sonar.
    expect(body.model).toBe('perplexity/sonar');
  });

  it('fetchPrices: returns null + warns when OPENROUTER_API_KEY is missing', async () => {
    // Wipe config + env for this test.
    setLottingConfig({});
    const originalEnv = process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await fetchPrices('anything');

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0]?.[0]).toContain('OPENROUTER_API_KEY not configured');
    // No HTTP call should have been made.
    expect(fetchSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    if (originalEnv !== undefined) process.env['OPENROUTER_API_KEY'] = originalEnv;
  });

  it('lookupCode: empty/whitespace code returns null without calling fetch', async () => {
    const result = await lookupCode('   ');
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Live OpenRouter smoke — skipif OPENROUTER_API_KEY is unset.
// ---------------------------------------------------------------------------
//
// Matches the describe.skipIf pattern PR #38 used for place_bid.load.test.ts.
// Default CI / local runs without the env var see this whole block as
// pending-skipped (green); developers with a real key see one cheap
// end-to-end call.

const LIVE_KEY = process.env['OPENROUTER_API_KEY'];

describe.skipIf(!LIVE_KEY)('pricing (live OpenRouter)', () => {
  beforeEach(() => {
    if (LIVE_KEY) setLottingConfig({ openrouterKey: LIVE_KEY });
  });

  it('fetchStockPhotos returns a (possibly empty) string[] without throwing', async () => {
    const photos = await fetchStockPhotos({
      brand: 'DeWalt',
      model: 'DCD771C2',
      title: '20V MAX Cordless Drill',
    });
    // Live result quality varies; just confirm the shape + no throw.
    expect(Array.isArray(photos)).toBe(true);
    for (const u of photos) expect(typeof u).toBe('string');
  }, 30_000);
});
