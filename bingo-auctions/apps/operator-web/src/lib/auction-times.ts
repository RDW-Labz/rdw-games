// Auction time math on the WAREHOUSE wall clock (DST-correct).
//
// 2026-10-30 incident: Clone shifted every time by N days with setDate() on
// the UTC server, so a clone kept the source's UTC hour. Clones made before
// DST ended (Nov 1) for pickup dates after it stored 15:30/23:00 UTC = 09:30 /
// 5:00 PM CST instead of 10:30 AM / 6:00 PM, and the no-show sweep (0 h grace)
// would have forfeited an hour early. Auto-build added raw hours the same way.
// Every shift here is done in wall-clock time in the warehouse's zone.

import { addWallTime } from './datetime';

/** Shift an ISO instant by whole days, keeping its wall-clock time in `timeZone`. */
export function shiftIsoByDays(
  iso: string | null,
  days: number,
  timeZone: string | null | undefined,
): string | null {
  if (!iso) return null;
  return addWallTime(new Date(iso), { days }, timeZone).toISOString();
}

/**
 * Auto-build schedule for auction `index`, in wall-clock hours: an auction
 * that starts at 7:00 AM and cooks 60 h closes at 7:00 PM local, whatever the
 * DST state on either day.
 */
export function computeAuctionTimes(
  firstStartsAt: Date,
  cookHours: number,
  gapHours: number,
  pickupOffsetHours: number,
  pickupDurationHours: number,
  index: number,
  timeZone: string | null | undefined,
): { startsAt: Date; endsAt: Date; pickupStartsAt: Date; pickupEndsAt: Date } {
  const startsAt = addWallTime(firstStartsAt, { hours: index * gapHours }, timeZone);
  const endsAt = addWallTime(startsAt, { hours: cookHours }, timeZone);
  const pickupStartsAt = addWallTime(endsAt, { hours: pickupOffsetHours }, timeZone);
  const pickupEndsAt = addWallTime(pickupStartsAt, { hours: pickupDurationHours }, timeZone);
  return { startsAt, endsAt, pickupStartsAt, pickupEndsAt };
}
