// __tests__/money.test.ts
//
// Vitest tests for parseCents(), centsToDollars(), safeParseFloat() from money.ts.
// Run via:
//
//   npm test --workspace=@auction-platform/domain-lotting

import { describe, it, expect } from 'vitest';

import { parseCents, centsToDollars, safeParseFloat } from '../money';

// ---------------------------------------------------------------------------
// parseCents
// ---------------------------------------------------------------------------

describe('parseCents — null / empty inputs', () => {
  it('null → null', () => expect(parseCents(null)).toBeNull());
  it('undefined → null', () => expect(parseCents(undefined)).toBeNull());
  it('empty string → null', () => expect(parseCents('')).toBeNull());
  it('"free" → null', () => expect(parseCents('free')).toBeNull());
  it('"N/A" → null', () => expect(parseCents('N/A')).toBeNull());
  it('bare dash "-" → null', () => expect(parseCents('-')).toBeNull());
});

describe('parseCents — dollar-string parsing', () => {
  it('"$1,234.56" → 123456', () => expect(parseCents('$1,234.56')).toBe(123456));
  it('"1234.56" without $ → 123456', () => expect(parseCents('1234.56')).toBe(123456));
  it('"$0.99" → 99', () => expect(parseCents('$0.99')).toBe(99));
  it('"$1" whole dollar → 100', () => expect(parseCents('$1')).toBe(100));
  it('"0" → 0', () => expect(parseCents('0')).toBe(0));
  it('"$0.00" → 0', () => expect(parseCents('$0.00')).toBe(0));
  it('"  $12.50  " with surrounding spaces → 1250',
    () => expect(parseCents('  $12.50  ')).toBe(1250));
  it('"1,000,000.00" → 100000000', () => expect(parseCents('1,000,000.00')).toBe(100000000));
});

describe('parseCents — numeric input', () => {
  it('1234.56 → 123456', () => expect(parseCents(1234.56)).toBe(123456));
  it('0 → 0', () => expect(parseCents(0)).toBe(0));
  it('0.99 → 99', () => expect(parseCents(0.99)).toBe(99));
  it('Infinity → null', () => expect(parseCents(Infinity)).toBeNull());
  it('NaN → null', () => expect(parseCents(NaN)).toBeNull());
});

describe('parseCents — negative values rejected', () => {
  it('"-1.00" string → null', () => expect(parseCents('-1.00')).toBeNull());
  it('-5 number → null', () => expect(parseCents(-5)).toBeNull());
  it('"$-10" → null', () => expect(parseCents('$-10')).toBeNull());
});

describe('parseCents — rounding', () => {
  // 1.005 in floating point is slightly below 1.005 so Math.round gives 100,
  // but 1.004999999... → 100; test that we don't crash, result is integer.
  it('returns integer (no fractional cents)', () => {
    const result = parseCents('0.001');
    expect(result).not.toBeNull();
    expect(Number.isInteger(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// centsToDollars
// ---------------------------------------------------------------------------

describe('centsToDollars — happy path', () => {
  it('123456 → "$1,234.56"', () => expect(centsToDollars(123456)).toBe('$1,234.56'));
  it('99 → "$0.99"', () => expect(centsToDollars(99)).toBe('$0.99'));
  it('100 → "$1.00"', () => expect(centsToDollars(100)).toBe('$1.00'));
  it('0 → "$0.00"', () => expect(centsToDollars(0)).toBe('$0.00'));
  it('100000000 → "$1,000,000.00"', () =>
    expect(centsToDollars(100000000)).toBe('$1,000,000.00'));
});

describe('centsToDollars — null / undefined inputs', () => {
  it('null → ""', () => expect(centsToDollars(null)).toBe(''));
  it('undefined → ""', () => expect(centsToDollars(undefined)).toBe(''));
});

// ---------------------------------------------------------------------------
// safeParseFloat
// ---------------------------------------------------------------------------

describe('safeParseFloat — happy path', () => {
  it('"3.14" → 3.14', () => expect(safeParseFloat('3.14')).toBeCloseTo(3.14));
  it('"42" → 42', () => expect(safeParseFloat('42')).toBe(42));
  it('42 (number) → 42', () => expect(safeParseFloat(42)).toBe(42));
  it('"0" → 0', () => expect(safeParseFloat('0')).toBe(0));
  it('"  1.5  " → 1.5', () => expect(safeParseFloat('  1.5  ')).toBeCloseTo(1.5));
});

describe('safeParseFloat — null / invalid inputs', () => {
  it('null → null', () => expect(safeParseFloat(null)).toBeNull());
  it('undefined → null', () => expect(safeParseFloat(undefined)).toBeNull());
  it('empty string → null', () => expect(safeParseFloat('')).toBeNull());
  it('"abc" → null', () => expect(safeParseFloat('abc')).toBeNull());
  it('NaN → null', () => expect(safeParseFloat(NaN)).toBeNull());
  it('Infinity → null', () => expect(safeParseFloat(Infinity)).toBeNull());
  it('-Infinity → null', () => expect(safeParseFloat(-Infinity)).toBeNull());
});
