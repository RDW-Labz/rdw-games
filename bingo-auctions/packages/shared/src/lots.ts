// Lot identifier display helpers.
//
// A lot always has a canonical lot_code (e.g. "BIN-000131"), minted by
// next_lot_code. When the operator binds a pre-printed / pre-stickered label,
// it's stored in lots.sticker_code operator-PREFIXED as "{op.code}:{RAW}"
// (a SINGLE colon; the RAW portion never contains a colon — enforced by
// claim_sticker_code, mig 0141). Staff see the physical label on the box and
// customers see it at pickup, so the human-facing identifier is the stripped
// sticker (the "BRN") when one is bound, else the canonical lot_code.

export interface LotCodeFields {
  lot_code?: string | null;
  sticker_code?: string | null;
  /**
   * The database's own answer, from the `display_code` computed column (mig
   * 0315). Resolved server-side over the full lineage, so it needs no embed and
   * cannot be truncated by one. Add `display_code` to a select and this wins.
   */
  display_code?: string | null;
  /**
   * The lineage root this lot was relisted out of, when the caller joined it.
   * Supplies the box label for a relist child that never got its own sticker —
   * see `lotDisplayCode`. Optional: callers that don't join lineage keep the
   * old two-field behaviour.
   */
  relisted_from?: LotCodeFields | null;
}

/**
 * Strip the "{op}:" prefix from a stored sticker_code → the raw label the
 * operator actually printed (e.g. "BIN:BRN4981840" → "BRN4981840").
 *
 * Returns null for null / empty input. The CHECK constraint on lots.sticker_code
 * guarantees a single leading "{op}:" delimiter, but if a malformed value with
 * no colon ever appears we fall back to the trimmed whole value rather than
 * dropping it silently.
 */
export function stickerLabel(stickerCode: string | null | undefined): string | null {
  if (!stickerCode) return null;
  const i = stickerCode.indexOf(':');
  if (i < 0) return stickerCode.trim() || null;
  return stickerCode.slice(i + 1).trim() || null;
}

/**
 * The human-facing identifier for a lot: the physical label on the box — the
 * stripped `sticker_code` (the "BRN…" the operator printed and stuck on) when a
 * sticker is bound, otherwise the canonical `lot_code`. This is the single code
 * staff and customers read on the box, the pickup pass, receipts, and lists.
 *
 * HISTORY: #209 (2026-07-22) flipped this to prefer `lot_code`, on the theory
 * that `sticker_code` was only ever a cryptic Amazon LPN. In practice the
 * go-live inventory was re-lotted so the physical box carries its legacy
 * `BRN…/TEA…/GRA…/PNK…/PPE…` label (stored as `sticker_code = "BIN:{legacy}"`),
 * while `lot_code` became a fresh `BIN-######` the box does NOT show — so
 * customers were shown a `BIN-######` they couldn't match to their item.
 * Reverted 2026-07-23 (owner call, emergency): show the sticker/box label first
 * again. `stickerLabel` strips the operator prefix, so callers get "BRN4382597",
 * not "BIN:BRN4382597".
 *
 * RELIST CHILDREN (2026-08-07): `relist_lot_into_auction` mints the child with
 * `sticker_code = NULL` — the physical box keeps the label it already wore, but
 * the unique index on `sticker_code` means only ONE lot in a lineage can hold
 * it, and that is often a superseded sibling rather than the live child. So the
 * child fell through to its `BIN-######`, reproducing exactly the mismatch the
 * 2026-07-23 revert above was meant to end: the pass says `BIN-007904`, the box
 * says `TEA4951993`. In prod every such child's label was already claimed by
 * another row (no child could simply inherit it), so this resolves the label
 * through `relisted_from` for DISPLAY only and leaves sticker ownership — and
 * therefore scan resolution — untouched.
 *
 * Walks the lineage chain, so a twice-relisted box still reports its label.
 *
 * PREFER THE SERVER'S ANSWER (2026-08-10). The walk below can only see the
 * lineage the caller embedded, and the shipped embeds stop at two ancestors —
 * so a deeper chain, or any of the ~two dozen selects that fetch just
 * (lot_code, sticker_code), silently fell back to the synthetic `BIN-######`
 * the box does not show. That is what put `BIN-007904` on a customer's pickup
 * screen while the box read `TEA4951993`. Migration 0315 resolves the same rule
 * in SQL as the `display_code` computed column, over the whole lineage and with
 * no embed required. Add `display_code` to the select and this function just
 * returns it; the walk stays for callers that haven't been migrated yet.
 *
 * Returns null only when no field yields a code — callers that need a guaranteed
 * string should coalesce (e.g. `lotDisplayCode(lot) ?? lot.id.slice(0, 8)`).
 */
export function lotDisplayCode(lot: LotCodeFields): string | null {
  const resolved = lot.display_code?.trim();
  if (resolved) return resolved;

  const own = stickerLabel(lot.sticker_code);
  if (own) return own;

  // Prefer an ancestor's physical label over this lot's synthetic BIN-######.
  // Bounded walk: lineage is shallow, but never trust prod data to be acyclic.
  const seen = new Set<LotCodeFields>([lot]);
  for (let a = lot.relisted_from; a && !seen.has(a); a = a.relisted_from) {
    seen.add(a);
    const inherited = stickerLabel(a.sticker_code) ?? legacyLotCodeLabel(a.lot_code);
    if (inherited) return inherited;
  }

  return lot.lot_code ?? null;
}

/**
 * A go-live import lot carries its printed label AS its `lot_code`
 * ("TEA4951993") rather than in `sticker_code`. Re-lotted stock instead gets a
 * synthetic `BIN-######` that appears nowhere on the box. Only the former is
 * usable as an inherited display label.
 */
function legacyLotCodeLabel(lotCode: string | null | undefined): string | null {
  if (!lotCode) return null;
  const trimmed = lotCode.trim();
  return /^[A-Z]{2,8}[0-9]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Statuses that mean a lot record is retired — a dead copy that should NOT win
 * a scan when a live twin exists. `relisted` = the source lot after
 * relist_lot_into_auction handed off to a fresh BIN-#### child; `canceled` /
 * `disposed` = pulled from sale.
 */
export const RETIRED_LOT_STATUSES: ReadonlySet<string> = new Set([
  'canceled',
  'relisted',
  'disposed',
]);

/**
 * Pick the "live" lot when a single scanned code resolves to more than one.
 *
 * The classic collision (Jared report 2026-07-22): a go-live import lot with
 * `lot_code=BRN4374140` was later re-lotted into a fresh `BIN-######` lot that
 * carries `sticker_code=BIN:BRN4374140`. Both answer to the raw "BRN4374140"
 * scan, but the legacy copy is `relisted`/`canceled` while the re-lotted copy
 * is the one the customer's Pickup Pass shows. A lot_code-first resolver
 * returned the STALE copy, so Lot Lookup said "Canceled" for an item that was
 * actually sold and staged for pickup.
 *
 * Prefer a non-retired (active) record; break ties by newest `created_at`
 * (the re-lotted child is always newer than its legacy source). Returns null
 * only for an empty list.
 */
export function preferActiveLot<T extends { status?: string | null; created_at?: string | null }>(
  rows: readonly T[],
): T | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const aRetired = RETIRED_LOT_STATUSES.has(String(a.status)) ? 1 : 0;
    const bRetired = RETIRED_LOT_STATUSES.has(String(b.status)) ? 1 : 0;
    if (aRetired !== bRetired) return aRetired - bRetired; // active (0) first
    return String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')); // newest first
  })[0]!;
}

/**
 * Codes we're willing to interpolate into a PostgREST filter. Lot codes are
 * minted (`BIN-001737`) or come off a printed label (`PNK4858852`), so this is
 * generous but still excludes the `,` / `.` / `(` / `)` / `*` characters that
 * would let a URL segment break out of the `or=(…)` grammar.
 */
const SAFE_LOT_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * PostgREST `or=(…)` filter terms matching `code` against every column a
 * scanned or typed lot code can live in.
 *
 * A single physical label answers to more than one column at once. The relist
 * carryover (`relist_lot_into_auction`, migs 0192/0213) moves the box's
 * identity onto the new child and leaves the parent behind, so the printed
 * label is simultaneously the retired parent's `lot_code` AND the raw half of
 * the live child's `sticker_code` — 855 lot pairs on prod are in that shape.
 * Probing `lot_code` alone (or first) answers with the tombstone.
 *
 * Returns null for a code that can't be safely interpolated; callers should
 * treat that as "no match" rather than querying.
 *
 * ── Every term here must be indexable (mig 0362) ───────────────────────────
 * This function is two hops from the single most expensive query on the
 * platform: the public lot page calls it via `findLotsByAnyCode`, and the
 * staff scanner via `resolve-lot-scan`. Until 2026-09-19 three of its six
 * terms were ILIKE:
 *
 *     lot_code.ilike.CODE          no wildcard, but ILIKE is not a btree op
 *     legacy_lot_code.ilike.CODE   same
 *     sticker_code.ilike.%:CODE    LEADING wildcard — unindexable outright
 *
 * One unindexable branch of an OR makes Postgres scan the whole relation, so
 * each lot page view read all 29,175 rows of `lots`. Measured on prod:
 * 1,181,337 calls at 95.56 ms = 31.4 CPU-hours over 11 days, and 42 BILLION
 * tuples read by sequential scan. On 2026-09-19 that saturated the instance
 * during the close hour and took the site down for 45 minutes.
 *
 * So: equality only. Anything added here needs an index behind it, or it
 * reintroduces the outage.
 */
export function lotCodeMatchFilters(code: string): string[] | null {
  const trimmed = code.trim();
  if (!SAFE_LOT_CODE.test(trimmed)) return null;

  // Case-folded once here rather than per-term. `lot_code` and
  // `legacy_lot_code` are minted upper-case (verified on prod 2026-09-19:
  // 0 of 29,175 and 0 of 4,678 rows respectively are not), so an equality
  // against the upper-cased input is exactly what the old ILIKE matched.
  const upper = trimmed.toUpperCase();

  const filters = [
    // Exact, as typed. Kept ahead of the upper-cased terms so a code that is
    // somehow stored lower-case still resolves when entered the same way.
    `lot_code.eq.${trimmed}`,
    `sticker_code.eq.${trimmed}`,
    `legacy_lot_code.eq.${trimmed}`,
  ];

  // Case-insensitive, via equality against normalised values.
  if (upper !== trimmed) {
    filters.push(`lot_code.eq.${upper}`);
    filters.push(`legacy_lot_code.eq.${upper}`);
  }
  // `sticker_code` is stored `{op}:{RAW}` and the printed label is the RAW
  // half, which is why this used to need a leading-wildcard match. `lots
  // .sticker_raw_upper` (0362) is that half, upper-cased and indexed, so the
  // suffix match becomes an equality. Unlike the other two columns the raw
  // half genuinely is mixed case on prod (47 of 18,905 rows), so this term
  // does real work rather than merely mirroring `sticker_code.eq`.
  filters.push(`sticker_raw_upper.eq.${upper}`);

  return filters;
}

/** Which identifier column a row matched on. Lower sorts first. */
function scanFieldRank(row: LotCodeFields, code: string): number {
  const c = code.trim().toLowerCase();
  const sticker = (row.sticker_code ?? '').toLowerCase();
  // The sticker is what is physically stuck to the box, so it outranks the
  // canonical lot_code — this is the ordering the old resolvers had backwards.
  if (sticker === c) return 1;
  if (sticker.slice(sticker.indexOf(':') + 1) === c && sticker.includes(':')) return 1;
  if ((row.lot_code ?? '').toLowerCase() === c) return 2;
  return 3; // legacy_lot_code / anything else the query matched
}

/**
 * Pick the one lot a scanned code means, from every row that answered to it.
 *
 * Mirrors `_find_lot_by_scan`'s ranking (mig 0304) so the scanners, the
 * storefront, and the RPCs give the same answer for the same label:
 *
 *   1. active before retired — a relisted/canceled/disposed row is history
 *   2. then the sticker on the box before the canonical lot_code
 *   3. then newest, which is the relist child by construction
 *
 * `preferActiveLot` implements only rule 1 and 3; prefer this when the code
 * that produced `rows` is known, because rule 2 is what breaks the tie for the
 * 142 prod pairs whose two sides are BOTH active.
 */
export function rankScannedLots<
  T extends LotCodeFields & { status?: string | null; created_at?: string | null },
>(rows: readonly T[], code: string): T | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const aRetired = RETIRED_LOT_STATUSES.has(String(a.status)) ? 1 : 0;
    const bRetired = RETIRED_LOT_STATUSES.has(String(b.status)) ? 1 : 0;
    if (aRetired !== bRetired) return aRetired - bRetired;
    const rank = scanFieldRank(a, code) - scanFieldRank(b, code);
    if (rank !== 0) return rank;
    return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
  })[0]!;
}
