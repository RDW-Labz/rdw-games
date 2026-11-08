// Saved searches — small CRUD wrapper over the saved_searches table.
//
// Criteria shape mirrors what the bidder app's browse screen already
// owns: free text q, optional category_id, optional operator_id,
// optional min_discount_pct. Workers and matcher use the same shape.

import { supabase } from '@auction-platform/supabase-client';

export type SavedSearchCriteria = {
  q?: string;
  category_id?: string;
  operator_id?: string;
  min_discount_pct?: number;
};

export type SavedSearch = {
  id: string;
  bidder_id: string;
  name: string;
  criteria: SavedSearchCriteria;
  notify: boolean;
  last_matched_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function listSavedSearches(): Promise<SavedSearch[]> {
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return [];
  const { data } = await supabase
    .from('saved_searches')
    .select('id, bidder_id, name, criteria, notify, last_matched_at, created_at, updated_at')
    .eq('bidder_id', u.user.id)
    .order('created_at', { ascending: false });
  return (data ?? []) as SavedSearch[];
}

export async function createSavedSearch(input: {
  name: string;
  criteria: SavedSearchCriteria;
}): Promise<SavedSearch | null> {
  const { data: u } = await supabase.auth.getUser();
  if (!u.user) return null;
  const { data, error } = await supabase
    .from('saved_searches')
    .insert({
      bidder_id: u.user.id,
      name: input.name,
      criteria: input.criteria,
    })
    .select(
      'id, bidder_id, name, criteria, notify, last_matched_at, created_at, updated_at',
    )
    .single();
  if (error) return null;
  return data as SavedSearch;
}

export async function deleteSavedSearch(id: string): Promise<boolean> {
  const { error } = await supabase.from('saved_searches').delete().eq('id', id);
  return !error;
}

export async function updateSavedSearchNotify(
  id: string,
  notify: boolean,
): Promise<boolean> {
  const { error } = await supabase
    .from('saved_searches')
    .update({ notify, updated_at: new Date().toISOString() })
    .eq('id', id);
  return !error;
}

// Generate a default name from current criteria — what the bidder
// would call this if they weren't typing one in. Used as the prompt
// default value.
export function defaultNameFromCriteria(c: SavedSearchCriteria, ctx?: {
  categoryNameById?: (id: string) => string | undefined;
  operatorNameById?: (id: string) => string | undefined;
}): string {
  const parts: string[] = [];
  if (c.q) parts.push(`"${c.q}"`);
  if (c.category_id) {
    const name = ctx?.categoryNameById?.(c.category_id);
    if (name) parts.push(name);
  }
  if (c.operator_id) {
    const name = ctx?.operatorNameById?.(c.operator_id);
    if (name) parts.push(`@${name}`);
  }
  if (c.min_discount_pct) parts.push(`${c.min_discount_pct}%+ off`);
  return parts.join(' · ') || 'My search';
}

export function summarizeCriteria(c: SavedSearchCriteria, ctx?: {
  categoryNameById?: (id: string) => string | undefined;
  operatorNameById?: (id: string) => string | undefined;
}): string {
  return defaultNameFromCriteria(c, ctx);
}
