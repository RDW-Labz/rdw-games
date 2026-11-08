import { describe, expect, it } from 'vitest';
import { buildEmailHtml } from '../email-drain';
import { buildOffsiteNotificationCopy } from '@/lib/offsite-notification-copy';
import { describeWarehousePickup } from '@/lib/warehouse-pickup';

const BASE_ROW = {
  id: 'n-1',
  target_user_id: 'bidder-1',
  email_attempt_count: 0,
  payload: {
    lot_title: 'Vintage lamp',
    lot_id: 'lot-1',
    invoice_id: 'inv-1',
    lot_code: 'BIN-100',
  },
};

describe('email-drain off-site pickup', () => {
  it('won email without off-site matches the standard template', () => {
    const row = {
      ...BASE_ROW,
      kind: 'won' as const,
      payload: { ...BASE_ROW.payload, winning_bid_cents: 2500 },
    };
    const html = buildEmailHtml(row)?.html ?? '';
    expect(html).toContain('Pay your invoice, then collect during the pickup window posted for this auction');
    expect(html).not.toContain('Get directions');
    expect(html).not.toContain('Pickup window:');
  });

  it('payment_succeeded email without off-site matches the standard template', () => {
    const row = {
      ...BASE_ROW,
      kind: 'payment_succeeded' as const,
      payload: { ...BASE_ROW.payload, amount_cents: 2500 },
    };
    const baseline = buildEmailHtml(row);
    const again = buildEmailHtml(row, null);
    expect(again).toEqual(baseline);
    expect(baseline?.html).toContain('there\'s no separate "ready for pickup" message to wait for');
    expect(baseline?.html).not.toContain('Get directions');
  });

  it('won email with off-site includes address and directions URL', () => {
    const pickup = describeWarehousePickup({
      customer_notice: 'Temporary Crandall warehouse',
      address_line1: '119 East Crandall Avenue',
      city: 'Harrison',
      state: 'AR',
      postal_code: '72601',
      pickup_hours: {
        sat: [{ open: '09:00', close: '17:00' }],
        sun: [{ open: '09:00', close: '17:00' }],
      },
    });
    const offsite = buildOffsiteNotificationCopy(
      pickup,
      '2026-10-17T14:00:00.000Z',
      '2026-10-18T22:00:00.000Z',
      'America/Chicago',
    );
    expect(offsite).not.toBeNull();

    const row = {
      ...BASE_ROW,
      kind: 'won' as const,
      payload: { ...BASE_ROW.payload, winning_bid_cents: 2500 },
    };
    const html = buildEmailHtml(row, offsite)?.html ?? '';
    expect(html).toContain('119 East Crandall Avenue');
    expect(html).toContain('maps/dir/?api=1&amp;destination=');
    expect(html).toContain('Temporary Crandall warehouse');
    expect(html).toContain('Pickup window:');
  });

  it('payment_succeeded email with off-site includes address and directions URL', () => {
    const pickup = describeWarehousePickup({
      customer_notice: 'Off-site pickup',
      address_line1: '119 East Crandall Avenue',
      city: 'Harrison',
      state: 'AR',
      postal_code: '72601',
    });
    const offsite = buildOffsiteNotificationCopy(pickup, null, null, 'America/Chicago');
    const row = {
      ...BASE_ROW,
      kind: 'payment_succeeded' as const,
      payload: { ...BASE_ROW.payload, amount_cents: 1000 },
    };
    const html = buildEmailHtml(row, offsite)?.html ?? '';
    expect(html).toContain('119 East Crandall Avenue, Harrison, AR, 72601');
    expect(html).toContain('Get directions</a>');
  });
});
