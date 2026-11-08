import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import { hashPii, toCapiPayload, MAX_EVENT_AGE_DAYS } from '../meta-capi';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

describe('hashPii — normalisation is what makes a hash matchable', () => {
  it('lowercases and trims an email before hashing', () => {
    // An unnormalised hash is ACCEPTED by Meta and then matches nobody, so the
    // failure looks like "the API works but ads never convert".
    expect(hashPii('  Michael@Example.COM ')).toBe(sha('michael@example.com'));
  });

  it('strips every non-digit from a phone', () => {
    expect(hashPii('+1 (479) 555-0134', 'phone')).toBe(sha('14795550134'));
  });

  it('returns null for empty input rather than hashing the empty string', () => {
    // sha256('') is a real, permanently unmatchable value; the key must be
    // omitted instead.
    expect(hashPii('')).toBeNull();
    expect(hashPii(null)).toBeNull();
    expect(hashPii(undefined)).toBeNull();
    expect(hashPii('   ', 'email')).toBeNull();
    expect(hashPii('abc', 'phone')).toBeNull();
  });

  it('never returns the plaintext', () => {
    const out = hashPii('michael@example.com');
    expect(out).not.toContain('michael');
    expect(out).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('toCapiPayload — the wire contract', () => {
  const base = {
    eventName: 'Purchase' as const,
    eventId: 'invoice:2f1c9b60-0000-4000-8000-000000000001',
    occurredAt: new Date('2026-08-29T19:00:00Z'),
  };

  it('sends event_time in SECONDS, not milliseconds', () => {
    // Milliseconds read as a date centuries out and Meta silently drops it.
    const p = toCapiPayload(base);
    expect(p.event_time).toBe(Math.floor(base.occurredAt.getTime() / 1000));
    expect(String(p.event_time)).toHaveLength(10);
  });

  it('carries the event_id so a browser duplicate can be collapsed', () => {
    expect(toCapiPayload(base).event_id).toBe(base.eventId);
  });

  it('hashes every user field and includes no plaintext anywhere', () => {
    const p = toCapiPayload({
      ...base,
      email: 'Michael@Example.com',
      phone: '(479) 555-0134',
      externalId: 'bidder-uuid',
    });
    const ud = p.user_data as Record<string, string>;
    expect(ud.em).toBe(sha('michael@example.com'));
    expect(ud.ph).toBe(sha('4795550134'));
    expect(ud.external_id).toBe(sha('bidder-uuid'));
    expect(JSON.stringify(p)).not.toMatch(/michael@example\.com/i);
    expect(JSON.stringify(p)).not.toContain('555-0134');
  });

  it('omits absent user keys instead of sending empty hashes', () => {
    const ud = toCapiPayload(base).user_data as Record<string, string>;
    expect(ud).toEqual({});
  });

  it('renders value as major units with currency, from cents', () => {
    const p = toCapiPayload({ ...base, valueCents: 864 });
    expect(p.custom_data).toEqual({ currency: 'USD', value: '8.64' });
  });

  it('omits custom_data entirely for a valueless event', () => {
    const p = toCapiPayload({ ...base, eventName: 'CompleteRegistration', valueCents: null });
    expect(p.custom_data).toBeUndefined();
  });

  it('keeps a zero value rather than dropping it as falsy', () => {
    const p = toCapiPayload({ ...base, valueCents: 0 });
    expect(p.custom_data).toEqual({ currency: 'USD', value: '0.00' });
  });
});

describe('MAX_EVENT_AGE_DAYS', () => {
  it('matches Meta’s rejection window, so the drain retires rather than retries', () => {
    expect(MAX_EVENT_AGE_DAYS).toBe(7);
  });
});
