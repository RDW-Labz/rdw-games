import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MONTHLY_CAP,
  ESSENTIAL_EMAIL_KINDS,
  cycleStart,
  isEssentialEmailKind,
  quotaConfig,
  saverOn,
} from '../email-quota';

describe('essential kinds', () => {
  it('keeps win, payment and pickup email', () => {
    for (const k of ['won', 'payment_succeeded', 'payment_failed', 'pickup_confirmed', 'pickup_reminder', 'pickup_no_show_forfeit', 'relot_fee_applied']) {
      expect(isEssentialEmailKind(k), k).toBe(true);
    }
  });
  it('drops the rest when the saver is on', () => {
    for (const k of ['outbid', 'saved_search_hit', 'marketing_digest', 'marketing_campaign', 'closing_soon', 'add_card_nudge', 'onboarding_nudge', 'referral_credited']) {
      expect(isEssentialEmailKind(k), k).toBe(false);
    }
    expect(ESSENTIAL_EMAIL_KINDS.size).toBe(7);
  });
});

describe('cycleStart (resets on the 4th, 22:38 UTC observed → hour 22)', () => {
  it('after the reset this month', () => {
    expect(cycleStart(new Date('2026-10-23T17:00:00Z')).toISOString()).toBe('2026-10-04T22:00:00.000Z');
  });
  it('before the reset this month → last month', () => {
    expect(cycleStart(new Date('2026-11-04T10:00:00Z')).toISOString()).toBe('2026-10-04T22:00:00.000Z');
    expect(cycleStart(new Date('2026-11-04T22:00:00Z')).toISOString()).toBe('2026-11-04T22:00:00.000Z');
  });
  it('January rolls back to December', () => {
    expect(cycleStart(new Date('2027-01-02T00:00:00Z')).toISOString()).toBe('2026-12-04T22:00:00.000Z');
  });
});

describe('saverOn', () => {
  it('turns on at 90% of the cap', () => {
    expect(saverOn(54_719, 60_800)).toBe(false);
    expect(saverOn(54_720, 60_800)).toBe(true);
    expect(saverOn(57_773, DEFAULT_MONTHLY_CAP)).toBe(true); // 2026-10-23
  });
});

describe('quotaConfig', () => {
  it('defaults', () => {
    expect(quotaConfig({})).toEqual({ cap: 60_800, cycleDay: 4, cycleHourUtc: 22, saverPct: 0.9 });
  });
  it('reads a raised plan from env and ignores junk', () => {
    expect(quotaConfig({ RESEND_MONTHLY_CAP: '100000', RESEND_SAVER_PCT: '0.95' })).toMatchObject({ cap: 100_000, saverPct: 0.95 });
    expect(quotaConfig({ RESEND_MONTHLY_CAP: 'lots', RESEND_SAVER_PCT: '7', RESEND_CYCLE_DAY: '31' })).toEqual({
      cap: 60_800,
      cycleDay: 4,
      cycleHourUtc: 22,
      saverPct: 0.9,
    });
  });
});
