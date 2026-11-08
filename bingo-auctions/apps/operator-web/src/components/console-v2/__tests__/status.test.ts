import { describe, it, expect } from 'vitest';
import { CONSOLE_GALLERY_STATUSES, statusPresentation } from '../status';

describe('statusPresentation', () => {
  it('covers all gallery statuses with labels', () => {
    const expected: Record<string, string> = {
      in_inventory: 'In inventory',
      scheduled: 'Scheduled',
      live: 'Live',
      sold: 'Sold',
      paid: 'Paid',
      checked_in: 'Checked in',
      unpaid: 'Unpaid',
      refunded: 'Refunded',
      handed_over: 'Handed over',
      missing: 'Missing',
      disposed: 'Disposed',
    };

    for (const status of CONSOLE_GALLERY_STATUSES) {
      const pres = statusPresentation(status);
      expect(pres.label).toBe(expected[status]);
      expect(pres.foreground).toMatch(/^var\(--console-/);
      expect(pres.background).toMatch(/^var\(--console-/);
    }
  });

  it('maps live to auction status tokens', () => {
    const pres = statusPresentation('live');
    expect(pres.foreground).toBe('var(--console-status-live-fg)');
    expect(pres.background).toBe('var(--console-status-live-bg)');
  });

  it('maps payment meanings to Nightshift status tokens', () => {
    expect(statusPresentation('paid').foreground).toBe('var(--console-status-paid-fg)');
    expect(statusPresentation('paid').background).toBe('var(--console-status-paid-bg)');
    expect(statusPresentation('checked_in').foreground).toBe('var(--console-status-checked-in-fg)');
    expect(statusPresentation('checked_in').background).toBe('var(--console-status-checked-in-bg)');
    expect(statusPresentation('unpaid').foreground).toBe('var(--console-status-unpaid-fg)');
    expect(statusPresentation('unpaid').background).toBe('var(--console-status-unpaid-bg)');
    expect(statusPresentation('refunded').foreground).toBe('var(--console-status-refunded-fg)');
    expect(statusPresentation('refunded').background).toBe('var(--console-status-refunded-bg)');
  });
});

describe('statusPresentation aliases (raw DB values → meaning)', () => {
  it('lot won reads as Sold', () => {
    expect(statusPresentation('won')).toMatchObject({
      label: 'Sold',
      foreground: 'var(--console-status-sold-fg)',
    });
  });
  it('invoice pending / failed states read as Unpaid amber', () => {
    expect(statusPresentation('pending').foreground).toBe('var(--console-status-unpaid-fg)');
    expect(statusPresentation('payment_failed_grace')).toMatchObject({
      label: 'Payment failed',
      foreground: 'var(--console-status-unpaid-fg)',
    });
  });
  it('partially refunded is still paid (green) with its own label', () => {
    expect(statusPresentation('partially_refunded')).toMatchObject({
      label: 'Partially refunded',
      foreground: 'var(--console-status-paid-fg)',
    });
  });
  it('unknown values stay neutral (no prototype keys)', () => {
    expect(statusPresentation('toString').foreground).toBe('var(--console-neutral)');
  });
});
