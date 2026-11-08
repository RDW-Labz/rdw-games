// Shared date/time formatting that is timezone-aware.
//
// WHY THIS EXISTS (2026-05-27 fix):
// Timestamps are stored correctly as UTC `timestamptz`, but every absolute
// date/time LABEL was rendered with a bare `new Date(iso).toLocaleString()`
// (no `timeZone` option). On the Cloudflare-Worker / Node SSR runtime the
// process default zone is UTC, so an 8:00 PM Central close (= 01:00 UTC)
// printed as "1:00 AM". The correct zone is the auction's WAREHOUSE timezone
// (`warehouses.timezone`, an IANA string, NOT NULL). These helpers force the
// zone explicitly so the rendered label matches the warehouse's wall clock
// regardless of where the server runs.
//
// Mirrors the already-correct pattern in
// app/(operator)/warehouses/[id]/pickup-hours/page.tsx which uses
// `Intl.DateTimeFormat(.., { timeZone: wh.timezone, ... })`.

// US-only launch fallback. Callers should always pass the warehouse timezone
// (it is NOT NULL in the DB), so this only guards a null/undefined slipping
// through — it must never silently localize to the SSR runtime zone (UTC).
export const DEFAULT_TIME_ZONE = 'America/Chicago';

type DateInput = string | Date | null | undefined;

/**
 * Coerce a string | Date | null | undefined into a valid Date, or null.
 * Empty strings and unparseable values return null so callers can render a
 * placeholder instead of "Invalid Date".
 */
function toValidDate(value: DateInput): Date | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const DEFAULT_DATETIME_OPTS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  // Appends the zone abbreviation (e.g. "CDT") so the label is unambiguous.
  timeZoneName: 'short',
};

// Log the first Intl rejection per isolate only — enough to pinpoint the
// offending option in Sentry without spamming on every subsequent render.
let formatFailureLogged = false;

/**
 * Build an Intl formatter resiliently. The Cloudflare-Worker runtime has
 * thrown `TypeError: Invalid option : option` on a VALID IANA zone
 * (Sentry CLOVRBID-WEB-8) — i.e. it rejects an *option*, not the zone. A bare
 * `new Intl.DateTimeFormat(...)` in a server component bubbles that up as an
 * unhandled error and 500s the whole page. This degrades instead, trying in
 * order: full options → drop `timeZoneName` (the lone non-portable option) →
 * fall back to DEFAULT_TIME_ZONE → ISO label. It never throws.
 */
function safeFormat(
  date: Date,
  zone: string,
  opts: Intl.DateTimeFormatOptions,
): string {
  const optsNoZoneName: Intl.DateTimeFormatOptions = { ...opts };
  delete optsNoZoneName.timeZoneName;

  const attempts: Intl.DateTimeFormatOptions[] = [
    { ...opts, timeZone: zone },
    { ...optsNoZoneName, timeZone: zone },
    { ...optsNoZoneName, timeZone: DEFAULT_TIME_ZONE },
  ];

  for (const attempt of attempts) {
    try {
      return new Intl.DateTimeFormat('en-US', attempt).format(date);
    } catch (err) {
      if (!formatFailureLogged) {
        formatFailureLogged = true;
        const message = err instanceof Error ? err.message : String(err);
        // Surfaced to Sentry (Cloudflare captures console.warn) so the exact
        // rejected option is recorded the next time this fires.
        console.warn(
          `[datetime] Intl.DateTimeFormat rejected ${JSON.stringify(attempt)}: ${message}`,
        );
      }
    }
  }

  // Last resort — a render must never crash on a date label.
  const iso = date.toISOString();
  return opts.hour ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso.slice(0, 10);
}

/**
 * Format an absolute timestamp in a specific IANA timezone.
 *
 * @param value     ISO string, Date, or null/undefined.
 * @param timeZone  IANA zone (e.g. 'America/Chicago'). Falls back to
 *                  DEFAULT_TIME_ZONE only if null/undefined is passed.
 * @param opts      Optional Intl overrides merged over sensible defaults
 *                  (date + time + short zone name).
 * @returns         Localized string, or '—' for null/invalid input.
 */
export function formatInTimeZone(
  value: DateInput,
  timeZone: string | null | undefined,
  opts?: Intl.DateTimeFormatOptions,
): string {
  const date = toValidDate(value);
  if (!date) return '—';
  const zone = timeZone || DEFAULT_TIME_ZONE;
  return safeFormat(date, zone, { ...DEFAULT_DATETIME_OPTS, ...opts });
}

/**
 * Date-only variant (no clock time, no zone abbreviation). Useful for pickup
 * windows where the time-of-day is irrelevant. The zone still matters: a
 * timestamp near UTC midnight can land on a different calendar day depending
 * on the warehouse zone.
 */
export function formatDateInTimeZone(
  value: DateInput,
  timeZone: string | null | undefined,
  opts?: Intl.DateTimeFormatOptions,
): string {
  const date = toValidDate(value);
  if (!date) return '—';
  const zone = timeZone || DEFAULT_TIME_ZONE;
  return safeFormat(date, zone, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    ...opts,
  });
}

/**
 * Time-only variant (clock time + short zone name, no date). Pairs with
 * formatDateInTimeZone when a table splits date and time into separate
 * columns (e.g. the public lot bid-history table). Same zone-forcing as the
 * other helpers so a 6 PM Central bid never prints as UTC midnight.
 */
export function formatTimeInTimeZone(
  value: DateInput,
  timeZone: string | null | undefined,
  opts?: Intl.DateTimeFormatOptions,
): string {
  const date = toValidDate(value);
  if (!date) return '—';
  const zone = timeZone || DEFAULT_TIME_ZONE;
  return safeFormat(date, zone, {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...opts,
  });
}

/**
 * Read the IANA timezone from an embedded Supabase `warehouses(timezone)`
 * relation. supabase-js's generated types infer an embedded to-one relation
 * as an ARRAY (it can't always distinguish to-one from to-many), but at
 * runtime a single-row FK comes back as a lone object. Normalize both shapes
 * here so call sites don't each need an `as unknown as` cast.
 *
 * Returns null when the relation/timezone is absent; callers apply their own
 * DEFAULT_TIME_ZONE fallback.
 */
export function warehouseTimezone(rel: unknown): string | null {
  const node = Array.isArray(rel) ? rel[0] : rel;
  if (node && typeof node === 'object' && 'timezone' in node) {
    const tz = (node as { timezone?: unknown }).timezone;
    return typeof tz === 'string' && tz.length > 0 ? tz : null;
  }
  return null;
}

/**
 * The UTC instant at which a wall-clock midnight occurs in `timeZone`.
 * Two correction passes make it exact even when the naive UTC guess lands on
 * the other side of a DST transition (US transitions never fall on the 1st,
 * so in practice one pass converges).
 */
function zonedMidnightUtc(year: number, monthIndex0: number, timeZone: string): Date {
  let ts = Date.UTC(year, monthIndex0, 1);
  const desired = Date.UTC(year, monthIndex0, 1);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ts));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const wall = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24, // Intl emits "24" for midnight in some runtimes
      get('minute'),
      get('second'),
    );
    ts += desired - wall;
  }
  return new Date(ts);
}

/**
 * UTC ISO bounds of a calendar month as observed in `timeZone`.
 *
 * WHY (2026-07-05): the monthly P&L bucketed invoices by UTC month
 * boundaries, so a sale after ~6-7 PM Central on the last day of a month
 * was counted in the NEXT month's report. Same disease as the bare
 * toLocaleString timestamps — the store's books should follow the store's
 * wall clock.
 */
export function monthRangeInTimeZone(
  year: number,
  month: number, // 1-12
  timeZone: string | null | undefined,
): { startISO: string; endISO: string } {
  const zone = timeZone || DEFAULT_TIME_ZONE;
  const start = zonedMidnightUtc(year, month - 1, zone);
  const end =
    month === 12 ? zonedMidnightUtc(year + 1, 0, zone) : zonedMidnightUtc(year, month, zone);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

/** Generalization of zonedMidnightUtc to an arbitrary day-of-month. */
function zonedDayMidnightUtc(
  year: number,
  monthIndex0: number,
  day: number,
  timeZone: string,
): Date {
  let ts = Date.UTC(year, monthIndex0, day);
  const desired = Date.UTC(year, monthIndex0, day);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ts));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    ts += desired - wall;
  }
  return new Date(ts);
}

/**
 * UTC ISO bounds of an inclusive [fromYMD, toYMD] calendar-day range as
 * observed in `timeZone`. Both inputs are 'YYYY-MM-DD'. The end is the
 * midnight AFTER `toYMD` so the range is inclusive of the whole `to` day.
 * DST-correct (the end is computed from the next calendar day, not +24h).
 * Returns null on malformed input.
 */
export function dayRangeInTimeZone(
  fromYMD: string,
  toYMD: string,
  timeZone: string | null | undefined,
): { startISO: string; endISO: string } | null {
  const zone = timeZone || DEFAULT_TIME_ZONE;
  const mF = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fromYMD);
  const mT = /^(\d{4})-(\d{2})-(\d{2})$/.exec(toYMD);
  if (!mF || !mT) return null;
  const start = zonedDayMidnightUtc(Number(mF[1]), Number(mF[2]) - 1, Number(mF[3]), zone);
  // Day after `to` (calendar-safe rollover across month/year) → midnight in zone.
  const next = new Date(Date.UTC(Number(mT[1]), Number(mT[2]) - 1, Number(mT[3]) + 1));
  const end = zonedDayMidnightUtc(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate(), zone);
  if (end.getTime() <= start.getTime()) return null;
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

type WallTime = { y: number; mo: number; d: number; h: number; mi: number; s: number };

/** The wall-clock reading of an instant in `timeZone`. */
export function wallTimeInZone(instant: Date, timeZone: string): WallTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

/**
 * The UTC instant whose wall clock in `timeZone` reads `w`, using that zone's
 * offset ON THAT DATE (not today's). A wall time skipped by spring-forward
 * resolves to the instant just after the gap.
 */
export function zonedWallTimeToUtc(w: Omit<WallTime, 's'> & { s?: number }, timeZone: string): Date {
  const desired = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s ?? 0);
  let ts = desired;
  for (let i = 0; i < 3; i++) {
    const got = wallTimeInZone(new Date(ts), timeZone);
    const diff = desired - Date.UTC(got.y, got.mo - 1, got.d, got.h, got.mi, got.s);
    if (diff === 0) break;
    ts += diff;
  }
  return new Date(ts);
}

/**
 * Move an instant by a span of WALL-CLOCK time in `timeZone`: 10:30 AM plus
 * 2 days is 10:30 AM, even across a DST change. Adding raw milliseconds (or
 * `setDate` on a UTC server) keeps the UTC hour instead, which reads one hour
 * off after the change (the Nov 2026 cloned-pickup bug).
 */
export function addWallTime(
  instant: Date,
  span: { days?: number; hours?: number; minutes?: number },
  timeZone: string | null | undefined,
): Date {
  const zone = timeZone || DEFAULT_TIME_ZONE;
  const w = wallTimeInZone(instant, zone);
  const moved = new Date(
    Date.UTC(w.y, w.mo - 1, w.d + (span.days ?? 0), w.h + (span.hours ?? 0), w.mi + (span.minutes ?? 0), w.s),
  );
  return zonedWallTimeToUtc(
    {
      y: moved.getUTCFullYear(),
      mo: moved.getUTCMonth() + 1,
      d: moved.getUTCDate(),
      h: moved.getUTCHours(),
      mi: moved.getUTCMinutes(),
      s: moved.getUTCSeconds(),
    },
    zone,
  );
}

/** 'YYYY-MM-DD' of an instant as seen in `timeZone`. */
export function ymdInTimeZone(instant: Date, timeZone: string | null | undefined): string {
  const w = wallTimeInZone(instant, timeZone || DEFAULT_TIME_ZONE);
  return `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

/**
 * Curated list of US IANA timezones for warehouse pickers. Label is the
 * common name; value is the IANA identifier stored in warehouses.timezone.
 */
export const US_TIMEZONES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'America/New_York', label: 'Eastern (America/New_York)' },
  { value: 'America/Chicago', label: 'Central (America/Chicago)' },
  { value: 'America/Denver', label: 'Mountain (America/Denver)' },
  { value: 'America/Phoenix', label: 'Mountain — no DST (America/Phoenix)' },
  { value: 'America/Los_Angeles', label: 'Pacific (America/Los_Angeles)' },
  { value: 'America/Anchorage', label: 'Alaska (America/Anchorage)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (Pacific/Honolulu)' },
];
