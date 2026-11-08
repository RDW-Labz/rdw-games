// How a free-text lot search becomes a PostgREST `.or(...)` filter.
//
// ── Two shapes, by length ────────────────────────────────────────────────────
// 3+ characters: substring (`%q%`) across the text columns and the codes. pg_trgm
// indexes 3-character grams, so this is the shape a trigram index can serve
// (title has lots_title_trgm_idx; lot_code/sticker_code get theirs from 0365).
//
// 1–2 characters: a word-prefix match on the text columns only — the text starts
// with q, or a word inside it does (after a space or a hyphen). A substring that
// short is mostly noise ("ca" is in "vacation"), and it cannot use a trigram
// index either. Codes are left out because none is that short: on 2026-09-24
// the shortest lot_code was 10 characters and the shortest sticker label 3.
//
// ── Why not return nothing below 3 ───────────────────────────────────────────
// That was the first version of this file, and it made "TV" return an empty
// page. On an auction site an empty page reads as "we have no TVs"; the
// customer leaves. It was also protecting little: both callers only search lots
// in live/upcoming auctions (1,798 of 32,890 on 2026-09-24, via the auction_id
// index), and prod's pg_stat_statements put the /browse search at 21.8ms mean
// and /api/search/suggest at 5.9ms. On 2026-09-24, "tv" as a word prefix found
// 12 active lots, the same 12 the substring search finds.
//
// ── Security ─────────────────────────────────────────────────────────────────
// `.or()` takes filter SYNTAX, not a bound parameter. The only way user text
// reaches the filter is through sanitizePostgrestPattern below; callers get a
// finished filter string and never interpolate the raw query themselves.

import { sanitizePostgrestPattern } from '@/lib/postgrest-filter';

/** Shortest query searched as a substring; shorter ones use word prefixes. */
export const MIN_SUBSTRING_CHARS = 3;

export interface SearchColumns {
  /** Free-text columns: word-prefix below MIN_SUBSTRING_CHARS, substring at or above. */
  text: string[];
  /** Code columns: substring at or above MIN_SUBSTRING_CHARS, skipped below. */
  codes?: string[];
}

/**
 * The `.or(...)` filter for a search box value, or null when nothing usable is
 * left after trimming and sanitising (treat that as "no search").
 */
export function searchOrFilter(
  raw: string | null | undefined,
  columns: SearchColumns,
): string | null {
  const q = sanitizePostgrestPattern((raw ?? '').trim()).trim();
  if (q.length === 0) return null;

  if (q.length >= MIN_SUBSTRING_CHARS) {
    const pattern = `%${q}%`;
    return [...columns.text, ...(columns.codes ?? [])]
      .map((col) => `${col}.ilike.${pattern}`)
      .join(',');
  }

  return columns.text
    .flatMap((col) => [`${col}.ilike.${q}%`, `${col}.ilike.% ${q}%`, `${col}.ilike.%-${q}%`])
    .join(',');
}

/** The lot search used by /browse and /api/search/suggest. */
export function lotSearchFilter(raw: string | null | undefined): string | null {
  return searchOrFilter(raw, { text: ['title'], codes: ['lot_code', 'sticker_code'] });
}
