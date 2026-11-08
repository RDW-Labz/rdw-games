// What to tell the operator, and what to record, when a lot fails to save.
//
// Until 2026-10-05 every create-lot failure other than "duplicate code" and
// "couldn't reserve a lot code" showed the same sentence ("Couldn't save the
// lot. Try again…") and the real Postgres message went nowhere. The floor
// reported one such failure at 10:01 CT that day and nobody could say whether
// it was a timeout, a constraint or the migration applied four minutes
// earlier. This module is pure (no React, no native) so it is unit-tested and
// shared by Quick Lot, Photo, Manual and Web lotting.

import type { CrashReportBody } from './telemetry-outbox';

export type LotCreateFailureCode = 'duplicate_external_code' | 'rpc_failed' | 'insert_failed';

export interface LotCreateFailure {
  code: LotCreateFailureCode;
  /** The raw reason from persistence.ts (`create_draft_lot: <pg message>`). */
  reason?: string | null;
}

/** The plain cause the operator sees. `unknown` still shows the server text. */
export type LotCreateCause =
  | 'duplicate_code'
  | 'no_lot_code'
  | 'server_slow'
  | 'duplicate_sticker'
  | 'no_sticker'
  | 'out_of_range'
  | 'not_signed_in'
  | 'unknown';

const SERVER_SLOW_RE =
  /statement timeout|canceling statement|57014|timed? ?out|network request failed|fetch failed|load failed|failed to fetch|aborted|ECONNRESET|socket hang up|50[234]\b|gateway/i;
const STICKER_RE = /sticker/i;
const DUPLICATE_RE = /duplicate key|already (bound|on|exists|used)|unique constraint|23505/i;
const NULL_RE = /null value|not-null|required|missing|23502/i;
const RANGE_RE = /out of (allowed )?range|too long|check constraint|23514|violates check/i;
const AUTH_RE = /not_authenticated|not authenticated|jwt|permission denied|row-level security|42501|28000/i;

/** Strip the module prefix persistence.ts adds, collapse whitespace, cap length. */
export function serverText(reason: string | null | undefined, max = 240): string {
  const raw = (reason ?? '').replace(/^create_draft_lot:\s*/i, '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

export function classifyLotCreateFailure(f: LotCreateFailure): LotCreateCause {
  const text = f.reason ?? '';
  if (f.code === 'duplicate_external_code') return 'duplicate_code';
  if (STICKER_RE.test(text) && DUPLICATE_RE.test(text)) return 'duplicate_sticker';
  if (STICKER_RE.test(text) && NULL_RE.test(text)) return 'no_sticker';
  if (SERVER_SLOW_RE.test(text)) return 'server_slow';
  if (f.code === 'rpc_failed') return AUTH_RE.test(text) ? 'not_signed_in' : 'no_lot_code';
  if (AUTH_RE.test(text)) return 'not_signed_in';
  if (RANGE_RE.test(text)) return 'out_of_range';
  return 'unknown';
}

const PLAIN: Record<LotCreateCause, string> = {
  duplicate_code:
    'This UPC is already on another lot in your inventory. Open Inventory to find it, or scan a different code.',
  no_lot_code: "Couldn't reserve a lot code. Check your connection and try again.",
  server_slow: 'Server slow, try again. Your photos and details are still here.',
  duplicate_sticker: 'Duplicate sticker. That sticker is already on another lot. Use a fresh one.',
  no_sticker: 'No sticker scanned. Scan the sticker on the box, then save.',
  out_of_range: 'A field is out of range. Check the title, MSRP and starting bid.',
  not_signed_in: 'Not signed in as staff. Sign out and back in, then try again.',
  unknown: "Couldn't save the lot. Try again — if it keeps failing, open the support tab.",
};

/** Title + body for the alert. The body always ends with what the server said. */
export function lotCreateUserMessage(f: LotCreateFailure): { title: string; message: string } {
  const cause = classifyLotCreateFailure(f);
  const server = serverText(f.reason);
  const message = server ? `${PLAIN[cause]}\n\nServer said: ${server}` : PLAIN[cause];
  return { title: 'Could not create lot', message };
}

export interface LotCreateFailureContext {
  /** Route of the screen that tried, e.g. '/lotting/quick'. */
  screen: string;
  lottingMode?: string | null;
  /** True when the save came from a manifest (Wayfair) match. */
  manifestMatch?: boolean;
  appVersion?: string;
  otaUpdate?: string;
}

/**
 * The row stored in client_crash_reports for every failed save. Counts and
 * identifiers only: the message carries the failure code, the plain cause,
 * the mode and the server's own text. No title, price or photo.
 */
export function lotCreateFailureReport(
  f: LotCreateFailure,
  ctx: LotCreateFailureContext,
): CrashReportBody {
  const cause = classifyLotCreateFailure(f);
  const head = `lot create failed [${f.code}/${cause}] mode=${ctx.lottingMode ?? '-'} manifest=${ctx.manifestMatch ? 'yes' : 'no'}: `;
  const message = `${head}${serverText(f.reason, Math.max(40, 500 - head.length))}`.slice(0, 500);
  return {
    message,
    screen: ctx.screen,
    is_fatal: false,
    ...(ctx.appVersion ? { app_version: ctx.appVersion } : {}),
    ...(ctx.otaUpdate ? { ota_update: ctx.otaUpdate } : {}),
  };
}
