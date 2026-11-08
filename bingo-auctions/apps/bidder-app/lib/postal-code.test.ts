import { describe, expect, it } from 'vitest';
import {
  isZipPromptDue,
  sanitizeZipInput,
  saveMyZip,
  snoozeZipPrompt,
  fetchZipPromptState,
  validateZip,
  ZIP_ERROR_MESSAGE,
  encodePendingZip,
  pendingZipFor,
} from './postal-code';

const NOW = new Date('2026-10-21T15:00:00.000Z');
const state = (over: Partial<Parameters<typeof isZipPromptDue>[0] & object> = {}) => ({
  postal_code: null,
  postal_code_prompt_count: 0,
  postal_code_prompt_after: null,
  ...over,
});

describe('validateZip', () => {
  it('accepts five digits, trimmed', () => {
    expect(validateZip('72712')).toEqual({ ok: true, zip: '72712' });
    expect(validateZip('  72712 ')).toEqual({ ok: true, zip: '72712' });
  });
  it('empty / null / spaces clear the ZIP', () => {
    expect(validateZip('')).toEqual({ ok: true, zip: null });
    expect(validateZip('   ')).toEqual({ ok: true, zip: null });
    expect(validateZip(null)).toEqual({ ok: true, zip: null });
    expect(validateZip(undefined)).toEqual({ ok: true, zip: null });
  });
  it('rejects anything else with the one message', () => {
    for (const bad of ['7271', '727123', 'abcde', '72-12', '72712-1234', '7 712']) {
      expect(validateZip(bad)).toEqual({ ok: false, error: ZIP_ERROR_MESSAGE });
    }
    expect(ZIP_ERROR_MESSAGE).toBe('Enter a 5-digit ZIP');
  });
});

describe('sanitizeZipInput', () => {
  it('keeps digits only, max five', () => {
    expect(sanitizeZipInput('72a7-12 99')).toBe('72712');
    expect(sanitizeZipInput('')).toBe('');
  });
});

describe('isZipPromptDue', () => {
  it('due: no ZIP, never snoozed', () => {
    expect(isZipPromptDue(state(), NOW)).toBe(true);
  });
  it('not due without a row (signed out, lookup failed, 0434 not applied)', () => {
    expect(isZipPromptDue(null, NOW)).toBe(false);
  });
  it('snoozed: hidden until prompt_after, due once it has passed', () => {
    // "Not now" on 10-01 15:00 UTC → prompt_after = 10-31 15:00 UTC (30 days).
    const snoozed = state({ postal_code_prompt_count: 1, postal_code_prompt_after: '2026-10-31T15:00:00.000Z' });
    expect(isZipPromptDue(snoozed, NOW)).toBe(false); // 10-21 < 10-31
    expect(isZipPromptDue(snoozed, new Date('2026-10-31T15:00:00.000Z'))).toBe(false); // not strictly after
    expect(isZipPromptDue(snoozed, new Date('2026-10-31T15:00:01.000Z'))).toBe(true);
  });
  it('third "Not now" → never again, even after the snooze runs out', () => {
    const second = state({ postal_code_prompt_count: 2, postal_code_prompt_after: '2026-09-01T00:00:00.000Z' });
    expect(isZipPromptDue(second, NOW)).toBe(true); // 2 dismissals, snooze over → one last time
    const third = state({ postal_code_prompt_count: 3, postal_code_prompt_after: '2026-11-20T15:00:00.000Z' });
    expect(isZipPromptDue(third, NOW)).toBe(false);
    expect(isZipPromptDue(third, new Date('2027-06-01T00:00:00.000Z'))).toBe(false);
  });
  it('ZIP set → never', () => {
    expect(isZipPromptDue(state({ postal_code: '72712' }), NOW)).toBe(false);
    expect(isZipPromptDue(state({ postal_code: '72712', postal_code_prompt_count: 0 }), new Date('2030-01-01'))).toBe(false);
  });
  it('unparseable prompt_after → do not prompt', () => {
    expect(isZipPromptDue(state({ postal_code_prompt_after: 'garbage' }), NOW)).toBe(false);
  });
});

// Minimal fake of the bits of the Supabase client these calls use.
function fakeClient(opts: {
  rpc?: (name: string, args?: unknown) => Promise<{ error: { code?: string; message?: string } | null }>;
  select?: () => Promise<{ data: unknown; error: unknown }>;
}) {
  return {
    rpc: opts.rpc ?? (async () => ({ error: null })),
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: opts.select ?? (async () => ({ data: null, error: null })) }),
      }),
    }),
  } as unknown as Parameters<typeof saveMyZip>[0];
}

describe('server calls fail soft', () => {
  it('saveMyZip: saved / invalid / failed (missing RPC, throw)', async () => {
    const calls: unknown[] = [];
    const ok = fakeClient({ rpc: async (n, a) => (calls.push([n, a]), { error: null }) });
    expect(await saveMyZip(ok, '72712')).toBe('saved');
    expect(await saveMyZip(ok, null)).toBe('saved');
    expect(calls).toEqual([
      ['set_my_postal_code', { p_postal_code: '72712' }],
      ['set_my_postal_code', { p_postal_code: '' }],
    ]);
    const invalid = fakeClient({ rpc: async () => ({ error: { code: '22023', message: 'invalid_postal_code' } }) });
    expect(await saveMyZip(invalid, '1')).toBe('invalid');
    const missing = fakeClient({ rpc: async () => ({ error: { code: 'PGRST202', message: 'Could not find the function' } }) });
    expect(await saveMyZip(missing, '72712')).toBe('failed');
    const throws = fakeClient({ rpc: async () => { throw new Error('offline'); } });
    expect(await saveMyZip(throws, '72712')).toBe('failed');
  });
  it('snoozeZipPrompt never throws', async () => {
    await expect(snoozeZipPrompt(fakeClient({ rpc: async () => { throw new Error('x'); } }))).resolves.toBeUndefined();
  });
  it('fetchZipPromptState: null when the column does not exist yet', async () => {
    const missingCol = fakeClient({
      select: async () => ({ data: null, error: { code: '42703', message: 'column bidders.postal_code does not exist' } }),
    });
    expect(await fetchZipPromptState(missingCol, 'u')).toBeNull();
    const throws = fakeClient({ select: async () => { throw new Error('offline'); } });
    expect(await fetchZipPromptState(throws, 'u')).toBeNull();
    const row = { postal_code: null, postal_code_prompt_count: 0, postal_code_prompt_after: null };
    expect(await fetchZipPromptState(fakeClient({ select: async () => ({ data: row, error: null }) }), 'u')).toEqual(row);
  });
});

describe('pending signup ZIP', () => {
  it('applies only to the same email (case-insensitive)', () => {
    const raw = encodePendingZip('72712', ' New.Bidder@Example.test ');
    expect(pendingZipFor(raw, 'new.bidder@example.test')).toBe('72712');
    expect(pendingZipFor(raw, 'NEW.BIDDER@EXAMPLE.TEST')).toBe('72712');
    expect(pendingZipFor(raw, 'someone.else@example.test')).toBeNull();
    expect(pendingZipFor(raw, null)).toBeNull();
  });
  it('ignores missing / malformed / invalid values', () => {
    expect(pendingZipFor(null, 'a@example.test')).toBeNull();
    expect(pendingZipFor('not json', 'a@example.test')).toBeNull();
    expect(pendingZipFor(encodePendingZip('123', 'a@example.test'), 'a@example.test')).toBeNull();
    expect(pendingZipFor(JSON.stringify({ zip: 72712, email: 'a@example.test' }), 'a@example.test')).toBeNull();
  });
});
