// The ZIP gate must never block a bid on our own failure, and must not add a
// round trip to every bid once the ZIP is known.
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/supabase-browser', () => ({ getSupabaseBrowser: () => ({}) }));
import { bidderHasZip, makeZipChecker, rememberBidderHasZip } from '../zip-gate-browser';

function client(answer: { data?: unknown; error?: { message: string } | null; throws?: boolean }) {
  const calls = { n: 0 };
  const b: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'eq', 'limit']) b[m] = () => b;
  b.maybeSingle = async () => {
    calls.n++;
    if (answer.throws) throw new Error('network');
    return { data: answer.data ?? null, error: answer.error ?? null };
  };
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
    calls.n++;
    return (answer.throws ? Promise.reject(new Error('network')) : Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null })).then(res, rej);
  };
  return { c: b as never, calls };
}

describe('bidderHasZip', () => {
  it('a confirmed empty ZIP blocks', async () => {
    expect(await bidderHasZip(client({ data: { postal_code: null } }).c, 'b-empty')).toBe(false);
  });
  it('a read error does not block', async () => {
    expect(await bidderHasZip(client({ error: { message: 'timeout' } }).c, 'b-err')).toBe(true);
    expect(await bidderHasZip(client({ throws: true }).c, 'b-throw')).toBe(true);
    expect(await bidderHasZip(client({ data: null }).c, 'b-norow')).toBe(true);
  });
  it('once known, no more lookups', async () => {
    const first = client({ data: { postal_code: '72601' } });
    expect(await bidderHasZip(first.c, 'b-has')).toBe(true);
    const second = client({ data: { postal_code: null } });
    expect(await bidderHasZip(second.c, 'b-has')).toBe(true);
    expect(second.calls.n).toBe(0);
  });
  it('remembered after a save', async () => {
    rememberBidderHasZip('b-saved');
    const c = client({ data: { postal_code: null } });
    expect(await bidderHasZip(c.c, 'b-saved')).toBe(true);
    expect(c.calls.n).toBe(0);
  });
});

describe('makeZipChecker: a failed ZIP-list lookup is not "unknown ZIP"', () => {
  it('lookup errors fail open to the format check', async () => {
    const r = await makeZipChecker(client({ error: { message: 'boom' } }).c).check('72601');
    expect(r).toEqual({ ok: true, zip: '72601' });
  });
  it('bad format is still refused', async () => {
    const r = await makeZipChecker(client({ data: [] }).c).check('7260');
    expect(r.ok).toBe(false);
  });
});
