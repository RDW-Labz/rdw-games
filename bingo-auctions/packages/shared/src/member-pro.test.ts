import { describe, it, expect } from 'vitest';
import {
  priceForNewSignup,
  priceForRenewal,
  decideSignup,
  classifyPickupOrder,
  effectivePickupAllowance,
  percentFull,
  isFull,
  summarizeWarehouseDay,
  slotsAvailableForDay,
  memberSlotCapacityForDay,
  weekdayKeyInTimeZone,
  inspectionsUsedThisMonth,
  inspectionLimitReached,
  activeBookedSlotCount,
  activeSlotLimitReached,
} from './member-pro';

const PLAN = {
  priceCents: 10000,
  introPriceCents: 5000,
  introSeats: 30,
  introMonths: 6,
  memberCap: 30,
};

describe('priceForNewSignup', () => {
  it('applies the intro price while seats remain', () => {
    expect(priceForNewSignup(PLAN, 0)).toEqual({ priceCents: 5000, introApplied: true });
    expect(priceForNewSignup(PLAN, 29)).toEqual({ priceCents: 5000, introApplied: true });
  });

  it('charges the regular price once intro seats are used up', () => {
    expect(priceForNewSignup(PLAN, 30)).toEqual({ priceCents: 10000, introApplied: false });
    expect(priceForNewSignup(PLAN, 31)).toEqual({ priceCents: 10000, introApplied: false });
  });

  it('never applies intro pricing when introSeats is 0', () => {
    expect(priceForNewSignup({ ...PLAN, introSeats: 0 }, 0)).toEqual({
      priceCents: 10000,
      introApplied: false,
    });
  });
});

describe('priceForRenewal', () => {
  it('keeps the intro price inside the intro window', () => {
    expect(priceForRenewal(PLAN, true, 0, 6)).toBe(5000);
    expect(priceForRenewal(PLAN, true, 5, 6)).toBe(5000);
  });

  it('rolls to the regular price once the intro window elapses', () => {
    expect(priceForRenewal(PLAN, true, 6, 6)).toBe(10000);
    expect(priceForRenewal(PLAN, true, 12, 6)).toBe(10000);
  });

  it('a member who never got the intro price always renews at regular price', () => {
    expect(priceForRenewal(PLAN, false, 0, 6)).toBe(10000);
  });
});

describe('decideSignup', () => {
  it('enrolls at the intro price while under cap and intro seats remain', () => {
    expect(decideSignup(PLAN, 0)).toEqual({ kind: 'enrolled', priceCents: 5000, introApplied: true });
  });

  it('enrolls at the regular price when under cap but intro seats are gone', () => {
    // PLAN's cap is also 30, so 30 existing members would ALSO hit the cap --
    // use a higher cap here to isolate "intro gone, but room remains" from
    // "cap reached" (covered separately below).
    expect(decideSignup({ ...PLAN, memberCap: 50 }, 30)).toEqual({
      kind: 'enrolled',
      priceCents: 10000,
      introApplied: false,
    });
  });

  it('waitlists with no charge once member_cap is reached, even if intro-eligible', () => {
    expect(decideSignup(PLAN, 30)).toEqual({ kind: 'waitlisted' });
    expect(decideSignup({ ...PLAN, introSeats: 50 }, 30)).toEqual({ kind: 'waitlisted' });
  });

  it('waitlists past cap too', () => {
    expect(decideSignup(PLAN, 31)).toEqual({ kind: 'waitlisted' });
  });
});

describe('classifyPickupOrder', () => {
  const ALLOWANCE = { qty: 10, unit: 'items' as const };

  it('classifies at or under the allowance as standard', () => {
    expect(classifyPickupOrder(10, ALLOWANCE)).toBe('standard');
    expect(classifyPickupOrder(1, ALLOWANCE)).toBe('standard');
  });

  it('classifies over the allowance as a large order', () => {
    expect(classifyPickupOrder(11, ALLOWANCE)).toBe('large_order');
  });
});

describe('effectivePickupAllowance', () => {
  const OPERATOR_DEFAULT = { qty: 10, unit: 'items' as const };

  it('falls back to the operator default when no override is set', () => {
    expect(effectivePickupAllowance(OPERATOR_DEFAULT, null)).toEqual(OPERATOR_DEFAULT);
    expect(effectivePickupAllowance(OPERATOR_DEFAULT, { qty: null as unknown as number, unit: null as unknown as 'items' })).toEqual(
      OPERATOR_DEFAULT,
    );
  });

  it('uses the warehouse override when both qty and unit are set', () => {
    expect(effectivePickupAllowance(OPERATOR_DEFAULT, { qty: 3, unit: 'pallets' })).toEqual({
      qty: 3,
      unit: 'pallets',
    });
  });
});

describe('percentFull / isFull', () => {
  it('rounds and caps at 100', () => {
    expect(percentFull(5, 10)).toBe(50);
    expect(percentFull(10, 10)).toBe(100);
    expect(percentFull(12, 10)).toBe(100);
    expect(percentFull(1, 3)).toBe(33);
  });

  it('treats a 0-capacity day with usage as 100% full, no usage as 0%', () => {
    expect(percentFull(0, 0)).toBe(0);
    expect(percentFull(2, 0)).toBe(100);
  });

  it('isFull matches used >= capacity, and 0-capacity+usage is full', () => {
    expect(isFull(9, 10)).toBe(false);
    expect(isFull(10, 10)).toBe(true);
    expect(isFull(0, 0)).toBe(false);
    expect(isFull(1, 0)).toBe(true);
  });
});

describe('summarizeWarehouseDay', () => {
  it('computes all four rows consistently with percentFull/isFull', () => {
    const summary = summarizeWarehouseDay({
      memberSlotsBooked: 9,
      memberSlotCapacity: 9,
      largeOrderSlotsUsed: 1,
      largeOrdersPerDay: 2,
      stagedOrders: 0,
      stagedOrdersPerDay: 15,
      inspections: 10,
      inspectionsPerDay: 10,
    });
    expect(summary.memberSlots).toEqual({ used: 9, capacity: 9, pctFull: 100, full: true });
    expect(summary.largeOrders).toEqual({ used: 1, capacity: 2, pctFull: 50, full: false });
    expect(summary.stagedOrders).toEqual({ used: 0, capacity: 15, pctFull: 0, full: false });
    expect(summary.inspections).toEqual({ used: 10, capacity: 10, pctFull: 100, full: true });
  });
});

describe('slotsAvailableForDay / memberSlotCapacityForDay', () => {
  const HOURS = { mon: [{ open: '10:00', close: '18:00' }], sun: [] };

  it('divides the day\'s open minutes by slot length, floored', () => {
    // 8 hours = 480 minutes / 30-minute slots = 16 slots
    expect(slotsAvailableForDay(HOURS, 'mon', 30)).toBe(16);
    // 480 / 200 = 2.4 -> floors to 2
    expect(slotsAvailableForDay(HOURS, 'mon', 200)).toBe(2);
  });

  it('is 0 for a day with no configured hours', () => {
    expect(slotsAvailableForDay(HOURS, 'sun', 30)).toBe(0);
    expect(slotsAvailableForDay(HOURS, 'tue', 30)).toBe(0);
  });

  it('is 0 for a non-positive slot length (no divide-by-zero)', () => {
    expect(slotsAvailableForDay(HOURS, 'mon', 0)).toBe(0);
  });

  it('multiplies slots available by membersPerSlot for capacity', () => {
    expect(memberSlotCapacityForDay(HOURS, 'mon', 30, 3)).toBe(48);
    expect(memberSlotCapacityForDay(HOURS, 'sun', 30, 3)).toBe(0);
  });
});

describe('weekdayKeyInTimeZone', () => {
  it('resolves the weekday in the given timezone, not the server default', () => {
    // 2026-10-26 is a Monday (UTC); pick a time safely inside Monday in both
    // America/Chicago and UTC to avoid a cross-midnight flake.
    const date = new Date('2026-10-26T18:00:00Z');
    expect(weekdayKeyInTimeZone(date, 'America/Chicago')).toBe('mon');
    expect(weekdayKeyInTimeZone(date, 'UTC')).toBe('mon');
  });
});

describe('inspectionsUsedThisMonth / inspectionLimitReached', () => {
  const now = new Date('2026-10-26T12:00:00Z');

  it('counts non-canceled inspections requested in the current calendar month', () => {
    const inspections = [
      { requestedFor: '2026-10-01', status: 'done' },
      { requestedFor: '2026-10-26', status: 'scheduled' },
      { requestedFor: '2026-10-15', status: 'canceled' },
      { requestedFor: '2026-09-30', status: 'done' },
    ];
    expect(inspectionsUsedThisMonth(inspections, now)).toBe(2);
  });

  it('is 0 when there are no inspections this month', () => {
    expect(inspectionsUsedThisMonth([{ requestedFor: '2026-09-01', status: 'done' }], now)).toBe(0);
  });

  it('limit reached once used meets the allowance', () => {
    expect(inspectionLimitReached(4, 4)).toBe(true);
    expect(inspectionLimitReached(3, 4)).toBe(false);
  });
});

describe('activeBookedSlotCount / activeSlotLimitReached', () => {
  const now = new Date('2026-10-26T12:00:00Z');

  it('counts only future booked rows', () => {
    const bookings = [
      { slotStartsAt: '2026-10-27T12:00:00Z', status: 'booked' },
      { slotStartsAt: '2026-10-28T12:00:00Z', status: 'booked' },
      { slotStartsAt: '2026-10-29T12:00:00Z', status: 'canceled' },
      { slotStartsAt: '2026-10-20T12:00:00Z', status: 'booked' }, // past
    ];
    expect(activeBookedSlotCount(bookings, now)).toBe(2);
  });

  it('is 0 with no bookings', () => {
    expect(activeBookedSlotCount([], now)).toBe(0);
  });

  it('limit reached once active count meets max', () => {
    expect(activeSlotLimitReached(2, 2)).toBe(true);
    expect(activeSlotLimitReached(1, 2)).toBe(false);
  });
});
