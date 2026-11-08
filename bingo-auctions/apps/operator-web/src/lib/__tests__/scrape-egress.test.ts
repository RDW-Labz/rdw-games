// Unit tests for the pluggable egress backend (scrape-egress.ts).
//
// Verifies the dormant-until-configured contract and that relay responses map
// onto the EgressResult shape the route branches on. global fetch is stubbed;
// no network is touched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  relayConfigured,
  fetchViaRelay,
  unlockerConfigured,
  fetchViaUnlocker,
  egressConfigured,
  fetchViaEgress,
} from '../scrape-egress';

const ENV_KEYS = [
  'RELAY_URL',
  'RELAY_SECRET',
  'BRIGHTDATA_API_TOKEN',
  'BRIGHTDATA_UNLOCKER_ZONE',
  'BRIGHTDATA_API_URL',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

function configure() {
  process.env['RELAY_URL'] = 'https://relay.example.com/relay';
  process.env['RELAY_SECRET'] = 'x'.repeat(24);
}

function mockFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const res = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
}

describe('relayConfigured', () => {
  it('is false when env is unset', () => {
    delete process.env['RELAY_URL'];
    delete process.env['RELAY_SECRET'];
    expect(relayConfigured()).toBe(false);
  });

  it('is true only when both URL and secret are set', () => {
    process.env['RELAY_URL'] = 'https://relay.example.com/relay';
    delete process.env['RELAY_SECRET'];
    expect(relayConfigured()).toBe(false);
    process.env['RELAY_SECRET'] = 'x'.repeat(24);
    expect(relayConfigured()).toBe(true);
  });
});

describe('fetchViaRelay', () => {
  it('returns unavailable (no fetch) when not configured', async () => {
    delete process.env['RELAY_URL'];
    delete process.env['RELAY_SECRET'];
    const spy = vi.spyOn(globalThis, 'fetch');
    const r = await fetchViaRelay('https://www.amazon.com/dp/B000');
    expect(r).toEqual({ kind: 'unavailable', reason: 'not_configured' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('maps a successful relay response to ok', async () => {
    configure();
    mockFetch({ ok: true, status: 200, finalUrl: 'https://www.amazon.com/dp/B000', html: '<html>hi</html>' });
    const r = await fetchViaRelay('https://www.amazon.com/dp/B000');
    expect(r).toEqual({
      kind: 'ok',
      html: '<html>hi</html>',
      status: 200,
      finalUrl: 'https://www.amazon.com/dp/B000',
    });
  });

  it('maps a blocked relay response to blocked', async () => {
    configure();
    mockFetch({ ok: true, blocked: true, blockReason: 'sentinel:Robot Check', html: '<html>captcha</html>' });
    const r = await fetchViaRelay('https://www.amazon.com/dp/B000');
    expect(r).toEqual({ kind: 'blocked', reason: 'sentinel:Robot Check' });
  });

  it('treats empty html as unavailable', async () => {
    configure();
    mockFetch({ ok: true, status: 200, html: '' });
    const r = await fetchViaRelay('https://www.amazon.com/dp/B000');
    expect(r.kind).toBe('unavailable');
  });

  it('treats a relay HTTP error as unavailable', async () => {
    configure();
    mockFetch({}, { ok: false, status: 502 });
    const r = await fetchViaRelay('https://www.amazon.com/dp/B000');
    expect(r).toEqual({ kind: 'unavailable', reason: 'relay_http_502' });
  });

  it('treats a network throw as unavailable (never throws)', async () => {
    configure();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    const r = await fetchViaRelay('https://www.amazon.com/dp/B000');
    expect(r.kind).toBe('unavailable');
    if (r.kind !== 'ok') expect(r.reason).toMatch(/relay_unreachable/);
  });

  it('sends the bearer secret and url to the relay endpoint', async () => {
    configure();
    const spy = mockFetch({ ok: true, status: 200, html: '<html>ok</html>' });
    await fetchViaRelay('https://www.ebay.com/itm/123');
    expect(spy).toHaveBeenCalledTimes(1);
    const [endpoint, init] = spy.mock.calls[0]!;
    expect(endpoint).toBe('https://relay.example.com/relay');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${'x'.repeat(24)}`);
    expect((init as RequestInit).body).toBe(JSON.stringify({ url: 'https://www.ebay.com/itm/123' }));
  });
});

// ─── Bright Data Web Unlocker ────────────────────────────────────────────────

function mockTextFetch(text: string, init: { ok?: boolean; status?: number } = {}) {
  const res = {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => text,
  } as unknown as Response;
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
}

describe('unlockerConfigured', () => {
  it('is false without a token, true with one', () => {
    delete process.env['BRIGHTDATA_API_TOKEN'];
    expect(unlockerConfigured()).toBe(false);
    process.env['BRIGHTDATA_API_TOKEN'] = 'tok_123';
    expect(unlockerConfigured()).toBe(true);
  });
});

describe('fetchViaUnlocker', () => {
  it('returns unavailable (no fetch) when not configured', async () => {
    delete process.env['BRIGHTDATA_API_TOKEN'];
    const spy = vi.spyOn(globalThis, 'fetch');
    const r = await fetchViaUnlocker('https://www.amazon.com/dp/B000');
    expect(r).toEqual({ kind: 'unavailable', reason: 'not_configured' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('posts zone+url+format to the Bright Data API and returns the HTML', async () => {
    process.env['BRIGHTDATA_API_TOKEN'] = 'tok_123';
    const spy = mockTextFetch('<html><body>hi</body></html>');
    const r = await fetchViaUnlocker('https://www.amazon.com/dp/B000');
    expect(r).toEqual({ kind: 'ok', html: '<html><body>hi</body></html>', status: 200, finalUrl: 'https://www.amazon.com/dp/B000' });
    const [endpoint, init] = spy.mock.calls[0]!;
    expect(endpoint).toBe('https://api.brightdata.com/request');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok_123');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      zone: 'web_unlocker',
      url: 'https://www.amazon.com/dp/B000',
      format: 'raw',
    });
  });

  it('honors a custom zone', async () => {
    process.env['BRIGHTDATA_API_TOKEN'] = 'tok_123';
    process.env['BRIGHTDATA_UNLOCKER_ZONE'] = 'my_zone';
    const spy = mockTextFetch('<html>ok</html>');
    await fetchViaUnlocker('https://x.com');
    expect(JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string).zone).toBe('my_zone');
  });

  it('treats an HTTP error / empty body as unavailable', async () => {
    process.env['BRIGHTDATA_API_TOKEN'] = 'tok_123';
    mockTextFetch('', { ok: false, status: 502 });
    expect((await fetchViaUnlocker('https://x.com')).kind).toBe('unavailable');
    mockTextFetch('');
    expect((await fetchViaUnlocker('https://x.com')).kind).toBe('unavailable');
  });
});

describe('egress chain', () => {
  it('egressConfigured true if unlocker OR relay configured', () => {
    delete process.env['BRIGHTDATA_API_TOKEN'];
    delete process.env['RELAY_URL'];
    delete process.env['RELAY_SECRET'];
    expect(egressConfigured()).toBe(false);
    process.env['BRIGHTDATA_API_TOKEN'] = 'tok_123';
    expect(egressConfigured()).toBe(true);
  });

  it('fetchViaEgress prefers the unlocker and returns its HTML', async () => {
    process.env['BRIGHTDATA_API_TOKEN'] = 'tok_123';
    mockTextFetch('<html>unlocked</html>');
    const r = await fetchViaEgress('https://www.amazon.com/dp/B000');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.html).toBe('<html>unlocked</html>');
  });

  it('fetchViaEgress returns unavailable when nothing is configured (no fetch)', async () => {
    delete process.env['BRIGHTDATA_API_TOKEN'];
    delete process.env['RELAY_URL'];
    delete process.env['RELAY_SECRET'];
    const spy = vi.spyOn(globalThis, 'fetch');
    expect((await fetchViaEgress('https://x.com')).kind).toBe('unavailable');
    expect(spy).not.toHaveBeenCalled();
  });
});
