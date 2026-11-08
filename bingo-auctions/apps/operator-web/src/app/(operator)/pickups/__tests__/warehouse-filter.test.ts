import { describe, it, expect } from 'vitest';
import {
  filterMissingItemsByWarehouseId,
  filterPickupsByWarehouseId,
  resolveActiveWarehouseId,
} from '../warehouse-filter';

describe('resolveActiveWarehouseId', () => {
  const ids = ['wh-a', 'wh-b'];

  it('empty / whitespace → null (all warehouses)', () => {
    expect(resolveActiveWarehouseId(undefined, ids)).toBeNull();
    expect(resolveActiveWarehouseId('', ids)).toBeNull();
    expect(resolveActiveWarehouseId('  ', ids)).toBeNull();
  });

  it('unknown id → null', () => {
    expect(resolveActiveWarehouseId('wh-z', ids)).toBeNull();
  });

  it('known id → that id', () => {
    expect(resolveActiveWarehouseId('wh-b', ids)).toBe('wh-b');
    expect(resolveActiveWarehouseId('  wh-a  ', ids)).toBe('wh-a');
  });
});

describe('filterPickupsByWarehouseId', () => {
  const rows = [
    { id: '1', warehouse_id: 'wh-a' },
    { id: '2', warehouse_id: 'wh-b' },
    { id: '3', warehouse_id: null },
    { id: '4' },
  ];

  it('null warehouse filter returns all rows', () => {
    expect(filterPickupsByWarehouseId(rows, null)).toEqual(rows);
  });

  it('filters to matching warehouse_id', () => {
    expect(filterPickupsByWarehouseId(rows, 'wh-a').map((r) => r.id)).toEqual(['1', '3', '4']);
  });

  it('keeps rows missing warehouse_id (fail open)', () => {
    expect(filterPickupsByWarehouseId(rows, 'wh-b').map((r) => r.id)).toEqual(['2', '3', '4']);
  });
});

describe('filterMissingItemsByWarehouseId', () => {
  const rows = [
    { outcomeId: 'a', warehouseId: 'wh-a' },
    { outcomeId: 'b', warehouseId: 'wh-b' },
    { outcomeId: 'c', warehouseId: null },
  ];

  it('null filter → unchanged', () => {
    expect(filterMissingItemsByWarehouseId(rows, null)).toEqual(rows);
  });

  it('filters with fail-open on missing warehouseId', () => {
    expect(filterMissingItemsByWarehouseId(rows, 'wh-a').map((r) => r.outcomeId)).toEqual([
      'a',
      'c',
    ]);
  });
});
