import { describe, expect, it } from 'vitest';
import { describeWarehousePickup } from '../warehouse-pickup';
import {
  buildOffsiteNotificationCopy,
  summarizePickupHoursForShortLine,
} from '../offsite-notification-copy';

describe('buildOffsiteNotificationCopy', () => {
  it('returns null when warehouse is not off-site', () => {
    const pickup = describeWarehousePickup({
      name: 'Main',
      address_line1: '119 East Crandall Avenue',
      city: 'Harrison',
      state: 'AR',
      postal_code: '72601',
    });
    expect(
      buildOffsiteNotificationCopy(pickup, '2026-10-17T14:00:00Z', '2026-10-18T22:00:00Z', 'America/Chicago'),
    ).toBeNull();
  });

  it('escapes HTML in notice and instructions', () => {
    const pickup = describeWarehousePickup({
      customer_notice: 'Closeout <script>alert(1)</script>',
      address_line1: '119 East Crandall Avenue',
      city: 'Harrison',
      state: 'AR',
      postal_code: '72601',
      pickup_instructions: 'Ring bell & wait',
    });
    const copy = buildOffsiteNotificationCopy(
      pickup,
      '2026-10-17T14:00:00Z',
      '2026-10-18T22:00:00Z',
      'America/Chicago',
    );
    expect(copy).not.toBeNull();
    expect(copy!.emailHtml).toContain('&lt;script&gt;');
    expect(copy!.emailHtml).not.toContain('<script>');
    expect(copy!.emailHtml).toContain('Ring bell &amp; wait');
    expect(copy!.emailHtml).toContain('Get directions</a>');
    expect(copy!.emailHtml).toContain(encodeURIComponent('119 East Crandall Avenue'));
  });

  it('keeps push line at or under 110 characters', () => {
    const pickup = describeWarehousePickup({
      customer_notice: 'Temporary location',
      address_line1: '119 East Crandall Avenue',
      address_line2: 'Building C loading dock behind the main store',
      city: 'Harrison',
      state: 'AR',
      postal_code: '72601',
      pickup_hours: {
        sat: [{ open: '09:00', close: '17:00' }],
        sun: [{ open: '09:00', close: '17:00' }],
      },
    });
    const copy = buildOffsiteNotificationCopy(pickup, null, null, 'America/Chicago');
    expect(copy).not.toBeNull();
    expect(copy!.pushLine.length).toBeLessThanOrEqual(110);
    expect(copy!.pushLine).toMatch(/Pickup at /);
    expect(summarizePickupHoursForShortLine(pickup.hoursLines)).toBe('Sat–Sun only');
  });
});
