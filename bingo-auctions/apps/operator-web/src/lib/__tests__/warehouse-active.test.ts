import { describe, expect, it } from 'vitest';
import { isWarehouseActive } from '../warehouse-active';

describe('isWarehouseActive', () => {
  it('is true when active is true, undefined, or null', () => {
    expect(isWarehouseActive({ active: true })).toBe(true);
    expect(isWarehouseActive({ active: undefined })).toBe(true);
    expect(isWarehouseActive({ active: null })).toBe(true);
    expect(isWarehouseActive({})).toBe(true);
  });

  it('is false only when active is explicitly false', () => {
    expect(isWarehouseActive({ active: false })).toBe(false);
  });
});
