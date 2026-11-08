import { describe, it, expect } from 'vitest';
import { parseLoadSummary, summaryStateFrom } from '@/lib/load-summary';

describe('parseLoadSummary', () => {
  it('parses a full RPC object', () => {
    expect(
      parseLoadSummary({
        lots: 10,
        sold: 7,
        unsold: 3,
        relist_copies: 2,
        invoice_lines: 8,
        refunded_lines: 1,
        forfeited_lines: 0,
        hammer_cents: 50000,
        premium_cents: 7500,
        gross_cents: 57500,
        refunds_cents: 1200,
        net_revenue_cents: 56300,
        purchase_cost_cents: 20000,
        profit_cents: 36300,
      }),
    ).toEqual({
      lots: 10,
      sold: 7,
      unsold: 3,
      relistCopies: 2,
      invoiceLines: 8,
      refundedLines: 1,
      forfeitedLines: 0,
      hammerCents: 50000,
      premiumCents: 7500,
      grossCents: 57500,
      refundsCents: 1200,
      netRevenueCents: 56300,
      costCents: 20000,
      profitCents: 36300,
    });
  });

  it('defaults missing numeric fields to 0', () => {
    expect(parseLoadSummary({})).toEqual({
      lots: 0,
      sold: 0,
      unsold: 0,
      relistCopies: 0,
      invoiceLines: 0,
      refundedLines: 0,
      forfeitedLines: 0,
      hammerCents: 0,
      premiumCents: 0,
      grossCents: 0,
      refundsCents: 0,
      netRevenueCents: 0,
      costCents: null,
      profitCents: null,
    });
  });

  it('keeps profit and cost null when absent or null', () => {
    expect(
      parseLoadSummary({ purchase_cost_cents: null, profit_cents: null }),
    ).toEqual({
      lots: 0,
      sold: 0,
      unsold: 0,
      relistCopies: 0,
      invoiceLines: 0,
      refundedLines: 0,
      forfeitedLines: 0,
      hammerCents: 0,
      premiumCents: 0,
      grossCents: 0,
      refundsCents: 0,
      netRevenueCents: 0,
      costCents: null,
      profitCents: null,
    });
  });

  it('returns null for non-objects', () => {
    expect(parseLoadSummary(null)).toBeNull();
    expect(parseLoadSummary('x')).toBeNull();
    expect(parseLoadSummary(42)).toBeNull();
  });

  it('coerces numeric strings', () => {
    expect(parseLoadSummary({ lots: '12', gross_cents: '9900' })?.lots).toBe(12);
    expect(parseLoadSummary({ lots: '12', gross_cents: '9900' })?.grossCents).toBe(9900);
  });
});

describe('summaryStateFrom', () => {
  it('maps 42501 to forbidden', () => {
    expect(summaryStateFrom(null, { code: '42501', message: 'nope' })).toEqual({
      kind: 'forbidden',
    });
  });

  it('maps load_summary_forbidden in message to forbidden', () => {
    expect(
      summaryStateFrom(null, { message: 'load_summary_forbidden' }),
    ).toEqual({ kind: 'forbidden' });
  });

  it('maps PGRST202 to unavailable', () => {
    expect(summaryStateFrom(null, { code: 'PGRST202' })).toEqual({
      kind: 'unavailable',
    });
  });

  it('maps other errors to error state', () => {
    expect(summaryStateFrom(null, { code: 'XX', message: 'boom' })).toEqual({
      kind: 'error',
      message: 'boom',
    });
  });

  it('returns ok when data parses and there is no error', () => {
    const state = summaryStateFrom({ lots: 1, sold: 1 }, null);
    expect(state.kind).toBe('ok');
    if (state.kind === 'ok') {
      expect(state.summary.lots).toBe(1);
      expect(state.summary.sold).toBe(1);
    }
  });

  it('returns error when data is null without an error', () => {
    expect(summaryStateFrom(null, null)).toEqual({
      kind: 'error',
      message: 'Unexpected response',
    });
  });
});
