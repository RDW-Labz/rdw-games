import { describe, it, expect } from 'vitest';
import { filterByWarehouseId, filterRowsByWarehouse } from './warehouse-filter';

describe('filterRowsByWarehouse', () => {
  const rows = [
    { id: 'a', warehouse_id: 'wh-1' },
    { id: 'b', warehouse_id: 'wh-2' },
    { id: 'c', warehouse_id: null },
    { id: 'd' },
  ];

  it('All → returns rows unchanged (new array, same contents)', () => {
    expect(filterRowsByWarehouse(rows, null, (r) => r.warehouse_id)).toEqual(rows);
    expect(filterRowsByWarehouse(rows, undefined, (r) => r.warehouse_id)).toEqual(rows);
    expect(filterRowsByWarehouse(rows, '', (r) => r.warehouse_id)).toEqual(rows);
  });

  it('id → keeps matching rows and rows missing warehouse id', () => {
    expect(
      filterRowsByWarehouse(rows, 'wh-1', (r) => r.warehouse_id).map((r) => r.id),
    ).toEqual(['a', 'c', 'd']);
    expect(
      filterRowsByWarehouse(rows, 'wh-2', (r) => r.warehouse_id).map((r) => r.id),
    ).toEqual(['b', 'c', 'd']);
  });

  it('custom getter', () => {
    const nested = [{ wh: 'wh-1' }, { wh: null }];
    expect(filterRowsByWarehouse(nested, 'wh-1', (r) => r.wh)).toEqual(nested);
  });
});

describe('filterByWarehouseId', () => {
  it('delegates to warehouse_id field', () => {
    const rows = [{ warehouse_id: 'x' }, { warehouse_id: 'y' }];
    expect(filterByWarehouseId(rows, 'y')).toEqual([{ warehouse_id: 'y' }]);
  });
});
