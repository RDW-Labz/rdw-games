// Multi-category filter resolution (2026-07-07, customer request: "couldn't
// select multiple categories"). URL param `category` is a comma-separated list
// of leaf/parent slugs; the lot query filters on the UNION of every selected
// category's id plus its children's ids.

import type { SupabaseClient } from '@supabase/supabase-js';

/** Parse the `category` URL param into a de-duped slug list. */
export function parseCategorySlugs(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return Array.from(new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)));
}

/**
 * Resolve selected category slugs to the full id set to filter on (each
 * selected category + its direct children — same expansion /browse has always
 * done for a single slug). Two round-trips total regardless of how many
 * categories are selected. Unknown slugs are ignored; returns [] when nothing
 * resolves (callers skip the filter entirely in that case, matching the old
 * single-slug behavior).
 */
export async function resolveCategoryFilterIds(
  supabase: SupabaseClient,
  slugs: string[],
): Promise<string[]> {
  if (slugs.length === 0) return [];
  const { data: catData } = await supabase
    .from('categories')
    .select('id')
    .in('slug', slugs);
  const ids = ((catData ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (ids.length === 0) return [];
  const { data: childData } = await supabase
    .from('categories')
    .select('id')
    .in('parent_id', ids);
  const childIds = ((childData ?? []) as Array<{ id: string }>).map((r) => r.id);
  return Array.from(new Set([...ids, ...childIds]));
}
