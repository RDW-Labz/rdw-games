// A picked load lasts one working day (#533, owner decision 2026-10-20).
//
// The lotting session lives in AsyncStorage, so a load picked weeks ago used
// to keep tagging new lots (lots.load_id, mig 0428) without anyone seeing it.
// Now a pick expires at 04:00 America/Chicago: the first launch after that
// clears it and asks staff to pick again before lotting.
//
// Pure (no Intl, no React) so it runs the same on Hermes and in vitest. The
// US DST rule is applied by hand: CDT from the 2nd Sunday of March to the
// 1st Sunday of November. Both switches happen at 02:00 local, before 04:00,
// so the 04:00 boundary always uses that day's offset.

const RESET_HOUR_LOCAL = 4;

/** Day of month of the nth Sunday (1-based) of a UTC month. */
function nthSunday(year: number, month: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}

/** True when the Chicago calendar date (y, m, d) is on daylight time at 04:00. */
function isChicagoDst(year: number, month: number, day: number): boolean {
  if (month < 2 || month > 10) return false;
  if (month > 2 && month < 10) return true;
  if (month === 2) return day >= nthSunday(year, 2, 2);
  return day < nthSunday(year, 10, 1);
}

/** 04:00 Chicago on the Chicago calendar date (y, m, d), as epoch ms. */
function resetAt(year: number, month: number, day: number): number {
  const offsetHours = isChicagoDst(year, month, day) ? 5 : 6;
  return Date.UTC(year, month, day, RESET_HOUR_LOCAL + offsetHours);
}

/** The most recent 04:00 America/Chicago at or before `now`. */
export function lastLoadResetAt(now: Date): Date {
  const t = now.getTime();
  // The Chicago date is the UTC date or the one before it; try both, newest first.
  for (let back = 0; back <= 2; back++) {
    const d = new Date(t - back * 86_400_000);
    const at = resetAt(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    if (at <= t) return new Date(at);
  }
  // Unreachable: one of the three candidates is always in the past.
  return new Date(t);
}

/**
 * Should this saved pick be dropped? A load with no pick time (saved before
 * this rule existed) or an unreadable one counts as expired: it is exactly the
 * silent old pick this rule exists to stop.
 */
export function isLoadPickExpired(
  pick: { defaultLoadId: string | null; loadSetAt?: string | null },
  now: Date = new Date(),
): boolean {
  if (!pick.defaultLoadId) return false;
  if (!pick.loadSetAt) return true;
  const set = new Date(pick.loadSetAt).getTime();
  if (Number.isNaN(set)) return true;
  return set < lastLoadResetAt(now).getTime();
}
