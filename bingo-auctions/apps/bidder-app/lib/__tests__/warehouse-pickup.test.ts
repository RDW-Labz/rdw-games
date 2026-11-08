import { describe, expect, it, vi } from 'vitest';
import {
  describeWarehousePickup,
  fetchWarehousePickup,
  hoursLines,
} from '../warehouse-pickup';

describe('describeWarehousePickup', () => {
  it('treats a normal warehouse (no notice) as not off-site', () => {
    const d = describeWarehousePickup({ name: 'Main' });
    expect(d.isOffsite).toBe(false);
  });

  it('off-site with hours keeps Mon–Sun ordering', () => {
    const d = describeWarehousePickup({
      customer_notice: 'Off-site event',
      pickup_hours: {
        sun: [{ open: '09:00', close: '17:00' }],
        sat: [{ open: '09:00', close: '17:00' }],
      },
    });
    expect(d.isOffsite).toBe(true);
    expect(d.hoursLines).toEqual(['Sat 09:00–17:00', 'Sun 09:00–17:00']);
  });

  it('null input', () => {
    expect(describeWarehousePickup(null).isOffsite).toBe(false);
  });

  it('whitespace-only notice is not off-site', () => {
    expect(describeWarehousePickup({ customer_notice: '  ' }).isOffsite).toBe(false);
  });
});

describe('hoursLines', () => {
  it('formats compact day lines', () => {
    expect(hoursLines({ mon: [{ open: '10:00', close: '18:00' }] })).toEqual([
      'Mon 10:00–18:00',
    ]);
  });
});

describe('fetchWarehousePickup', () => {
  it('returns null when rpc returns an error', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'nope' } }),
    };
    await expect(fetchWarehousePickup(supabase as never, 'wh-1')).resolves.toBeNull();
  });

  it('returns the first row on success', async () => {
    const row = { name: 'Closeout', customer_notice: 'Hi' };
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: [row], error: null }),
    };
    await expect(fetchWarehousePickup(supabase as never, 'wh-1')).resolves.toEqual(row);
  });
});
