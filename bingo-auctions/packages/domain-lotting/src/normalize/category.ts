// Category resolution — wraps the resolve_category_ids_batch RPC.
//
// The DB-side function (migration 0033) does the actual longest-substring
// match against category_aliases. This module is the single TS call site
// for that RPC so every ingestion path (importer, scraper, AI pipeline)
// goes through the same code.

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Resolve an array of raw category strings to `category_id` UUIDs using
 * the `resolve_category_ids_batch` RPC (migration 0033).
 *
 * Returns an array of `string | null` in the same order as the input.
 * `null` means no alias matched — the caller should store `category_id = null`
 * and let a later enrichment pass fill it in.
 *
 * @param supabase  An authenticated Supabase client.
 * @param rawValues Array of raw category strings (e.g. from a manifest or scraper).
 * @returns         Parallel array of resolved category UUIDs or null.
 *
 * @example
 *   const ids = await resolveCategoryAlias(supabase, ["Power Tools", "Kitchen"]);
 *   // ids[0] → "uuid-for-tools"
 *   // ids[1] → "uuid-for-kitchen"
 */
export async function resolveCategoryAlias(
  supabase: SupabaseClient,
  rawValues: string[],
): Promise<Array<string | null>> {
  if (!rawValues.length) return [];

  const { data, error } = await supabase.rpc('resolve_category_ids_batch', {
    p_texts: rawValues,
  });

  if (error || !data) {
    // Best-effort: return nulls rather than throwing. The platform degrades
    // gracefully with unclassified lots.
    return rawValues.map(() => null);
  }

  // RPC returns [{input_idx: 1, category_id: "uuid" | null}, ...]
  // Rows are 1-indexed (ordinality from unnest WITH ORDINALITY).
  const rows = data as Array<{ input_idx: number; category_id: string | null }>;
  const out: Array<string | null> = rawValues.map(() => null);
  for (const row of rows) {
    const idx = row.input_idx - 1; // convert 1-based to 0-based
    if (idx >= 0 && idx < out.length) {
      out[idx] = row.category_id ?? null;
    }
  }
  return out;
}

/**
 * Convenience wrapper: resolve a single raw category string.
 * Returns `null` if no alias matches or on any error.
 */
export async function resolveSingleCategory(
  supabase: SupabaseClient,
  raw: string,
): Promise<string | null> {
  const results = await resolveCategoryAlias(supabase, [raw]);
  return results[0] ?? null;
}
