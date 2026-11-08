// Resend quota saver (2026-10-23). Resend stops ALL email for the rest of the
// monthly cycle once the quota is spent: on 2026-10-01 11:33 CT it began
// refusing ("You have reached your monthly email sending quota") until the
// cycle reset on 10-04 17:38, and 7,388 emails failed, including 855 win
// notices, 376 payment receipts and 431 pickup confirmations.
//
// Once this cycle's sends pass SAVER_PCT of the cap, the email drain sends
// only ESSENTIAL kinds (win, payment, pickup). Everything else is skipped,
// not deferred: an outbid or saved-search email delivered after the reset is
// stale. Push notifications are a separate drain and are not affected.
// Login / password emails go through Supabase Auth's SMTP, not this drain; the
// budget this saves is also what keeps those working.
//
// Pure module; the drain does the one count query.

/** Sent last cycle before Resend refused (10-01 11:33 CT), our own records. */
export const DEFAULT_MONTHLY_CAP = 60_800;
/** Resend's cycle resets on the 4th (observed 10-04 17:38 CT = 22:38 UTC). */
export const DEFAULT_CYCLE_DAY = 4;
export const DEFAULT_CYCLE_HOUR_UTC = 22;
export const DEFAULT_SAVER_PCT = 0.9;

/** Win, payment and pickup emails. Everything else waits for the next cycle. */
export const ESSENTIAL_EMAIL_KINDS: ReadonlySet<string> = new Set([
  'won',
  'payment_succeeded',
  'payment_failed',
  'pickup_confirmed',
  'pickup_reminder',
  'pickup_no_show_forfeit',
  'relot_fee_applied',
]);

export const SAVER_SKIP_REASON = 'quota_saver';

export function isEssentialEmailKind(kind: string): boolean {
  return ESSENTIAL_EMAIL_KINDS.has(kind);
}

function intEnv(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

export function quotaConfig(env: Record<string, string | undefined>): {
  cap: number;
  cycleDay: number;
  cycleHourUtc: number;
  saverPct: number;
} {
  const pct = Number(env['RESEND_SAVER_PCT']);
  return {
    cap: intEnv(env['RESEND_MONTHLY_CAP'], DEFAULT_MONTHLY_CAP, 1, 10_000_000),
    cycleDay: intEnv(env['RESEND_CYCLE_DAY'], DEFAULT_CYCLE_DAY, 1, 28),
    cycleHourUtc: intEnv(env['RESEND_CYCLE_HOUR_UTC'], DEFAULT_CYCLE_HOUR_UTC, 0, 23),
    saverPct: Number.isFinite(pct) && pct > 0 && pct <= 1 ? pct : DEFAULT_SAVER_PCT,
  };
}

/** Start of the Resend cycle that contains `now`. */
export function cycleStart(now: Date, cycleDay = DEFAULT_CYCLE_DAY, cycleHourUtc = DEFAULT_CYCLE_HOUR_UTC): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const thisMonth = new Date(Date.UTC(y, m, cycleDay, cycleHourUtc));
  return now >= thisMonth ? thisMonth : new Date(Date.UTC(y, m - 1, cycleDay, cycleHourUtc));
}

/** True when only essential email should go out. */
export function saverOn(sentThisCycle: number, cap: number, saverPct = DEFAULT_SAVER_PCT): boolean {
  return sentThisCycle >= Math.floor(cap * saverPct);
}
