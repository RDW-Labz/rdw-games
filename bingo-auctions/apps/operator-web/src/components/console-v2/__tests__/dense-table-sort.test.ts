import { describe, it, expect } from 'vitest';
import { compareSortValues } from '../dense-table-sort';

describe('compareSortValues', () => {
  it('sorts numbers ascending with nulls last', () => {
    expect(compareSortValues(2, 10, 'ascending', 0, 1)).toBeLessThan(0);
    expect(compareSortValues(null, 1, 'ascending', 0, 1)).toBeGreaterThan(0);
    expect(compareSortValues(5, null, 'ascending', 0, 1)).toBeLessThan(0);
  });

  it('sorts strings with locale compare', () => {
    expect(compareSortValues('b', 'a', 'ascending', 0, 1)).toBeGreaterThan(0);
    expect(compareSortValues('a', 'b', 'descending', 0, 1)).toBeGreaterThan(0);
  });

  it('is stable on ties', () => {
    expect(compareSortValues('x', 'x', 'ascending', 2, 5)).toBeLessThan(0);
    expect(compareSortValues('x', 'x', 'ascending', 5, 2)).toBeGreaterThan(0);
  });

  it('coerces numeric strings', () => {
    expect(compareSortValues('10', '2', 'ascending', 0, 1)).toBeGreaterThan(0);
  });
});
