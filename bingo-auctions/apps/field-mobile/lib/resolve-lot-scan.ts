// One place where a scanned or typed code becomes a lot row.
//
// Every staff scanner used to carry its own probe ladder, and they disagreed.
// Put-away tried `lot_code` (upper-cased, gated on a regex), then
// `external_code`, then the sticker suffix. Bin Audit tried `lot_code`, then
// `sticker_code`, then the suffix — each with `.maybeSingle()`, so the FIRST
// probe that hit anything won. Pickup Verify probed `lot_code` and nothing
// else.
//
// That ordering is backwards for the population it matters most for. A relist
// does not mutate the lot row: `relist_lot_into_auction` (migs 0192/0213) mints
// a child, MOVES the physical sticker onto it, and leaves the parent as a
// tombstone. So the label on the box is at once
//
//   • the retired parent's `lot_code`, and
//   • the raw half of the live child's `sticker_code`
//
// and a lot_code-first probe answers with the parent — which reports no
// auction, and points at the bin the item left weeks ago. 855 lot pairs on prod
// are in that shape (142 with a live child, 408 with a won one). It is the
// field report from 2026-07-30, lot PNK4858852.
//
// `resolveLotScan` gathers EVERY row any column matched, ranks them with
// `rankScannedLots` (the same ordering mig 0304 gives `_find_lot_by_scan`), and
// walks `relisted_from_lot_id` forward when the best match is still a
// tombstone. 188 of the 855 pairs have no back-pointer, so the two-column match
// — not the lineage walk — is what carries them; both halves are needed.

import { supabase } from '@auction-platform/supabase-client';
import {
  lotCodeMatchFilters,
  rankScannedLots,
  RETIRED_LOT_STATUSES,
} from '@auction-platform/shared';

/** Hops to follow before assuming `relisted_from_lot_id` is corrupt. Matches
 *  MAX_LINEAGE_HOPS in operator-web and the bound inside mig 0304. */
export const MAX_LINEAGE_HOPS = 5;

/** Columns `resolveLotScan` needs on top of whatever the caller asks for. */
// warehouse_id is in the BASE projection, not opt-in per caller: every screen
// that resolves a scan needs to be able to say "this box lives in Harrison" —
// and a screen that forgets to ask is exactly the silent-wrong-location bug
// this is meant to close.
export const SCAN_BASE_COLUMNS =
  'id, lot_code, sticker_code, display_code, legacy_lot_code, status, created_at, warehouse_id';

export interface ScanRow {
  id: string;
  lot_code: string | null;
  sticker_code: string | null;
  /** Computed column (mig 0315): the label actually printed on the box. */
  display_code: string | null;
  status: string;
  created_at: string | null;
  /** The building this box is stocked in. NULL until put-away assigns it. */
  warehouse_id: string | null;
}

export interface ScanResult<T> {
  lot: T;
  /** How many OTHER rows answered to the same code. >0 means it was ambiguous. */
  alternates: number;
  /** Set when the match was a tombstone and we followed the relist chain to a
   *  live incarnation — carries the code of the row that was scanned onto. */
  hoppedFrom: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Same shape, unanchored — for digging a token out of a QR URL. */
const UUID_IN_TEXT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * A lot QR usually encodes a URL (`https://bingoauctions.com/l/<qr_token>`)
 * rather than a bare token, so unwrap it before probing. Everything else is
 * handed through untouched — `SAFE_LOT_CODE` rejects anything URL-shaped, so
 * without this a scanned lot QR resolved to nothing on every screen that
 * didn't carry its own extractor.
 */
export function normalizeScanInput(raw: string): string {
  const trimmed = raw.trim();
  if (UUID_RE.test(trimmed)) return trimmed.toLowerCase();
  const embedded = trimmed.match(UUID_IN_TEXT_RE);
  return embedded ? embedded[0].toLowerCase() : trimmed;
}

function isRetired(status: string | null | undefined): boolean {
  return RETIRED_LOT_STATUSES.has(String(status));
}

export interface ResolveLotScanOptions {
  /**
   * Called when a probe QUERY FAILED, as opposed to matching nothing.
   *
   * These are not the same thing and this resolver used to conflate them: every
   * probe destructured `{ data }` and dropped `error`, so a 400 from a bad
   * select, an RLS/JWT problem, or a dropped connection all produced zero rows
   * and the caller reported "No lot matches" — pointing staff at the label in
   * their hand when the label was never the problem. That is precisely how the
   * relot pile-up presented (owner report 2026-08-10) and it is undiagnosable
   * from the floor.
   *
   * Optional because three call sites (put-away batch/single) are not inside a
   * try/catch, so this must not throw by default. Screens that can show an
   * error pass a handler; everything else keeps the old behaviour exactly.
   */
  onQueryError?: (message: string) => void;
  /**
   * Throw instead of continuing when ANY probe query fails.
   *
   * A partial answer is not an answer. If the identity (UUID) probe fails but
   * a lower-priority sticker probe still finds a row, that row is not provably
   * the item in the caller's hand — confirming it moves the wrong box. The
   * same is true of a failed lineage walk: the best match is then a tombstone,
   * and returning it silently puts the box against the auction/bin it left.
   *
   * Screens that can surface a recoverable error (put-away single) opt in;
   * the old lenient behaviour stays for call sites that cannot catch.
   */
  failClosed?: boolean;
  /** Optional cancellation for the underlying queries. Screens that bound a
   *  lookup with a timeout pass the attempt signal so a hung request is
   *  actually aborted instead of merely ignored. */
  signal?: AbortSignal;
}

/**
 * Report a probe failure, and in `failClosed` mode stop the whole resolution.
 * Kept in one place so no probe can forget the second half.
 */
function reportProbeError(message: string, opts?: ResolveLotScanOptions): void {
  opts?.onQueryError?.(message);
  if (opts?.failClosed) throw new Error(message);
}

/**
 * Resolve `raw` — a QR payload, a scanned barcode, or a typed code — to the one
 * lot it means, or null.
 *
 * `columns` is appended to `SCAN_BASE_COLUMNS`, so callers get their own
 * projection plus everything the ranking needs. Soft-deleted lots are never
 * returned (0057). RLS already scopes `lots` to the caller's operator.
 */
export async function resolveLotScan<T extends ScanRow>(
  raw: string,
  columns: string,
  opts?: ResolveLotScanOptions,
): Promise<ScanResult<T> | null> {
  const code = normalizeScanInput(raw);
  if (!code) return null;

  const select = columns.trim() ? `${SCAN_BASE_COLUMNS}, ${columns}` : SCAN_BASE_COLUMNS;
  const rows: T[] = [];

  // A QR token is unique to one lot, so it short-circuits the text probes —
  // but it can still point at a tombstone (relist mints the parent a FRESH
  // qr_token and hands the old one to the child, so a label printed before an
  // earlier relist resolves to a mid-chain row). The forward walk below still
  // applies.
  if (UUID_RE.test(code)) {
    let query = supabase
      .from('lots')
      .select(select)
      // A UUID on a label is a qr_token, but older operator-web PDFs encoded
      // the lot's primary key, so both are accepted. Both are unique, so the
      // `or` can still only return one row.
      .or(`qr_token.eq.${code},id.eq.${code}`)
      .is('deleted_at', null)
      .limit(2);
    if (opts?.signal) query = query.abortSignal(opts.signal);
    const { data, error } = await query;
    if (error) reportProbeError(error.message, opts);
    if (data?.length) rows.push(...(data as unknown as T[]));
  }

  if (rows.length === 0) {
    const filters = lotCodeMatchFilters(code);
    if (!filters) return null;
    let query = supabase
      .from('lots')
      .select(select)
      .or(filters.join(','))
      .is('deleted_at', null)
      .limit(10);
    if (opts?.signal) query = query.abortSignal(opts.signal);
    const { data, error } = await query;
    if (error) reportProbeError(error.message, opts);
    if (data?.length) rows.push(...(data as unknown as T[]));
  }

  const best = rankScannedLots(rows, code);
  if (!best) return null;

  const alternates = Math.max(rows.length - 1, 0);
  if (!isRetired(best.status)) return { lot: best, alternates, hoppedFrom: null };

  // Every match is history. Walk forward to whatever the item became.
  let current = best;
  let hoppedFrom: string | null = null;
  const seen = new Set<string>([best.id]);

  for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop++) {
    let query = supabase
      .from('lots')
      .select(select)
      .eq('relisted_from_lot_id', current.id)
      .is('deleted_at', null)
      .limit(10);
    if (opts?.signal) query = query.abortSignal(opts.signal);
    const { data, error } = await query;
    if (error) reportProbeError(error.message, opts);

    const children = ((data ?? []) as unknown as T[]).filter((c) => c && !seen.has(c.id));
    // A parent can have several children over its life; take the active one,
    // newest otherwise — the same rule the RPC and the storefront use.
    const next = rankScannedLots(children, code);
    if (!next) break;

    hoppedFrom = hoppedFrom ?? current.lot_code ?? null;
    seen.add(next.id);
    current = next;
    if (!isRetired(current.status)) break;
  }

  return { lot: current, alternates, hoppedFrom };
}
