import { describe, expect, it } from 'vitest';
import { computeAuctionTimes, shiftIsoByDays } from '../auction-times';
import { addWallTime, zonedWallTimeToUtc } from '../datetime';

const CT = 'America/Chicago';
const hm = (iso: string | Date) =>
  new Date(iso).toLocaleTimeString('en-US', { timeZone: CT, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });

// Machine-timezone independent: run with TZ=UTC and TZ=America/Chicago.
describe('clone shift keeps the warehouse wall clock (November fall-back)', () => {
  it('a clone made on a CDT day for pickup after Nov 1 keeps 10:30 / 18:00 CST', () => {
    // Source: pickup Tue 10-27 10:30 CDT – Fri 10-30 18:00 CDT. Clone +6 days.
    const start = shiftIsoByDays('2026-10-27T15:30:00.000Z', 6, CT)!;
    const end = shiftIsoByDays('2026-10-30T23:00:00.000Z', 6, CT)!;
    expect(start).toBe('2026-11-02T16:30:00.000Z'); // was 15:30Z (09:30 CST) before the fix
    expect(end).toBe('2026-11-06T00:00:00.000Z'); // was 23:00Z (17:00 CST)
    expect([hm(start), hm(end)]).toEqual(['10:30', '18:00']);
  });

  it('the boundary day itself (Sun 11-01)', () => {
    expect(shiftIsoByDays('2026-10-31T15:30:00.000Z', 1, CT)).toBe('2026-11-01T16:30:00.000Z');
    expect(shiftIsoByDays('2026-10-31T23:00:00.000Z', 1, CT)).toBe('2026-11-02T00:00:00.000Z');
  });
});

describe('clone shift keeps the warehouse wall clock (March spring-forward)', () => {
  it('a clone made on a CST day for pickup after Mar 14 2027 keeps 10:30 / 18:00 CDT', () => {
    const start = shiftIsoByDays('2027-03-09T16:30:00.000Z', 6, CT)!; // Tue 3-09 10:30 CST
    const end = shiftIsoByDays('2027-03-13T00:00:00.000Z', 6, CT)!; // Fri 3-12 18:00 CST
    expect(start).toBe('2027-03-15T15:30:00.000Z');
    expect(end).toBe('2027-03-18T23:00:00.000Z');
    expect([hm(start), hm(end)]).toEqual(['10:30', '18:00']);
  });

  it('the boundary day itself (Sun 3-14)', () => {
    expect(shiftIsoByDays('2027-03-13T16:30:00.000Z', 1, CT)).toBe('2027-03-14T15:30:00.000Z');
    expect(shiftIsoByDays('2027-03-14T00:00:00.000Z', 1, CT)).toBe('2027-03-14T23:00:00.000Z');
  });
});

describe('auto-build schedule in wall-clock hours', () => {
  it('November: auction #3 starting after Nov 1 still opens 7 AM and closes 7 PM local', () => {
    const t = computeAuctionTimes(new Date('2026-10-29T12:00:00Z'), 60, 24, 16, 120, 3, CT);
    expect(t.startsAt.toISOString()).toBe('2026-11-01T13:00:00.000Z'); // Sun 07:00 CST
    expect(t.endsAt.toISOString()).toBe('2026-11-04T01:00:00.000Z'); // Tue 19:00 CST
    expect(hm(t.pickupStartsAt)).toBe('11:00');
    expect(hm(t.pickupEndsAt)).toBe('11:00');
  });

  it('March: auction #2 starting on Mar 14 still opens 7 AM and closes 7 PM local', () => {
    const t = computeAuctionTimes(new Date('2027-03-12T13:00:00Z'), 60, 24, 16, 120, 2, CT);
    expect(t.startsAt.toISOString()).toBe('2027-03-14T12:00:00.000Z'); // Sun 07:00 CDT
    expect(t.endsAt.toISOString()).toBe('2027-03-17T00:00:00.000Z'); // Tue 19:00 CDT
    expect([hm(t.pickupStartsAt), hm(t.pickupEndsAt)]).toEqual(['11:00', '11:00']);
  });
});

describe('wall-time edge cases', () => {
  it('a wall time skipped by spring-forward lands just after the gap', () => {
    expect(zonedWallTimeToUtc({ y: 2027, mo: 3, d: 14, h: 2, mi: 30 }, CT).toISOString()).toBe('2027-03-14T08:30:00.000Z');
  });
  it('a repeated fall-back wall time resolves to the first occurrence', () => {
    expect(zonedWallTimeToUtc({ y: 2026, mo: 11, d: 1, h: 1, mi: 30 }, CT).toISOString()).toBe('2026-11-01T06:30:00.000Z');
  });
  it('defaults to America/Chicago when the warehouse zone is missing', () => {
    expect(addWallTime(new Date('2026-10-31T15:30:00Z'), { days: 2 }, null).toISOString()).toBe('2026-11-02T16:30:00.000Z');
  });
  it('null timestamps stay null', () => {
    expect(shiftIsoByDays(null, 3, CT)).toBeNull();
  });
});
