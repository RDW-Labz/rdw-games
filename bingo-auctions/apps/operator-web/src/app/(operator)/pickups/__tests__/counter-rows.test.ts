import { describe, it, expect } from 'vitest';
import { customerLabel, invoiceShortId, owedLotCodes, type OwedLotLine } from '../counter-rows';

describe('customerLabel', () => {
  it('uses trimmed display_name', () => {
    expect(customerLabel({ display_name: 'Test Customer', email: 'a@b.com' })).toBe('Test Customer');
  });

  it('falls back to email when display_name is whitespace only', () => {
    expect(customerLabel({ display_name: '   ', email: 'test@example.com' })).toBe('test@example.com');
  });

  it('returns Name not on file when neither name nor email', () => {
    expect(customerLabel({ display_name: null, email: null })).toBe('Name not on file');
    expect(customerLabel({ display_name: '  ', email: '' })).toBe('Name not on file');
  });

  it('handles undefined bidder', () => {
    expect(customerLabel(undefined)).toBe('Name not on file');
  });
});

describe('invoiceShortId', () => {
  it('returns first 8 characters', () => {
    expect(invoiceShortId('abcdef12-3456-7890-abcd-ef1234567890')).toBe('abcdef12');
  });
});

describe('owedLotCodes', () => {
  const base = (overrides: Partial<OwedLotLine> & { lot_id: string }): OwedLotLine => ({
    picked_up_at: null,
    refunded_at: null,
    lots: {
      lot_code: 'BIN-000100',
      sticker_code: 'BIN:TEA1111111',
      display_code: null,
    },
    ...overrides,
  });

  it('returns empty array when no lines', () => {
    expect(owedLotCodes([], new Set())).toEqual([]);
  });

  it('excludes picked up, refunded, and missing lots', () => {
    const lines = [
      base({ lot_id: 'a' }),
      base({ lot_id: 'b', picked_up_at: '2026-01-01T00:00:00Z' }),
      base({ lot_id: 'c', refunded_at: '2026-01-01T00:00:00Z' }),
      base({ lot_id: 'd' }),
    ];
    const missing = new Set(['d']);
    expect(owedLotCodes(lines, missing).map((r) => r.code)).toEqual(['TEA1111111']);
  });

  it('shows sticker as primary and BIN lot_code as secondary', () => {
    const lines = [
      base({
        lot_id: 'x',
        lots: { lot_code: 'BIN-000200', sticker_code: 'BIN:BRN2222222', display_code: null },
      }),
    ];
    const [row] = owedLotCodes(lines, new Set());
    expect(row).toEqual({ code: 'BRN2222222', secondary: 'BIN-000200', noSticker: false });
  });

  it('strips operator prefix BIN:BRN4982227 → BRN4982227', () => {
    const lines = [
      base({
        lot_id: 'y',
        lots: { lot_code: 'BIN-009999', sticker_code: 'BIN:BRN4982227', display_code: null },
      }),
    ];
    expect(owedLotCodes(lines, new Set())[0]?.code).toBe('BRN4982227');
  });

  it('marks no-sticker lots when display matches lot_code', () => {
    const lines = [
      base({
        lot_id: 'z',
        lots: { lot_code: 'BIN-000300', sticker_code: null, display_code: 'BIN-000300' },
      }),
    ];
    const [row] = owedLotCodes(lines, new Set());
    expect(row).toEqual({ code: 'BIN-000300', secondary: null, noSticker: true });
  });

  it('sorts owed codes alphabetically', () => {
    const lines = [
      base({
        lot_id: '2',
        lots: { lot_code: 'BIN-2', sticker_code: 'BIN:ZZZ999', display_code: null },
      }),
      base({
        lot_id: '1',
        lots: { lot_code: 'BIN-1', sticker_code: 'BIN:AAA111', display_code: null },
      }),
    ];
    expect(owedLotCodes(lines, new Set()).map((r) => r.code)).toEqual(['AAA111', 'ZZZ999']);
  });
  it('shows the sticker when the lot has no BIN code', () => {
    const out = owedLotCodes(
      [{ lot_id: 'x', picked_up_at: null, refunded_at: null, lots: { lot_code: null, sticker_code: 'op:TEA4950002', display_code: null } }],
      new Set(),
    );
    expect(out).toEqual([{ code: 'TEA4950002', secondary: null, noSticker: false }]);
  });
});
