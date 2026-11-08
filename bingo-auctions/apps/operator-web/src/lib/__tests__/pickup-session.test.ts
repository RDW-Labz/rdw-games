import { describe, expect, it } from 'vitest';
import { serpentineOrder, type SessionItem } from '../pickup-session';

const item = (
  lotCode: string,
  aisle: string | null,
  bay: string | null,
  warehouseId: string | null = 'wh-1',
): SessionItem => ({
  lotId: lotCode,
  lotCode,
  stickerCode: null,
  displayCode: lotCode,
  title: lotCode,
  photoUrl: null,
  invoiceId: 'inv',
  pickupId: 'pk',
  outcome: null,
  binCode: aisle ? `${aisle}-${bay ?? '?'}` : null,
  warehouseId,
  warehouseName: warehouseId,
  aisle,
  bay,
  pickupBy: null,
});

describe('serpentineOrder', () => {
  it('walks aisles in order, alternating bay direction (never doubles back)', () => {
    const items = [
      item('a1b3', '1', '3'),
      item('a2b1', '2', '1'),
      item('a1b1', '1', '1'),
      item('a2b4', '2', '4'),
      item('a3b2', '3', '2'),
    ];
    const order = serpentineOrder(items).map((i) => i.lotCode);
    // Aisle 1 ascending, aisle 2 DESCENDING (walked back up), aisle 3 ascending.
    expect(order).toEqual(['a1b1', 'a1b3', 'a2b4', 'a2b1', 'a3b2']);
  });

  it('natural-sorts aisle numbers (2 before 10)', () => {
    const items = [item('x', '10', '1'), item('y', '2', '1')];
    expect(serpentineOrder(items).map((i) => i.lotCode)).toEqual(['y', 'x']);
  });

  it('puts binless lots last, sorted by lot code', () => {
    const items = [item('zz', null, null), item('aa', null, null), item('binned', '1', '1')];
    expect(serpentineOrder(items).map((i) => i.lotCode)).toEqual(['binned', 'aa', 'zz']);
  });

  it('handles an empty list', () => {
    expect(serpentineOrder([])).toEqual([]);
  });
});

describe('serpentineOrder across warehouses (mig 0293)', () => {
  // Aisle labels repeat between buildings — "Aisle 1" exists in Harrison AND
  // Dodge City. Ordering by aisle alone interleaved them, producing a walk route
  // that zig-zagged between two warehouses ~400 miles apart.
  it('groups by warehouse instead of interleaving equal aisle labels', () => {
    const ordered = serpentineOrder([
      item('A-1', '1', '1', 'harrison'),
      item('B-1', '1', '1', 'dodge'),
      item('A-2', '2', '1', 'harrison'),
      item('B-2', '2', '1', 'dodge'),
    ]);
    const warehouses = ordered.map((i) => i.warehouseId);
    // Every item from one building must be contiguous.
    const firstRun = warehouses.filter((w) => w === warehouses[0]).length;
    expect(warehouses.slice(0, firstRun).every((w) => w === warehouses[0])).toBe(true);
    expect(new Set(warehouses.slice(firstRun)).size).toBe(1);
  });

  it('is unchanged for a single-warehouse walk', () => {
    const items = [item('A', '1', '1'), item('B', '1', '2'), item('C', '2', '1')];
    expect(serpentineOrder(items).map((i) => i.lotCode)).toEqual(
      serpentineOrder(items).map((i) => i.lotCode),
    );
    // Aisle 1 ascending, then aisle 2 (reversed direction) — the 0241 contract.
    expect(serpentineOrder(items).map((i) => i.lotCode)).toEqual(['A', 'B', 'C']);
  });
});
