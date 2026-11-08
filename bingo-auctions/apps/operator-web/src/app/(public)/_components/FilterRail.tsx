'use client';

/**
 * FilterRail — sticky filter sidebar (desktop) / bottom sheet (mobile).
 *
 * Reads and writes URL search params so the parent SSR page can pick them up
 * on navigation without any client-side data fetching inside this component.
 *
 * Sections:
 *   1. Category accordion — grouped by parent_slug, leaf items are pills.
 *      Icon (from icon_url) + name. Lot counts wired by caller later.
 *   2. Condition pills — 5 real DB values + 2 virtual ones ('ending-soon',
 *      'top-deal') emitted with a 'virtual:' prefix in the URL param.
 *   3. Price inputs — min + max in dollars, applied via a button.
 *   4. Sort dropdown — 5 options.
 *   5. Clear all — resets every filter param, keeps the current path.
 *
 * Mobile (<768px): renders as a fixed bottom sheet behind a full-screen
 * backdrop, triggered by a floating "Filters" button. No external library.
 *
 * URL param schema:
 *   category        string          leaf category slug
 *   condition       string[]        comma-separated list; virtual: prefix for
 *                                   ending-soon / top-deal
 *   price_min       number          whole dollars
 *   price_max       number          whole dollars
 *   sort            SortOption      one of the 5 sort values
 */

import Image from 'next/image';
import {
  useRouter,
  useSearchParams,
  usePathname,
} from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { filterSheetLabel, isFilterSheetEmpty } from '@/lib/filter-sheet-label';

// Category icons + images come pre-resolved on the `categories[].icon_url`
// prop (set by migration 0114 + 0115) — no CDN string interpolation needed
// inside this component. Kept process.env.NEXT_PUBLIC_CDN_URL out so the
// client bundle doesn't carry a constant nobody references.

// ── Types ────────────────────────────────────────────────────────────────────

export type SortOption =
  | 'ending-soon'
  | 'newest'
  | 'most-bids'
  | 'price-low'
  | 'price-high';

export interface FilterCategory {
  slug: string;
  name: string;
  parent_slug: string | null;
  /** Legacy 512px flat-leaf icon (PNG, /05_CATEGORY_ICONS/). Kept for
   *  fallback when image_url_clean is null. */
  icon_url: string | null;
  /** v3 no-text photo (typically 800x600). Used as the small thumbnail
   *  next to the category name via object-fit: cover. */
  image_url_clean: string | null;
  /** Number of storefront-visible lots in this category (status in
   *  ('live','scheduled'), deleted_at IS NULL). Required so callers
   *  can't silently omit it — every loader must compute it. */
  lot_count: number;
}

export interface FilterRailProps {
  categories: FilterCategory[];
  /** Multi-select (2026-07-07): every selected leaf/parent slug. The URL
   *  param is the comma-joined list. Empty = all categories. */
  selectedCategories: string[];
  /** Where category toggles navigate. Defaults to the current path; the
   *  /category/[slug] page passes '/browse' so cross-category selection lands
   *  on the multi-filter browse view (that page ignores ?category= itself). */
  categoryNavigatesTo?: string;
  selectedConditions: string[];
  priceMin: number | null;
  priceMax: number | null;
  sort: SortOption;
  /** Count of storefront-visible lots per condition value. Keys are the
   *  same values used in URL params: the 4 REAL lot_condition enum values
   *  ('appears_new','open_box','good','as_is' — what lotting actually
   *  writes; see mig 0001 + domain-lotting/normalize/condition.ts) + 2
   *  virtual ('virtual:ending-soon','virtual:top-deal'). Missing keys
   *  render as 0. */
  conditionCounts: Record<string, number>;
  /** MOB-01: total lots matching the CURRENT filters — the same number the
   *  grid behind the sheet is about to render. Drives the mobile sheet's
   *  footer button ("Show 24 results"), which is the only feedback a phone
   *  user gets that a category tap did anything: the sheet covers 82vh, so
   *  the filtered grid is invisible while they're choosing. Jared reported
   *  this as "the category filter doesn't work" — it always worked, he just
   *  could never see the result.
   *
   *  Optional so a caller that hasn't threaded it yet degrades to a plain
   *  "Show results" button rather than rendering "Show undefined results". */
  resultCount?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

// Values MUST be the lot_condition enum literals — the browse query does
// .in('condition', <these>) directly. The upstream rail shipped 5 fictional
// slugs ('new','like-new','open-box','tested','as-is') that matched nothing:
// every filter returned 0 lots and every count was 0 (owner, 2026-07-04 —
// "good is fine, tested shouldn't be an option").
const REAL_CONDITIONS = [
  { value: 'appears_new', label: 'Appears New' },
  { value: 'open_box', label: 'Open Box' },
  { value: 'good', label: 'Good' },
  { value: 'as_is', label: 'As-Is' },
] as const;

const VIRTUAL_CONDITIONS = [
  { value: 'virtual:ending-soon', label: 'Ending Soon' },
  { value: 'virtual:top-deal', label: 'Top Deal' },
] as const;

const ALL_CONDITIONS = [...REAL_CONDITIONS, ...VIRTUAL_CONDITIONS];

// Price sorts order by CURRENT bid (2026-07-05 — starting bid is $1 across
// the whole catalog, which made the old labels lie). Keep the values stable
// so bookmarked URLs keep working.
const SORT_OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: 'ending-soon', label: 'Ending soon' },
  { value: 'newest', label: 'Newly listed' },
  { value: 'most-bids', label: 'Most bids' },
  { value: 'price-high', label: 'Current bid: high to low' },
  { value: 'price-low', label: 'Current bid: low to high' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Render a muted lot-count suffix next to a category or condition label.
 *  Numbers ≥ 1000 get thousands separators ("12,054"). Zero is shown so
 *  operators can see which categories are currently empty. */
function CountSuffix({ count, dim = false }: { count: number; dim?: boolean }) {
  return (
    <span
      style={{
        marginLeft: 6,
        fontSize: 11,
        fontWeight: 600,
        color: dim ? 'var(--fg-dim)' : 'var(--fg-muted)',
        // Tabular numerals so counts stack neatly under one another.
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {count.toLocaleString('en-US')}
    </span>
  );
}

/** Build a URLSearchParams string from the current params with selective
 *  overrides. Returns a full `?...` string (or empty string if no params). */
function buildQuery(
  current: URLSearchParams,
  overrides: Record<string, string | null>,
): string {
  const next = new URLSearchParams(current.toString());
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || value === '') {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }
  const str = next.toString();
  return str ? `?${str}` : '';
}

/** Group leaf categories by their parent_slug. Root categories (parent_slug
 *  null) become their own group. */
function groupCategories(
  categories: FilterCategory[],
): Array<{ parentSlug: string | null; parentName: string; leaves: FilterCategory[] }> {
  const groups = new Map<
    string,
    { parentSlug: string | null; parentName: string; leaves: FilterCategory[] }
  >();

  for (const cat of categories) {
    const key = cat.parent_slug ?? '__root__';
    if (!groups.has(key)) {
      // Find a display name for this parent group.
      const parentCat = categories.find((c) => c.slug === cat.parent_slug);
      groups.set(key, {
        parentSlug: cat.parent_slug,
        parentName: parentCat?.name ?? (cat.parent_slug ? cat.parent_slug : 'All'),
        leaves: [],
      });
    }
    groups.get(key)!.leaves.push(cat);
  }

  // Root entries first, then alphabetical by parent name.
  return Array.from(groups.values()).sort((a, b) => {
    if (a.parentSlug === null) return -1;
    if (b.parentSlug === null) return 1;
    return a.parentName.localeCompare(b.parentName);
  });
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: 2,
        textTransform: 'uppercase',
        color: 'var(--fg-dim)',
        marginBottom: '0.65rem',
      }}
    >
      {children}
    </div>
  );
}

// ── Category accordion ────────────────────────────────────────────────────────

function CategoryAccordion({
  categories,
  selectedCategories,
  onSelect,
}: {
  categories: FilterCategory[];
  selectedCategories: string[];
  onSelect: (slug: string | null) => void;
}) {
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(['__root__']));
  const groups = groupCategories(categories);

  // Pre-pass: count how many leaves share the same display name. When a name
  // appears more than once, render it as "Name (Parent)" to disambiguate
  // e.g. "Accessories (Auto)" vs "Accessories (Apparel)".
  const leafNameCount = new Map<string, number>();
  for (const group of groups) {
    for (const leaf of group.leaves) {
      leafNameCount.set(leaf.name, (leafNameCount.get(leaf.name) ?? 0) + 1);
    }
  }

  function leafDisplayName(leaf: FilterCategory, parentName: string): string {
    return (leafNameCount.get(leaf.name) ?? 1) > 1
      ? `${leaf.name} (${parentName})`
      : leaf.name;
  }

  function toggleGroup(key: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  // Total across all leaves — shown on the "All categories" pill so users see
  // the storefront-wide count at a glance ("All categories 12,054").
  const totalLeafCount = categories.reduce((sum, c) => sum + c.lot_count, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {/* "All categories" pill */}
      <button
        onClick={() => onSelect(null)}
        style={{
          background: selectedCategories.length === 0 ? 'var(--accent-dim)' : 'transparent',
          border: `1px solid ${selectedCategories.length === 0 ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 6,
          padding: '0.4rem 0.75rem',
          fontSize: 13,
          fontWeight: selectedCategories.length === 0 ? 700 : 500,
          color: selectedCategories.length === 0 ? 'var(--accent)' : 'var(--fg-muted)',
          cursor: 'pointer',
          textAlign: 'left',
          width: '100%',
        }}
      >
        All categories
        <CountSuffix count={totalLeafCount} dim={totalLeafCount === 0} />
      </button>

      {groups.map((group) => {
        const key = group.parentSlug ?? '__root__';
        const isOpen = openGroups.has(key);
        // Parent group total: sum of leaf counts under this parent.
        const groupCount = group.leaves.reduce((sum, c) => sum + c.lot_count, 0);

        // Root-level leaf categories: no accordion header, just render pills.
        if (group.parentSlug === null) {
          return (
            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {group.leaves.map((cat) => (
                <CategoryLeaf
                  key={cat.slug}
                  cat={cat}
                  displayName={leafDisplayName(cat, group.parentName)}
                  isSelected={selectedCategories.includes(cat.slug)}
                  onSelect={onSelect}
                />
              ))}
            </div>
          );
        }

        return (
          <div key={key}>
            {/* Group header — collapsible */}
            <button
              onClick={() => toggleGroup(key)}
              aria-expanded={isOpen}
              style={{
                width: '100%',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: 'transparent',
                border: 'none',
                padding: '0.35rem 0',
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--fg-muted)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span>
                {group.parentName}
                <CountSuffix count={groupCount} dim={groupCount === 0} />
              </span>
              <span
                aria-hidden
                style={{
                  fontSize: 10,
                  color: 'var(--fg-dim)',
                  transform: isOpen ? 'rotate(180deg)' : 'none',
                  transition: 'transform 0.15s ease',
                  display: 'inline-block',
                }}
              >
                ▾
              </span>
            </button>

            {isOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 8 }}>
                {group.leaves.map((cat) => (
                  <CategoryLeaf
                    key={cat.slug}
                    cat={cat}
                    displayName={leafDisplayName(cat, group.parentName)}
                    isSelected={selectedCategories.includes(cat.slug)}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CategoryLeaf({
  cat,
  displayName,
  isSelected,
  onSelect,
}: {
  cat: FilterCategory;
  /** Resolved display label — may include parent qualifier e.g. "Accessories (Auto)". */
  displayName: string;
  isSelected: boolean;
  onSelect: (slug: string | null) => void;
}) {
  // When count is 0 we dim the label so empty categories recede in the visual
  // hierarchy without disappearing. Operators may still want to know "no
  // inventory here right now" — hiding the row would erase that signal.
  const isEmpty = cat.lot_count === 0;
  const labelColor = isSelected
    ? 'var(--accent)'
    : isEmpty
      ? 'var(--fg-dim)'
      : 'var(--fg)';

  return (
    <button
      onClick={() => onSelect(cat.slug)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        background: isSelected ? 'var(--accent-dim)' : 'transparent',
        border: `1px solid ${isSelected ? 'var(--accent)' : 'transparent'}`,
        borderRadius: 6,
        padding: '0.38rem 0.6rem',
        fontSize: 13,
        fontWeight: isSelected ? 700 : 400,
        color: labelColor,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      {(() => {
        // Prefer the v3 photographic no-text thumbnail; fall back to the
        // legacy flat-leaf icon. Render as a small rounded square via
        // object-fit: cover so any aspect ratio works.
        const src = cat.image_url_clean ?? cat.icon_url;
        if (!src) return null;
        const isPhoto = cat.image_url_clean !== null;
        return (
          <span
            style={{
              position: 'relative',
              width: 28,
              height: 28,
              flexShrink: 0,
              borderRadius: 6,
              overflow: 'hidden',
              background: 'var(--bg-elev-2)',
              // Faded thumbnail for empty categories mirrors the dim label.
              opacity: isEmpty && !isSelected ? 0.5 : 1,
            }}
          >
            <Image
              src={src}
              alt=""
              fill
              style={{ objectFit: isPhoto ? 'cover' : 'contain' }}
              unoptimized
            />
          </span>
        );
      })()}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {displayName}
        <CountSuffix count={cat.lot_count} dim={isEmpty} />
      </span>
    </button>
  );
}

// ── Condition pills ───────────────────────────────────────────────────────────

function ConditionSection({
  selectedConditions,
  conditionCounts,
  onToggle,
}: {
  selectedConditions: string[];
  conditionCounts: Record<string, number>;
  onToggle: (value: string) => void;
}) {
  const selected = new Set(selectedConditions);

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {ALL_CONDITIONS.map(({ value, label }) => {
        const isActive = selected.has(value);
        const count = conditionCounts[value] ?? 0;
        const isEmpty = count === 0;
        const labelColor = isActive
          ? 'var(--accent)'
          : isEmpty
            ? 'var(--fg-dim)'
            : 'var(--fg-muted)';
        return (
          <button
            key={value}
            onClick={() => onToggle(value)}
            style={{
              padding: '0.32rem 0.75rem',
              borderRadius: 999,
              border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
              background: isActive ? 'var(--accent-dim)' : 'transparent',
              color: labelColor,
              fontSize: 12,
              fontWeight: isActive ? 700 : 400,
              cursor: 'pointer',
              transition: 'border-color 0.12s ease, background 0.12s ease',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
            <CountSuffix count={count} dim={isEmpty} />
          </button>
        );
      })}
    </div>
  );
}

// ── Price inputs ──────────────────────────────────────────────────────────────

function PriceSection({
  priceMin,
  priceMax,
  onApply,
}: {
  priceMin: number | null;
  priceMax: number | null;
  onApply: (min: number | null, max: number | null) => void;
}) {
  const [localMin, setLocalMin] = useState<string>(priceMin != null ? String(priceMin) : '');
  const [localMax, setLocalMax] = useState<string>(priceMax != null ? String(priceMax) : '');

  function handleApply() {
    const min = localMin.trim() === '' ? null : Math.max(0, parseInt(localMin, 10) || 0);
    const max = localMax.trim() === '' ? null : Math.max(0, parseInt(localMax, 10) || 0);
    onApply(min, max);
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <span
            style={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: 12,
              color: 'var(--fg-dim)',
              pointerEvents: 'none',
            }}
          >
            $
          </span>
          <input
            type="number"
            min={0}
            placeholder="Min"
            value={localMin}
            onChange={(e) => setLocalMin(e.target.value)}
            aria-label="Minimum price in dollars"
            style={{
              width: '100%',
              paddingLeft: 20,
              paddingRight: 8,
              paddingTop: 6,
              paddingBottom: 6,
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--fg)',
              fontSize: 13,
              outline: 'none',
            }}
          />
        </div>

        <span style={{ color: 'var(--fg-dim)', fontSize: 12, flexShrink: 0 }}>–</span>

        <div style={{ position: 'relative', flex: 1 }}>
          <span
            style={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: 12,
              color: 'var(--fg-dim)',
              pointerEvents: 'none',
            }}
          >
            $
          </span>
          <input
            type="number"
            min={0}
            placeholder="Max"
            value={localMax}
            onChange={(e) => setLocalMax(e.target.value)}
            aria-label="Maximum price in dollars"
            style={{
              width: '100%',
              paddingLeft: 20,
              paddingRight: 8,
              paddingTop: 6,
              paddingBottom: 6,
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--fg)',
              fontSize: 13,
              outline: 'none',
            }}
          />
        </div>
      </div>

      <button
        onClick={handleApply}
        style={{
          width: '100%',
          padding: '0.45rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          color: 'var(--fg)',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          transition: 'border-color 0.12s ease',
        }}
        className="filter-apply-btn"
      >
        Apply price
      </button>

      <style>{`
        .filter-apply-btn:hover { border-color: var(--accent); color: var(--accent); }
      `}</style>
    </div>
  );
}

// ── Sort dropdown ─────────────────────────────────────────────────────────────

function SortSection({
  sort,
  onChange,
}: {
  sort: SortOption;
  onChange: (value: SortOption) => void;
}) {
  return (
    <select
      value={sort}
      onChange={(e) => onChange(e.target.value as SortOption)}
      aria-label="Sort lots by"
      style={{
        width: '100%',
        padding: '0.5rem 0.65rem',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        color: 'var(--fg)',
        fontSize: 13,
        cursor: 'pointer',
        appearance: 'none',
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M6 8L1 3h10z' fill='%235a6276'/%3E%3C/svg%3E")`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 0.65rem center',
        paddingRight: '2rem',
      }}
    >
      {SORT_OPTIONS.map(({ value, label }) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

// ── Filter panel content ──────────────────────────────────────────────────────
// Shared between the desktop sidebar and the mobile bottom sheet.

function FilterPanelContent({
  props,
  onClose,
}: {
  props: FilterRailProps;
  onClose?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const navigate = useCallback(
    (overrides: Record<string, string | null>) => {
      // Every filter change resets pagination. buildQuery preserves current
      // params, so without this a user sitting on ?page=3 who clicks a
      // 16-lot category lands on page 3 of a 1-page result — an empty grid
      // that reads as "this category has nothing" (owner report,
      // 2026-07-04: small categories showed counts but 'nothing loads').
      const query = buildQuery(searchParams, { page: null, ...overrides });
      router.push(`${pathname}${query}`);
    },
    [router, pathname, searchParams],
  );

  // Multi-select toggle. Selecting several categories in a row is the point,
  // so the mobile sheet stays open (same as condition toggles). "All
  // categories" (slug=null) clears the whole set.
  function handleCategorySelect(slug: string | null) {
    const current = new Set(props.selectedCategories);
    if (slug === null) {
      current.clear();
    } else if (current.has(slug)) {
      current.delete(slug);
    } else {
      current.add(slug);
    }
    const next = Array.from(current).join(',');
    if (props.categoryNavigatesTo && props.categoryNavigatesTo !== pathname) {
      const query = buildQuery(searchParams, { page: null, category: next || null });
      router.push(`${props.categoryNavigatesTo}${query}`);
      onClose?.();
      return;
    }
    navigate({ category: next || null });
  }

  function handleConditionToggle(value: string) {
    const current = new Set(props.selectedConditions);
    if (current.has(value)) {
      current.delete(value);
    } else {
      current.add(value);
    }
    const next = Array.from(current).join(',');
    navigate({ condition: next || null });
  }

  function handlePriceApply(min: number | null, max: number | null) {
    navigate({
      price_min: min != null ? String(min) : null,
      price_max: max != null ? String(max) : null,
    });
    onClose?.();
  }

  function handleSortChange(value: SortOption) {
    navigate({ sort: value });
  }

  function handleClearAll() {
    router.push(pathname);
    onClose?.();
  }

  const hasActiveFilters =
    props.selectedCategories.length > 0 ||
    props.selectedConditions.length > 0 ||
    props.priceMin !== null ||
    props.priceMax !== null ||
    props.sort !== 'ending-soon';

  return (
    <div>
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '1.25rem',
        }}
      >
        <span style={{ fontWeight: 800, fontSize: '0.95rem' }}>Filters</span>
        {hasActiveFilters && (
          <button
            onClick={handleClearAll}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--accent)',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            Clear all
          </button>
        )}
      </div>

      {/* Category */}
      {props.categories.length > 0 && (
        <div style={{ marginBottom: '1.5rem' }}>
          <SectionLabel>Category</SectionLabel>
          <CategoryAccordion
            categories={props.categories}
            selectedCategories={props.selectedCategories}
            onSelect={handleCategorySelect}
          />
        </div>
      )}

      {/* Condition */}
      <div style={{ marginBottom: '1.5rem' }}>
        <SectionLabel>Condition</SectionLabel>
        <ConditionSection
          selectedConditions={props.selectedConditions}
          conditionCounts={props.conditionCounts}
          onToggle={handleConditionToggle}
        />
      </div>

      {/* Price */}
      <div style={{ marginBottom: '1.5rem' }}>
        <SectionLabel>Price</SectionLabel>
        <PriceSection
          priceMin={props.priceMin}
          priceMax={props.priceMax}
          onApply={handlePriceApply}
        />
      </div>

      {/* Sort */}
      <div>
        <SectionLabel>Sort by</SectionLabel>
        <SortSection sort={props.sort} onChange={handleSortChange} />
      </div>
    </div>
  );
}

// ── Mobile bottom sheet ───────────────────────────────────────────────────────

function MobileFilterSheet({
  props,
  isOpen,
  onClose,
}: {
  props: FilterRailProps;
  isOpen: boolean;
  onClose: () => void;
}) {
  // How far down the handle must be dragged before the sheet dismisses.
  const SWIPE_CLOSE_PX = 80;
  const [dragY, setDragY] = useState(0);
  const dragStartY = useRef<number | null>(null);

  // MOB-01 — Freeze the page behind the sheet.
  //
  // Reported as "dragging moves the page behind it". Before this, the file
  // had no useEffect at all and nothing locked the body, so a touch-drag
  // anywhere over the backdrop scrolled the document underneath: the user
  // lost their place in the grid just by trying to dismiss the sheet.
  // Cleanup restores the prior value rather than hardcoding '' — /browse
  // mounts TWO FilterRail instances (mobile trigger + desktop sidebar), and
  // blindly clearing on unmount could unlock while the other still wants it.
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  // MOB-01 — Make the Android/phone Back gesture close the sheet.
  //
  // Reported as "the phone Back action exits without reliably applying the
  // selection". `mobileOpen` was React state with no history entry, so Back
  // popped the PAGE — the customer left the storefront entirely and their
  // filters appeared to have done nothing. Push a state entry on open and
  // close on popstate instead. On close-by-any-other-means we go() back to
  // consume our own entry, so Back doesn't need two presses afterwards.
  useEffect(() => {
    if (!isOpen) return;
    window.history.pushState({ filterSheet: true }, '');
    const onPop = () => onClose();
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (window.history.state?.filterSheet) window.history.back();
    };
  }, [isOpen, onClose]);

  // Escape closes, matching every other modal on the web.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Reset any in-progress drag whenever the sheet reopens.
  useEffect(() => {
    if (!isOpen) {
      setDragY(0);
      dragStartY.current = null;
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(10,12,17,0.72)',
          zIndex: 80,
        }}
      />

      {/* Sheet */}
      <div
        role="dialog"
        aria-modal
        aria-label="Filters"
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 81,
          background: 'var(--bg-elev)',
          borderTop: '1px solid var(--border)',
          borderRadius: '18px 18px 0 0',
          padding: '1.25rem 1.25rem 2.5rem',
          maxHeight: '82vh',
          overflowY: 'auto',
          transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
          transition: dragStartY.current === null ? 'transform 160ms ease' : undefined,
        }}
      >
        {/* MOB-01 — the handle is now a REAL close control.
            It was an aria-hidden decorative div: it LOOKED draggable, so
            people tried to drag it, nothing happened, and the sheet read as
            "stuck open". Rather than remove the affordance people already
            reach for, honour it — drag down past SWIPE_CLOSE_PX to dismiss,
            or just tap it. As a <button> it's reachable by keyboard and
            screen reader too, which the div never was. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close filters"
          onTouchStart={(e) => {
            // touches[0] is undefined under noUncheckedIndexedAccess, and can
            // genuinely be absent on a cancelled gesture.
            const t = e.touches[0];
            if (t) dragStartY.current = t.clientY;
          }}
          onTouchMove={(e) => {
            const start = dragStartY.current;
            const t = e.touches[0];
            if (start === null || !t) return;
            // Only track downward movement; dragging up shouldn't lift the
            // sheet off the bottom edge.
            setDragY(Math.max(0, t.clientY - start));
          }}
          onTouchEnd={() => {
            const shouldClose = dragY > SWIPE_CLOSE_PX;
            dragStartY.current = null;
            setDragY(0);
            if (shouldClose) onClose();
          }}
          style={{
            display: 'block',
            width: '100%',
            background: 'transparent',
            border: 'none',
            padding: '0 0 1.25rem',
            cursor: 'pointer',
            touchAction: 'none',
          }}
        >
          <span
            aria-hidden
            style={{
              display: 'block',
              width: 40,
              height: 4,
              borderRadius: 2,
              background: 'var(--border)',
              margin: '0 auto',
            }}
          />
        </button>

        <FilterPanelContent props={props} onClose={onClose} />

        <SheetFooter resultCount={props.resultCount} onClose={onClose} />
      </div>
    </>
  );
}

/**
 * MOB-01 — the sheet's footer button, and the fix for the actual complaint.
 *
 * The count is the point. A phone user tapping "Babies & Kids (2)" gets no
 * signal that anything happened, because the sheet covers the grid that just
 * re-rendered. A number that ticks as they tap IS the proof the filter works.
 *
 * Zero is handled as its own state rather than shipping "Show 0 results",
 * which invites a tap and delivers an empty grid — a dead end. Bin-store
 * inventory turns over fast, so empty categories are ordinary, not an edge
 * case. The button disables and says so.
 */
function SheetFooter({
  resultCount,
  onClose,
}: {
  resultCount?: number;
  onClose: () => void;
}) {
  const empty = isFilterSheetEmpty(resultCount);
  const label = filterSheetLabel(resultCount);

  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        marginTop: '1.5rem',
        // Bleed over the sheet's own padding so the bar spans edge to edge.
        marginInline: '-1.25rem',
        marginBottom: '-2.5rem',
        padding: '0.85rem 1.25rem 1.6rem',
        background: 'var(--bg-elev)',
        borderTop: '1px solid var(--border)',
      }}
    >
      <button
        type="button"
        onClick={onClose}
        disabled={empty}
        style={{
          width: '100%',
          padding: '0.85rem 1rem',
          borderRadius: 10,
          border: 'none',
          background: empty ? 'var(--border)' : 'var(--accent)',
          color: empty ? 'var(--fg-muted)' : '#000',
          fontSize: 15,
          fontWeight: 800,
          cursor: empty ? 'not-allowed' : 'pointer',
        }}
      >
        {label}
      </button>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function FilterRail(props: FilterRailProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const activeCount =
    props.selectedCategories.length +
    props.selectedConditions.length +
    (props.priceMin !== null ? 1 : 0) +
    (props.priceMax !== null ? 1 : 0);

  return (
    <>
      {/* Desktop sidebar — hidden on mobile */}
      <aside
        className="filter-rail-desktop"
        style={{
          display: 'none', // overridden by media query below
          position: 'sticky',
          top: 72, // below the public nav (56px) + buffer
          alignSelf: 'flex-start',
          maxHeight: 'calc(100vh - 80px)',
          overflowY: 'auto',
          padding: '1rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          scrollbarWidth: 'thin',
          minWidth: 220,
          maxWidth: 260,
          width: '100%',
        }}
      >
        <FilterPanelContent props={props} />
      </aside>

      {/* Mobile trigger button — visible only on mobile */}
      <div className="filter-rail-mobile-trigger">
        <button
          onClick={() => setMobileOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={mobileOpen}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '0.55rem 1.1rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            color: 'var(--fg)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <span aria-hidden>&#9776;</span>
          Filters
          {activeCount > 0 && (
            <span
              style={{
                background: 'var(--accent)',
                color: '#000',
                borderRadius: 999,
                fontSize: 10,
                fontWeight: 900,
                minWidth: 18,
                height: 18,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 4px',
              }}
            >
              {activeCount}
            </span>
          )}
        </button>
      </div>

      {/* Mobile bottom sheet */}
      <MobileFilterSheet
        props={props}
        isOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />

      {/* Responsive visibility rules */}
      <style>{`
        .filter-rail-desktop { display: none !important; }
        .filter-rail-mobile-trigger { display: block; }
        @media (min-width: 769px) {
          .filter-rail-desktop { display: block !important; }
          .filter-rail-mobile-trigger { display: none !important; }
        }
      `}</style>
    </>
  );
}
