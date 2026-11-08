// Pure helpers for /lots/lookup (#773, follow-ups in #775).
//
// Staff used to be able to paste only a lot / sticker / QR code into the lookup
// box. A product title — "VEVOR Ice-making Machine LB-Series" — returned
// "No lot found" even though the lot existed. The page now keeps the exact code
// resolver first (a code match always wins) and falls back to a case-insensitive
// title search.
//
// The pattern builder is deliberately separate from the page. `%` and `_` are
// ILIKE wildcards in the VALUE position, so they are escaped; otherwise typing
// `%` would match every lot. PostgREST structural characters (`,` `(` `)` `|`)
// are replaced with a one-character wildcard instead of being dropped: a pasted
// punctuated title such as "VEVOR Ice-maker (LB-Series)" must still match its
// own row, but the structural characters themselves can never reach the filter.

import { sanitizePostgrestPattern } from '@/lib/postgrest-filter';

export const LOT_LOOKUP_LIMIT = 25;
export const LOT_LOOKUP_MAX_INPUT = 100;

export const LOOKUP_MESSAGES = {
  code: 'Could not look up that code right now. Try again.',
  session: 'Your session could not be verified. Sign in again and retry.',
  operator: 'This account is not linked to an operator. Ask an admin for help.',
  operatorLookup: 'Could not resolve your operator right now. Try again.',
  title: 'Could not search lot titles right now. Try again.',
} as const;

/** Trimmed, length-capped lookup text. Accepts Next's string | string[] params. */
export function parseLotLookupInput(raw?: string | string[]): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? '').trim().slice(0, LOT_LOOKUP_MAX_INPUT);
}

// Build the candidate list the code resolver ladder will try. Sticker codes are
// stored uppercase and colon-namespaced by operator; typed entry is forgiving
// of case and stray spaces, so we offer a few normalized variants and let the
// RPC pick the first that matches.
export function candidatesFor(raw: string): string[] {
  const trimmed = raw.trim();
  const noSpace = trimmed.replace(/\s+/g, '');
  return Array.from(
    new Set([trimmed, trimmed.toUpperCase(), noSpace, noSpace.toUpperCase()].filter(Boolean)),
  );
}

/** What the exact-code resolver said, reduced to the branches the page acts on. */
export type CodeLookupResolution =
  | { kind: 'lot'; lotId: string }
  | { kind: 'miss' }
  | { kind: 'error'; message: string };

/**
 * `staff_scan_lot_owner` returns
 * `{ok:true, lot:{id}}` or `{ok:false, reason:'lot_not_found'|'not_authenticated'|
 * 'not_operator_staff'}`. Only `lot_not_found` is an authoritative miss; every
 * other shape is an error, so the page never reports "no code match" when the
 * resolver never actually answered.
 */
export function classifyCodeLookup(result: unknown): CodeLookupResolution {
  const res = result as { ok?: unknown; reason?: unknown; lot?: { id?: unknown } | null } | null;

  if (res && res.ok === true) {
    const lotId = res.lot?.id;
    return typeof lotId === 'string' && lotId.length > 0
      ? { kind: 'lot', lotId }
      : { kind: 'error', message: LOOKUP_MESSAGES.code };
  }

  if (res && res.ok === false) {
    if (res.reason === 'lot_not_found') return { kind: 'miss' };
    if (res.reason === 'not_authenticated') {
      return { kind: 'error', message: LOOKUP_MESSAGES.session };
    }
    if (res.reason === 'not_operator_staff') {
      return { kind: 'error', message: LOOKUP_MESSAGES.operator };
    }
  }

  return { kind: 'error', message: LOOKUP_MESSAGES.code };
}

/** The signed-in user needed to scope the title query, or the error to show. */
export type TitleSearchAuth =
  | { kind: 'ready'; userId: string }
  | { kind: 'error'; message: string };

/**
 * A failed or expired `getUser()` must not read as "no lot found". A healthy
 * null user is still an authentication state, not an empty result.
 */
export function classifyTitleSearchAuth(
  user: { id?: string | null } | null | undefined,
  error: unknown,
): TitleSearchAuth {
  if (error || !user?.id) {
    return { kind: 'error', message: LOOKUP_MESSAGES.session };
  }
  return { kind: 'ready', userId: user.id };
}

/** The PostgREST operator and value to filter `title` with. */
export type LotTitleQuery = { operator: 'ilike' | 'imatch'; pattern: string };

const STRUCTURAL_MARK = '\u0000';

/**
 * Reduce free text to a value that cannot add PostgREST filter structure.
 * Structural runs become a marker (a title's own punctuation should still
 * match it); leading/trailing runs are dropped. Returns null when there is
 * nothing textual to search for.
 */
function safeTitleText(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const marked = trimmed.replace(/[,()|]+/g, STRUCTURAL_MARK).replace(/^\u0000+|\u0000+$/g, '');
  const safe = sanitizePostgrestPattern(marked);
  if (/[,()|]/.test(safe)) return null;

  // Nothing textual left (e.g. "()", "---", "..."): do not broaden to everything.
  if (!/[\p{L}\p{N}]/u.test(safe)) return null;
  return safe;
}

function ilikeTitlePattern(safe: string): string {
  const escaped = safe
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .split(STRUCTURAL_MARK)
    .join('%');
  return `%${escaped}%`;
}

const REGEX_META = /[\\^$.*+?()[\]{}|]/g;

/**
 * `imatch` is a case-insensitive Postgres regex. Unlike ILIKE it has no
 * `*` → `%` alias, so a literal asterisk can match its own title. Everything
 * else is escaped as a regex literal, including `%`, `_` and `\`, while the
 * title's structural punctuation still acts as a wildcard (as with ILIKE).
 */
function imatchTitlePattern(safe: string): string {
  const MARK = '\u0001';
  const escaped = safe
    .split(STRUCTURAL_MARK)
    .join(MARK)
    .replace(REGEX_META, '\\$&')
    .split(MARK)
    .join('.*');
  return escaped;
}

/**
 * Query for the title fallback — NOT for use inside `.or()`.
 *
 * Ordinary input stays on `.ilike` (the reviewed path, existing trigram index).
 * Input containing `*` switches to `.imatch` because PostgREST rewrites every
 * `*` in an ILIKE value to `%`; there is no way to escape it back to a literal
 * asterisk. A regex literal escapes it safely instead.
 */
export function lotTitleQuery(raw: string): LotTitleQuery | null {
  const safe = safeTitleText(raw);
  if (safe === null) return null;

  return safe.includes('*')
    ? { operator: 'imatch', pattern: imatchTitlePattern(safe) }
    : { operator: 'ilike', pattern: ilikeTitlePattern(safe) };
}

export type LookupBin = {
  code: string | null;
  aisle: string | null;
  bay: string | null;
  warehouses?: { name: string | null } | Array<{ name: string | null }> | null;
};

export type LookupBinAssignment =
  | { status: string; bins: LookupBin | LookupBin[] | null }
  | null
  | undefined;

/**
 * What the latest-assignment lookup returned for one lot. An error is distinct
 * from a successful empty result: only the latter may fall back to the intake
 * shelf as if it were the confirmed current location.
 */
export type LookupAssignmentResult =
  | { kind: 'ok'; assignment: LookupBinAssignment }
  | { kind: 'error' };

export function toAssignmentResult(
  rows: Array<{ status: string; bins: unknown }> | null | undefined,
  error: unknown,
): LookupAssignmentResult {
  if (error) return { kind: 'error' };
  const row = rows?.[0];
  return {
    kind: 'ok',
    assignment: row
      ? { status: row.status, bins: row.bins as LookupBin | LookupBin[] | null }
      : null,
  };
}

export const LOCATION_UNAVAILABLE_LABEL = 'Location unavailable — retry';

/** Retry the same lookup (used by the unavailable-location cell). */
export function lookupRetryHref(raw: string): string {
  return `/lots/lookup?code=${encodeURIComponent(raw)}`;
}

/**
 * "Warehouse · Bin CODE (Aisle X / Bay Y)" for a lookup row.
 *
 * Mirrors the lot detail page's history logic: the latest STAGED bin assignment
 * wins over the intake shelf, because staff re-stage won lots near the counter.
 * A latest assignment of `picked_up` means the item physically left, so the
 * intake shelf is shown instead.
 *
 * The staged bin may live in a different warehouse from the lot's intake shelf
 * (cross-building move). When it does, show the STAGED bin's warehouse beside
 * that bin — never warehouse A's name next to warehouse B's bin.
 */
export function formatLookupLocation(
  warehouseName: string | null,
  intakeBin: { code: string | null; aisle: string | null; bay: string | null } | null,
  latestAssignment: LookupBinAssignment,
): string {
  const assignment = latestAssignment ?? null;
  const stagedBin = assignment?.status === 'staged' ? firstEmbeddedBin(assignment.bins) : null;
  const stagedWarehouse = stagedBin ? firstEmbeddedWarehouse(stagedBin.warehouses) : null;
  const activeBin = stagedBin ?? intakeBin;
  const activeWarehouse = stagedWarehouse?.name ?? warehouseName;

  const parts: string[] = [];
  if (activeWarehouse) parts.push(activeWarehouse);
  if (activeBin?.code) {
    let bin = `Bin ${activeBin.code}`;
    if (activeBin.aisle) {
      bin += ` (Aisle ${activeBin.aisle}${activeBin.bay ? ` / Bay ${activeBin.bay}` : ''})`;
    }
    if (stagedBin) bin += ' · staged for pickup';
    parts.push(bin);
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function firstEmbeddedBin(embedded: LookupBin | LookupBin[] | null | undefined): LookupBin | null {
  return Array.isArray(embedded) ? (embedded[0] ?? null) : (embedded ?? null);
}

function firstEmbeddedWarehouse(
  embedded: { name: string | null } | Array<{ name: string | null }> | null | undefined,
): { name: string | null } | null {
  return Array.isArray(embedded) ? (embedded[0] ?? null) : (embedded ?? null);
}

/**
 * Location shown for one lookup row. A failed assignment query means the
 * location is unknown — do not present the intake shelf as if it were
 * confirmed current. A successful empty result may still fall back to intake.
 */
export function lookupLocation(
  warehouseName: string | null,
  intakeBin: { code: string | null; aisle: string | null; bay: string | null } | null,
  result: LookupAssignmentResult | undefined,
): { kind: 'known'; label: string } | { kind: 'unavailable' } {
  if (result?.kind === 'error') return { kind: 'unavailable' };
  return {
    kind: 'known',
    label: formatLookupLocation(
      warehouseName,
      intakeBin,
      result?.kind === 'ok' ? result.assignment : null,
    ),
  };
}
