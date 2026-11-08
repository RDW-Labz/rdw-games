/**
 * CategoryMegaMenu — "All categories" dropdown for the public header.
 *
 * Architecture: server component (data fetch) wraps a client component
 * (interaction). This keeps the category tree data fully SSR-rendered so
 * the dropdown HTML is present on first paint and crawlable.
 *
 * Desktop (≥768px):
 *   Trigger button "All categories ▾" in the nav bar opens a wide
 *   full-bleed dropdown panel. Parents are columns (4-5 across); leaves
 *   are listed below each parent header. Click outside or Esc to close.
 *
 * Mobile (<768px):
 *   The trigger shows in the hamburger sheet. The dropdown becomes a
 *   full-screen drawer with an accordion (tap parent to expand leaves).
 *   Close X in the top-right.
 */

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { CategoryMegaMenuClient } from './CategoryMegaMenuClient';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CategoryItem {
  id: string;
  slug: string;
  name: string;
  /** Legacy 512px flat-leaf icon (PNG, /05_CATEGORY_ICONS/). Fallback only. */
  icon_url: string | null;
  /** v3 no-text photo (800x600). Preferred thumbnail source for the
   *  mega-menu rows; rendered as a small rounded square via object-fit. */
  image_url_clean: string | null;
  parent_id: string | null;
}

export interface CategoryGroup {
  parent: CategoryItem;
  leaves: CategoryItem[];
}

// ── Data loader ───────────────────────────────────────────────────────────────

export async function loadCategoryGroups(): Promise<CategoryGroup[]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('categories')
      .select('id, slug, name, icon_url, image_url_clean, parent_id')
      .order('name', { ascending: true });

    if (error || !data) return [];

    const rows = data as CategoryItem[];
    const parentsMap = new Map<string, CategoryItem>();
    const leafMap = new Map<string, CategoryItem[]>();

    for (const row of rows) {
      if (row.parent_id === null) {
        parentsMap.set(row.id, row);
      }
    }
    for (const row of rows) {
      if (row.parent_id !== null && parentsMap.has(row.parent_id)) {
        const existing = leafMap.get(row.parent_id) ?? [];
        leafMap.set(row.parent_id, [...existing, row]);
      }
    }

    const groups: CategoryGroup[] = [];
    for (const [parentId, parent] of parentsMap) {
      groups.push({
        parent,
        leaves: leafMap.get(parentId) ?? [],
      });
    }

    // Sort groups by parent name (already sorted from DB, but keep safe).
    return groups.sort((a, b) => a.parent.name.localeCompare(b.parent.name));
  } catch {
    return [];
  }
}

// ── Server component ──────────────────────────────────────────────────────────

export async function CategoryMegaMenu() {
  const groups = await loadCategoryGroups();
  return <CategoryMegaMenuClient groups={groups} />;
}

/** Pre-fetched variant — accepts groups already loaded by the parent layout
 *  so we avoid a second DB hit when layout is fetching groups for MobileNavControls. */
export function CategoryMegaMenuWithGroups({ groups }: { groups: CategoryGroup[] }) {
  return <CategoryMegaMenuClient groups={groups} />;
}
