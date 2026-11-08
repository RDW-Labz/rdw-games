// amazon-asin-image-variants.test.ts
//
// Tests for the multi-URL fallback ladder added in feat/multi-url-amazon-fallback.
// All tests use injected mock fetch — no real network calls are made.

import { describe, it, expect, vi } from 'vitest';
import { probeAmazonAsinImage } from '../amazon-asin-image.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Response-like object for mocking fetch. */
function mockImageResponse(contentLength: number): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      'content-type': 'image/jpeg',
      'content-length': String(contentLength),
    }),
  } as unknown as Response;
}

function mockPlaceholderResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      'content-type': 'image/jpeg',
      'content-length': '43', // Amazon's standard 1×1 pixel placeholder
    }),
  } as unknown as Response;
}

function mock404Response(): Response {
  return {
    ok: false,
    status: 404,
    headers: new Headers(),
  } as unknown as Response;
}

function mockBadContentTypeResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      'content-type': 'text/html',
      'content-length': '51200',
    }),
  } as unknown as Response;
}

function mockAbortError(): Promise<never> {
  return Promise.reject(
    Object.assign(new DOMException('The operation was aborted', 'AbortError'), {
      name: 'AbortError',
    }),
  );
}

// ---------------------------------------------------------------------------
// Variant fallback ladder tests
// ---------------------------------------------------------------------------

describe('probeAmazonAsinImage — multi-URL fallback ladder', () => {
  it('V1. first variant hit — returns result with 1 fetch call', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockImageResponse(33900));

    const result = await probeAmazonAsinImage('B01MA1J92C', { fetch: mockFetch });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('amazon');
    expect(result?.bytes).toBe(33900);
    expect(result?.url).toContain('B01MA1J92C');
    // Must stop after the first successful hit — no unnecessary calls
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('V2. first variant returns placeholder, second variant returns real image — 2 fetch calls', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockPlaceholderResponse()) // variant 1: placeholder
      .mockResolvedValue(mockImageResponse(35000)); // variant 2+: real image

    const result = await probeAmazonAsinImage('B0DNNKNKS4', { fetch: mockFetch });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('amazon');
    expect(result?.bytes).toBe(35000);
    // Variant 2's URL uses MAIN._SL500_
    expect(result?.url).toContain('MAIN._SL500_');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('V3. all 5 variants return placeholder — returns null with exactly 5 fetch calls', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mockPlaceholderResponse());

    const result = await probeAmazonAsinImage('B0DMP4DD5Q', { fetch: mockFetch });

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('V4. 404 on first variant, real image on second — fallback triggers on non-ok status', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mock404Response())
      .mockResolvedValue(mockImageResponse(41200));

    const result = await probeAmazonAsinImage('B00DWN54KI', { fetch: mockFetch });

    expect(result).not.toBeNull();
    expect(result?.bytes).toBe(41200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('V5. bad content-type on first, real image on second — fallback triggers on non-image content-type', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockBadContentTypeResponse())
      .mockResolvedValue(mockImageResponse(28000));

    const result = await probeAmazonAsinImage('B0CRFXZCTJ', { fetch: mockFetch });

    expect(result).not.toBeNull();
    expect(result?.bytes).toBe(28000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('V6. AbortError on first variant — falls through to second variant without crashing', async () => {
    const mockFetch = vi
      .fn()
      .mockImplementationOnce(() => mockAbortError()) // variant 1 times out
      .mockResolvedValue(mockImageResponse(44100)); // variant 2 succeeds

    // Use a generous timeout so the AbortController inside each variant fires only
    // when the mock explicitly rejects with AbortError, not from the real timer.
    const result = await probeAmazonAsinImage('B08N5WRWNW', {
      fetch: mockFetch,
      timeoutMs: 5000,
    });

    expect(result).not.toBeNull();
    expect(result?.source).toBe('amazon');
    expect(result?.bytes).toBe(44100);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('V7. invalid ASIN shape — returns null before any fetch call', async () => {
    const mockFetch = vi.fn();

    const result = await probeAmazonAsinImage('not-an-asin', { fetch: mockFetch });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('V8. all 5 variants return 404 — returns null with exactly 5 fetch calls', async () => {
    const mockFetch = vi.fn().mockResolvedValue(mock404Response());

    const result = await probeAmazonAsinImage('B0DNNKNKS4', { fetch: mockFetch });

    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it('V9. result URL matches the specific variant that succeeded (third variant)', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockPlaceholderResponse()) // variant 1: placeholder
      .mockResolvedValueOnce(mock404Response()) // variant 2: 404
      .mockResolvedValue(mockImageResponse(52000)); // variant 3+: real image

    const result = await probeAmazonAsinImage('B08N5WRWNW', { fetch: mockFetch });

    expect(result).not.toBeNull();
    // Third variant URL contains .01.L.jpg
    expect(result?.url).toContain('.01.L.jpg');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('V10. hit on fifth (m.media-amazon.com) variant — URL contains m.media-amazon.com', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockPlaceholderResponse()) // variant 1
      .mockResolvedValueOnce(mock404Response()) // variant 2
      .mockResolvedValueOnce(mockBadContentTypeResponse()) // variant 3
      .mockResolvedValueOnce(mockPlaceholderResponse()) // variant 4
      .mockResolvedValue(mockImageResponse(38500)); // variant 5: m.media-amazon.com

    const result = await probeAmazonAsinImage('B08N5WRWNW', { fetch: mockFetch });

    expect(result).not.toBeNull();
    expect(result?.url).toContain('m.media-amazon.com');
    expect(result?.bytes).toBe(38500);
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });
});
