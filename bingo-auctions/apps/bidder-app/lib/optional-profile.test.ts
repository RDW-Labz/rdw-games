import { SMS_CONSENT_ENABLED } from '@auction-platform/shared';
import { describe, expect, it } from 'vitest';
import {
  fetchOptionalProfileState,
  needsOptionalProfilePrompt,
  normalizePhone,
  saveOptionalProfile,
} from './optional-profile';

describe('needsOptionalProfilePrompt', () => {
  it('true only once optional_profile_prompted_at is confirmed null', () => {
    expect(
      needsOptionalProfilePrompt({
        phone: null,
        sms_consent_at: null,
        heard_about: null,
        heard_about_other: null,
        optional_profile_prompted_at: null,
      }),
    ).toBe(true);
  });
  it('false once prompted, regardless of whether anything was saved', () => {
    expect(
      needsOptionalProfilePrompt({
        phone: null,
        sms_consent_at: null,
        heard_about: null,
        heard_about_other: null,
        optional_profile_prompted_at: '2026-10-21T00:00:00.000Z',
      }),
    ).toBe(false);
  });
  it('false when the state is unknown (lookup failed / 0448 not applied)', () => {
    expect(needsOptionalProfilePrompt(null)).toBe(false);
  });
});

describe('normalizePhone', () => {
  it('assumes US for a bare 10-digit number', () => {
    expect(normalizePhone('5035551234')).toBe('+15035551234');
    expect(normalizePhone('(503) 555-1234')).toBe('+15035551234');
  });
  it('keeps an explicit country code', () => {
    expect(normalizePhone('+15035551234')).toBe('+15035551234');
    expect(normalizePhone('15035551234')).toBe('+15035551234');
  });
  it('empty input is null', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
  });
});

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
  } as unknown as Parameters<typeof saveOptionalProfile>[0];
}

describe('saveOptionalProfile', () => {
  it('rejects an invalid heard_about before ever calling the RPC', async () => {
    let called = false;
    const client = fakeClient({ rpc: async () => ((called = true), { error: null }) });
    expect(await saveOptionalProfile(client, { smsConsent: false, heardAbout: 'made_up' })).toBe(
      'invalid',
    );
    expect(called).toBe(false);
  });

  it('Skip (no fields) still calls the RPC with its defaults', async () => {
    const calls: unknown[] = [];
    const client = fakeClient({ rpc: async (n, a) => (calls.push([n, a]), { error: null }) });
    expect(await saveOptionalProfile(client, { smsConsent: false })).toBe('saved');
    expect(calls).toEqual([
      [
        'set_my_optional_profile',
        {
          p_phone: null,
          p_sms_consent: false,
          p_sms_consent_text_version: null,
          p_heard_about: null,
          p_heard_about_other: null,
        },
      ],
    ]);
  });

  it('phone + text consent held (SMS_CONSENT_ENABLED=false): never saves consent or a phone', async () => {
    expect(SMS_CONSENT_ENABLED).toBe(false);
    const calls: Array<{ p_phone: string | null; p_sms_consent: boolean; p_sms_consent_text_version: string | null }> = [];
    const client = fakeClient({
      rpc: async (_n, a) => (calls.push(a as never), { error: null }),
    });
    await saveOptionalProfile(client, { smsConsent: true, phone: '5035551234' });
    await saveOptionalProfile(client, { smsConsent: false, phone: '5035551234' });
    for (const c of calls) {
      expect(c.p_sms_consent).toBe(false);
      expect(c.p_sms_consent_text_version).toBeNull();
      expect(c.p_phone).toBeNull(); // NULL leaves any phone on file alone (0448 coalesce)
    }
  });

  it('heard_about_other is only sent when heard_about is other', async () => {
    const calls: Array<{ p_heard_about_other: string | null }> = [];
    const client = fakeClient({ rpc: async (_n, a) => (calls.push(a as never), { error: null }) });
    await saveOptionalProfile(client, {
      smsConsent: false,
      heardAbout: 'social_media',
      heardAboutOther: 'should be dropped',
    });
    await saveOptionalProfile(client, {
      smsConsent: false,
      heardAbout: 'other',
      heardAboutOther: '  Saw a flyer  ',
    });
    expect(calls[0]?.p_heard_about_other).toBeNull();
    expect(calls[1]?.p_heard_about_other).toBe('Saw a flyer');
  });

  it('server invalid_heard_about / consent_version_required (22023) maps to invalid', async () => {
    const client = fakeClient({ rpc: async () => ({ error: { code: '22023' } }) });
    expect(await saveOptionalProfile(client, { smsConsent: false, heardAbout: 'other' })).toBe(
      'invalid',
    );
  });

  it('missing RPC / offline maps to failed, never throws', async () => {
    const missing = fakeClient({ rpc: async () => ({ error: { code: 'PGRST202' } }) });
    expect(await saveOptionalProfile(missing, { smsConsent: false })).toBe('failed');
    const throws = fakeClient({
      rpc: async () => {
        throw new Error('offline');
      },
    });
    expect(await saveOptionalProfile(throws, { smsConsent: false })).toBe('failed');
  });
});

describe('fetchOptionalProfileState', () => {
  it('null when the columns do not exist yet (pre-0448)', async () => {
    const missingCol = fakeClient({
      select: async () => ({ data: null, error: { code: '42703' } }),
    });
    expect(await fetchOptionalProfileState(missingCol, 'u')).toBeNull();
  });
  it('returns the row when the read succeeds', async () => {
    const row = {
      phone: '+15035551234',
      sms_consent_at: null,
      heard_about: null,
      heard_about_other: null,
      optional_profile_prompted_at: null,
    };
    const client = fakeClient({ select: async () => ({ data: row, error: null }) });
    expect(await fetchOptionalProfileState(client, 'u')).toEqual(row);
  });
});
