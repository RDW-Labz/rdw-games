import { describe, expect, it } from 'vitest';
import { describeWarehousePickup, hoursLines } from '../warehouse-pickup';

describe('describeWarehousePickup', () => {
  it('treats a normal warehouse (no notice) as not off-site', () => {
    const d = describeWarehousePickup({
      name: 'Main',
      address_line1: '119 East Crandall Avenue',
      city: 'Harrison',
      state: 'AR',
      postal_code: '72601',
    });
    expect(d.isOffsite).toBe(false);
    expect(d.notice).toBeNull();
  });

  it('returns isOffsite false for null input', () => {
    expect(describeWarehousePickup(null).isOffsite).toBe(false);
    expect(describeWarehousePickup(undefined).isOffsite).toBe(false);
  });

  it('whitespace-only notice is not off-site', () => {
    expect(describeWarehousePickup({ customer_notice: '   \n' }).isOffsite).toBe(false);
  });

  it('off-site warehouse builds fullAddress, directions URL, and ordered hours', () => {
    const d = describeWarehousePickup({
      customer_notice: 'Closeout sale at our temporary location.',
      address_line1: '119 East Crandall Avenue',
      address_line2: 'Suite B',
      city: 'Harrison',
      state: 'AR',
      postal_code: '72601',
      pickup_hours: {
        sun: [{ open: '09:00', close: '17:00' }],
        sat: [{ open: '09:00', close: '17:00' }],
      },
    });
    expect(d.isOffsite).toBe(true);
    expect(d.fullAddress).toBe('119 East Crandall Avenue, Suite B, Harrison, AR, 72601');
    expect(d.directionsUrl).toBe(
      `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(d.fullAddress!)}`,
    );
    expect(d.hoursLines).toEqual(['Sat 09:00–17:00', 'Sun 09:00–17:00']);
    expect(d.addressLines).toEqual([
      '119 East Crandall Avenue',
      'Suite B',
      'Harrison, AR 72601',
    ]);
  });
});

describe('hoursLines', () => {
  it('matches footer sample ordering (Mon–Sun)', () => {
    const lines = hoursLines({
      wed: [{ open: '10:00', close: '18:00' }],
      mon: [{ open: '10:00', close: '18:00' }],
    });
    expect(lines).toEqual(['Mon 10:00–18:00', 'Wed 10:00–18:00']);
  });
});
