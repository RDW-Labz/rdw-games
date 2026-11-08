import { describe, it, expect } from 'vitest';
import {
  buildWarehouseDayRows,
  buildMembersAtLimit,
  dateKeyInTimeZone,
  type UsageWarehouse,
  type UsageSlotBooking,
  type UsageInspection,
} from '../aggregate';

const NOW = new Date('2026-10-26T18:00:00Z'); // a Monday, mid-day Chicago

const WAREHOUSE: UsageWarehouse = {
  id: 'wh-1',
  name: 'Flagship',
  timezone: 'America/Chicago',
  pickupHours: { mon: [{ open: '10:00', close: '18:00' }] }, // 8h = 480min
  stagedOrdersPerDay: 15,
  inspectionsPerDay: 10,
  slotMinutes: 30, // -> 16 slots
  membersPerSlot: 3, // -> capacity 48
  largeOrdersPerDay: 2,
};

describe('dateKeyInTimeZone', () => {
  it('formats YYYY-MM-DD in the given timezone', () => {
    expect(dateKeyInTimeZone(NOW, 'America/Chicago')).toBe('2026-10-26');
  });
});

describe('buildWarehouseDayRows', () => {
  it('produces 15 rows per warehouse (offsets -7..+7), empty today shows zeros', () => {
    const rows = buildWarehouseDayRows([WAREHOUSE], [], [], NOW);
    expect(rows).toHaveLength(15);
    const today = rows.find((r) => r.offsetFromToday === 0)!;
    expect(today.date).toBe('2026-10-26');
    expect(today.usage.memberSlots).toEqual({ used: 0, capacity: 48, pctFull: 0, full: false });
    expect(today.usage.stagedOrders).toEqual({ used: 0, capacity: 15, pctFull: 0, full: false });
    expect(today.usage.largeOrders).toEqual({ used: 0, capacity: 2, pctFull: 0, full: false });
    expect(today.usage.inspections).toEqual({ used: 0, capacity: 10, pctFull: 0, full: false });
  });

  it('counts standard bookings toward BOTH member slots and staged orders, large_order separately', () => {
    const bookings: UsageSlotBooking[] = [
      { warehouseId: 'wh-1', bidderId: 'b1', slotStartsAt: '2026-10-26T15:00:00Z', kind: 'standard', status: 'booked' },
      { warehouseId: 'wh-1', bidderId: 'b2', slotStartsAt: '2026-10-26T16:00:00Z', kind: 'standard', status: 'booked' },
      { warehouseId: 'wh-1', bidderId: 'b3', slotStartsAt: '2026-10-26T16:30:00Z', kind: 'large_order', status: 'booked' },
      // canceled rows don't count
      { warehouseId: 'wh-1', bidderId: 'b4', slotStartsAt: '2026-10-26T17:00:00Z', kind: 'standard', status: 'canceled' },
      // a different warehouse doesn't bleed into this one's count
      { warehouseId: 'wh-2', bidderId: 'b5', slotStartsAt: '2026-10-26T17:00:00Z', kind: 'standard', status: 'booked' },
    ];
    const rows = buildWarehouseDayRows([WAREHOUSE], bookings, [], NOW);
    const today = rows.find((r) => r.offsetFromToday === 0)!;
    expect(today.usage.memberSlots.used).toBe(2);
    expect(today.usage.stagedOrders.used).toBe(2);
    expect(today.usage.largeOrders.used).toBe(1);
  });

  it('counts inspections requested for that exact warehouse-local date', () => {
    const inspections: UsageInspection[] = [
      { warehouseId: 'wh-1', bidderId: 'b1', requestedFor: '2026-10-26', status: 'requested' },
      { warehouseId: 'wh-1', bidderId: 'b2', requestedFor: '2026-10-26', status: 'canceled' }, // excluded
      { warehouseId: 'wh-1', bidderId: 'b3', requestedFor: '2026-10-27', status: 'requested' }, // different day
    ];
    const rows = buildWarehouseDayRows([WAREHOUSE], [], inspections, NOW);
    const today = rows.find((r) => r.offsetFromToday === 0)!;
    expect(today.usage.inspections.used).toBe(1);
  });

  it('zero slot capacity on a day with no configured pickup hours', () => {
    const rows = buildWarehouseDayRows([WAREHOUSE], [], [], NOW);
    const nextSunday = rows.find((r) => r.offsetFromToday === 6)!; // Mon+6 = Sunday
    expect(nextSunday.usage.memberSlots.capacity).toBe(0);
  });
});

describe('buildMembersAtLimit', () => {
  it('is empty with no rows ("No member bookings yet")', () => {
    expect(buildMembersAtLimit([], [], 4, 2, NOW)).toEqual([]);
  });

  it('flags a member who used up their monthly inspection allowance', () => {
    const inspections: UsageInspection[] = [
      { warehouseId: 'wh-1', bidderId: 'b1', requestedFor: '2026-10-01', status: 'done' },
      { warehouseId: 'wh-1', bidderId: 'b1', requestedFor: '2026-10-10', status: 'done' },
      { warehouseId: 'wh-1', bidderId: 'b1', requestedFor: '2026-10-15', status: 'scheduled' },
      { warehouseId: 'wh-1', bidderId: 'b1', requestedFor: '2026-10-20', status: 'requested' },
    ];
    const result = buildMembersAtLimit(inspections, [], 4, 2, NOW);
    expect(result).toEqual([{ bidderId: 'b1', reasons: ['inspections'] }]);
  });

  it('flags a member who holds the max active booked slots', () => {
    const bookings: UsageSlotBooking[] = [
      { warehouseId: 'wh-1', bidderId: 'b2', slotStartsAt: '2026-10-27T12:00:00Z', kind: 'standard', status: 'booked' },
      { warehouseId: 'wh-1', bidderId: 'b2', slotStartsAt: '2026-10-28T12:00:00Z', kind: 'standard', status: 'booked' },
    ];
    const result = buildMembersAtLimit([], bookings, 4, 2, NOW);
    expect(result).toEqual([{ bidderId: 'b2', reasons: ['active_slots'] }]);
  });

  it('does not flag a member under both limits', () => {
    const inspections: UsageInspection[] = [
      { warehouseId: 'wh-1', bidderId: 'b3', requestedFor: '2026-10-01', status: 'done' },
    ];
    const bookings: UsageSlotBooking[] = [
      { warehouseId: 'wh-1', bidderId: 'b3', slotStartsAt: '2026-10-27T12:00:00Z', kind: 'standard', status: 'booked' },
    ];
    expect(buildMembersAtLimit(inspections, bookings, 4, 2, NOW)).toEqual([]);
  });

  it('can flag both reasons at once for the same member', () => {
    const inspections: UsageInspection[] = Array.from({ length: 4 }, (_, i) => ({
      warehouseId: 'wh-1',
      bidderId: 'b4',
      requestedFor: `2026-10-0${i + 1}`,
      status: 'done',
    }));
    const bookings: UsageSlotBooking[] = [
      { warehouseId: 'wh-1', bidderId: 'b4', slotStartsAt: '2026-10-27T12:00:00Z', kind: 'standard', status: 'booked' },
      { warehouseId: 'wh-1', bidderId: 'b4', slotStartsAt: '2026-10-28T12:00:00Z', kind: 'large_order', status: 'booked' },
    ];
    const result = buildMembersAtLimit(inspections, bookings, 4, 2, NOW);
    expect(result).toEqual([{ bidderId: 'b4', reasons: ['inspections', 'active_slots'] }]);
  });
});
