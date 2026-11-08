import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWithTimeout,
  timeoutMsForUrl,
  TIMEOUT_LOTTR_MS,
  TIMEOUT_SLOW_MS,
  TIMEOUT_SUPABASE_MS,
} from './fetch-with-timeout';
import { classifyLotCreateFailure, type LotCreateFailure } from './lot-create-failure';

const hang = (_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
  });

describe('timeoutMsForUrl', () => {
  it('uses 12 s for Supabase REST/auth', () => {
    expect(timeoutMsForUrl('https://abc.supabase.co/rest/v1/lots')).toBe(TIMEOUT_SUPABASE_MS);
    expect(timeoutMsForUrl('https://abc.supabase.co/auth/v1/token')).toBe(TIMEOUT_SUPABASE_MS);
  });

  it('uses 60 s for Supabase Storage object uploads', () => {
    expect(timeoutMsForUrl('https://abc.supabase.co/storage/v1/object/lot-photos/x.jpg')).toBe(
      TIMEOUT_SLOW_MS,
    );
  });

  it('uses 20 s for generic lottr routes', () => {
    expect(timeoutMsForUrl('https://api.example.com/api/lottr/lookup-code')).toBe(TIMEOUT_LOTTR_MS);
    expect(timeoutMsForUrl('https://api.example.com/api/lottr/enrich-candidate')).toBe(
      TIMEOUT_LOTTR_MS,
    );
  });

  it('uses 60 s for lottr AI routes', () => {
    expect(timeoutMsForUrl('https://api.example.com/api/lottr/scan-photo')).toBe(TIMEOUT_SLOW_MS);
    expect(timeoutMsForUrl('https://api.example.com/api/lottr/scrape-url?allowAiFallback=1')).toBe(
      TIMEOUT_SLOW_MS,
    );
  });
});

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('rejects with a clear message when Supabase REST exceeds 12 s', async () => {
    vi.stubGlobal('fetch', vi.fn(hang));
    const p = fetchWithTimeout('https://abc.supabase.co/rest/v1/lots');
    const assertion = expect(p).rejects.toThrow('network timeout after 12 s');
    await vi.advanceTimersByTimeAsync(TIMEOUT_SUPABASE_MS);
    await assertion;
  });

  it('rejects when lottr lookup exceeds 20 s', async () => {
    vi.stubGlobal('fetch', vi.fn(hang));
    const p = fetchWithTimeout('https://api.example.com/api/lottr/lookup-code');
    const assertion = expect(p).rejects.toThrow('network timeout after 20 s');
    await vi.advanceTimersByTimeAsync(TIMEOUT_LOTTR_MS);
    await assertion;
  });

  it('rejects when scan-photo exceeds 60 s', async () => {
    vi.stubGlobal('fetch', vi.fn(hang));
    const p = fetchWithTimeout('https://api.example.com/api/lottr/scan-photo');
    const assertion = expect(p).rejects.toThrow('network timeout after 60 s');
    await vi.advanceTimersByTimeAsync(TIMEOUT_SLOW_MS);
    await assertion;
  });

  it('returns a fast response without timing out', async () => {
    const body = { ok: true };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
    const res = await fetchWithTimeout('https://api.example.com/api/lottr/lookup-code');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(body);
  });

  it('honours an external AbortSignal', async () => {
    vi.stubGlobal('fetch', vi.fn(hang));
    const external = new AbortController();
    const p = fetchWithTimeout('https://abc.supabase.co/rest/v1/lots', { signal: external.signal });
    external.abort();
    await expect(p).rejects.toThrow('Aborted');
  });

  it('classifies the timeout message as server_slow', () => {
    const failure: LotCreateFailure = {
      code: 'insert_failed',
      reason: 'create_draft_lot: network timeout after 12 s',
    };
    expect(classifyLotCreateFailure(failure)).toBe('server_slow');
  });
});
