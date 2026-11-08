// Member Pro usage view — pure aggregation. Mig 0457 added member_slot_bookings
// + member_inspections as MINIMAL tables (PRs 7/8 write the actual rows); this
// view reads them read-only, today showing zeros ("No member bookings yet")
// since nothing writes to them in this PR.
//
// Row-count modeling (documented here since it is not obvious from the schema
// alone): a "standard" kind booking IS the thing that both occupies a member
// pickup time-slot AND represents a staged order -- there is no separate
// "staged order" table in this PR, so the per-day "staged orders" count and
// the per-day "member slots booked" count both come from counting the SAME
// standard-kind bookings, just checked against two different capacities
// (overall time-slot capacity vs. the operator's staged-orders-per-day cap).
// A "large_order" kind booking is tracked SEPARATELY against
// large_orders_per_day, per the owner's "booked as a separate large order
// slot" instruction -- it does not also count against the standard capacity.
//
// Testable in isolation (apps/operator-web/src/app/(operator)/settings/
// member-pro/usage/__tests__/aggregate.test.ts) without a database, mirroring
// the loadMissingReport() pattern used by reports/missing.

import {
  summarizeWarehouseDay,
  memberSlotCapacityForDay,
  weekdayKeyInTimeZone,
  inspectionsUsedThisMonth,
  inspectionLimitReached,
  activeBookedSlotCount,
  activeSlotLimitReached,
  type PickupHours,
  type WarehouseDayUsage,
} from '@auction-platform/shared';

export type UsageWarehouse = {
  id: string;
  name: string;
  timezone: string;
  pickupHours: PickupHours;
  stagedOrdersPerDay: number;
  inspectionsPerDay: number;
  slotMinutes: number;
  membersPerSlot: number;
  largeOrdersPerDay: number;
};

export type UsageSlotBooking = {
  warehouseId: string;
  bidderId: string;
  slotStartsAt: string; // ISO instant
  kind: 'standard' | 'large_order';
  status: string;
};

export type UsageInspection = {
  warehouseId: string;
  bidderId: string;
  requestedFor: string; // DATE, 'YYYY-MM-DD', already the warehouse-local calendar day
  status: string;
};

export type WarehouseDayRow = {
  warehouseId: string;
  warehouseName: string;
  date: string; // YYYY-MM-DD in the warehouse's own timezone
  offsetFromToday: number; // negative = past, 0 = today, positive = future
  usage: WarehouseDayUsage;
};

export type MemberLimitReason = 'inspections' | 'active_slots';

export type MemberAtLimit = {
  bidderId: string;
  reasons: MemberLimitReason[];
};

/** "YYYY-MM-DD" for `date` in `timeZone` -- the view's per-warehouse calendar day. */
export function dateKeyInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
}

function shiftByDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Per warehouse, per day for the last 7 days + today + the next 6 days (15
 * days, offsets -7..+7) -- "last 7 days" and "next 7 days" per the owner's
 * spec, with today counted once (in the "next 7" half, offset 0).
 */
export function buildWarehouseDayRows(
  warehouses: UsageWarehouse[],
  bookings: UsageSlotBooking[],
  inspections: UsageInspection[],
  now: Date,
): WarehouseDayRow[] {
  const rows: WarehouseDayRow[] = [];
  for (const wh of warehouses) {
    for (let offset = -7; offset <= 7; offset++) {
      const shifted = shiftByDays(now, offset);
      const date = dateKeyInTimeZone(shifted, wh.timezone);
      const weekday = weekdayKeyInTimeZone(shifted, wh.timezone);

      let standardCount = 0;
      let largeOrderCount = 0;
      for (const b of bookings) {
        if (b.warehouseId !== wh.id || b.status === 'canceled') continue;
        if (dateKeyInTimeZone(new Date(b.slotStartsAt), wh.timezone) !== date) continue;
        if (b.kind === 'large_order') largeOrderCount++;
        else standardCount++;
      }

      let inspectionCount = 0;
      for (const i of inspections) {
        if (i.warehouseId !== wh.id || i.status === 'canceled') continue;
        if (i.requestedFor !== date) continue;
        inspectionCount++;
      }

      const memberSlotCapacity = memberSlotCapacityForDay(wh.pickupHours, weekday, wh.slotMinutes, wh.membersPerSlot);

      rows.push({
        warehouseId: wh.id,
        warehouseName: wh.name,
        date,
        offsetFromToday: offset,
        usage: summarizeWarehouseDay({
          memberSlotsBooked: standardCount,
          memberSlotCapacity,
          largeOrderSlotsUsed: largeOrderCount,
          largeOrdersPerDay: wh.largeOrdersPerDay,
          stagedOrders: standardCount,
          stagedOrdersPerDay: wh.stagedOrdersPerDay,
          inspections: inspectionCount,
          inspectionsPerDay: wh.inspectionsPerDay,
        }),
      });
    }
  }
  return rows;
}

/**
 * Members who have hit a limit: monthly inspections used = the plan's
 * allowance, or active (future, 'booked') slots = the plan's max. Pass the
 * FULL set of each member's rows (not just the 15-day window above) -- an
 * inspection earlier in the month, or a slot booked further out than the
 * display window, still counts against the limit.
 */
export function buildMembersAtLimit(
  inspections: UsageInspection[],
  bookings: UsageSlotBooking[],
  inspectionsPerMemberMonth: number,
  maxActiveSlotsPerMember: number,
  now: Date,
): MemberAtLimit[] {
  const inspectionsByBidder = new Map<string, UsageInspection[]>();
  for (const i of inspections) {
    const list = inspectionsByBidder.get(i.bidderId) ?? [];
    list.push(i);
    inspectionsByBidder.set(i.bidderId, list);
  }
  const bookingsByBidder = new Map<string, UsageSlotBooking[]>();
  for (const b of bookings) {
    const list = bookingsByBidder.get(b.bidderId) ?? [];
    list.push(b);
    bookingsByBidder.set(b.bidderId, list);
  }

  const bidderIds = new Set<string>([...inspectionsByBidder.keys(), ...bookingsByBidder.keys()]);
  const result: MemberAtLimit[] = [];
  for (const bidderId of bidderIds) {
    const reasons: MemberLimitReason[] = [];

    const usedThisMonth = inspectionsUsedThisMonth(inspectionsByBidder.get(bidderId) ?? [], now);
    if (inspectionLimitReached(usedThisMonth, inspectionsPerMemberMonth)) reasons.push('inspections');

    const activeCount = activeBookedSlotCount(bookingsByBidder.get(bidderId) ?? [], now);
    if (activeSlotLimitReached(activeCount, maxActiveSlotsPerMember)) reasons.push('active_slots');

    if (reasons.length > 0) result.push({ bidderId, reasons });
  }
  return result;
}
