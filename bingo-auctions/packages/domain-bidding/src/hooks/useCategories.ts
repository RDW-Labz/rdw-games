// useCategories — loads the global category taxonomy once per app
// session and groups it as { topLevel: [...], leafIdsByParentSlug: {} }.
// The bidder browse uses this to render a top-level chip rail and
// filter lots by category_id IN [parent + all leaves under it].
//
// Categories rarely change at runtime (a platform-curated taxonomy),
// so the in-memory cache lives for the entire app session. If we ever
// need fresher data, swap to a Realtime sub on `categories`.

import { useEffect, useState } from 'react';
import { supabase } from '@auction-platform/supabase-client';

export type CategoryRow = {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
  icon: string | null;
  sort_order: number;
  /** Clean card image without baked-in label — preferred for grids that
   *  render their own overlay label. Added in migration 0114. */
  image_url_clean: string | null;
  /** Square icon image for compact chip rail display. Added in migration 0114. */
  icon_url: string | null;
};

export type CategoryView = {
  topLevel: CategoryRow[];
  leafIdsByParentId: Record<string, string[]>;
  byId: Record<string, CategoryRow>;
};

let cached: CategoryView | null = null;
let inflight: Promise<CategoryView | null> | null = null;

async function fetchOnce(): Promise<CategoryView | null> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const { data, error } = await supabase
      .from('categories')
      .select('id, slug, name, parent_id, icon, sort_order, image_url_clean, icon_url')
      .order('sort_order', { ascending: true });
    if (error || !data) {
      inflight = null;
      return null;
    }
    const rows = data as CategoryRow[];

    // PERF-9 (2026-05-24 audit): build byId + childrenByParentId in a single
    // O(N) pass, then build leafIdsByParentId in O(T) — total O(N) instead of
    // O(T×N) from the prior nested filter.
    const byId: Record<string, CategoryRow> = {};
    const childrenByParentId = new Map<string, string[]>();
    for (const r of rows) {
      byId[r.id] = r;
      if (r.parent_id != null) {
        const siblings = childrenByParentId.get(r.parent_id);
        if (siblings) {
          siblings.push(r.id);
        } else {
          childrenByParentId.set(r.parent_id, [r.id]);
        }
      }
    }

    const topLevel = rows.filter((r) => r.parent_id == null);
    const leafIdsByParentId: Record<string, string[]> = {};
    for (const top of topLevel) {
      // The parent itself is also a valid category_id (lots can be
      // assigned at the top level if no leaf fits), so include it.
      leafIdsByParentId[top.id] = [
        top.id,
        ...(childrenByParentId.get(top.id) ?? []),
      ];
    }
    cached = { topLevel, leafIdsByParentId, byId };
    inflight = null;
    return cached;
  })();
  return inflight;
}

export function useCategories(): CategoryView | null {
  const [data, setData] = useState<CategoryView | null>(cached);

  useEffect(() => {
    if (cached) {
      setData(cached);
      return;
    }
    let cancelled = false;
    fetchOnce().then((res) => {
      if (!cancelled) setData(res);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return data;
}
