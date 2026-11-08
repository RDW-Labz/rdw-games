'use client';

/**
 * CategoryMegaMenuClient — interactive half of the CategoryMegaMenu.
 *
 * Receives fully-typed category data from the server component parent and
 * renders the trigger button + dropdown/drawer UI. No data fetching here.
 *
 * State management:
 *   - `open`: dropdown/drawer visibility
 *   - `expandedParentId`: which parent accordion item is expanded (mobile)
 *
 * Accessibility:
 *   - Trigger button uses aria-expanded / aria-controls
 *   - Dropdown is role="dialog" on mobile, role="region" on desktop
 *   - Esc closes from anywhere; click-outside closes on desktop
 */

import Link from 'next/link';
import { useEffect, useRef, useState, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import type { CategoryGroup, CategoryItem } from './CategoryMegaMenu';

// ── Props ─────────────────────────────────────────────────────────────────────

interface CategoryMegaMenuClientProps {
  groups: CategoryGroup[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pick the best thumbnail source for the mega-menu row.
 *  1. v3 no-text photo (image_url_clean) — preferred, photographic, on-brand.
 *  2. Legacy /05_CATEGORY_ICONS/ icon_url — flat-leaf fallback.
 *  3. None — render the text row with no thumbnail (every consumer guards on
 *     a null src). We never fall back to the legacy CDN, and we drop
 *     any DB value still pointing at it, so there's zero external CDN request. */
function categoryIconSrc(item: CategoryItem): string | null {
  const src = item.image_url_clean ?? item.icon_url ?? null;
  if (src && !src.includes('clovrbid')) return src;
  return null;
}

/** True when the thumbnail source is a v3 photo (use object-fit:cover);
 *  false when it's a legacy icon PNG (use object-fit:contain). */
function isPhotoThumbnail(item: CategoryItem): boolean {
  return item.image_url_clean !== null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CategoryMegaMenuClient({ groups }: CategoryMegaMenuClientProps) {
  const [open, setOpen] = useState(false);
  const [expandedParentId, setExpandedParentId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  const close = useCallback(() => {
    setOpen(false);
    setExpandedParentId(null);
  }, []);

  // 2026-05-22: close on route change. The mega-menu lives in the public
  // layout, which doesn't unmount on intra-route navigation. Without this
  // watcher, clicking a category opens the new /category/[slug] page but
  // the drawer stays mounted+open over it on mobile — the user sees two
  // overlapping stacks of categories. The onClick={close} on links is a
  // synchronous best-effort; this is the belt-and-suspenders backup that
  // also catches programmatic navigation, back-button, etc.
  useEffect(() => {
    close();
  }, [pathname, close]);

  // Close on Esc key
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Close on click outside (desktop)
  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    }
    // Use capture phase so we catch clicks that stop propagation inside the panel.
    document.addEventListener('mousedown', onPointer, true);
    return () => document.removeEventListener('mousedown', onPointer, true);
  }, [open, close]);

  // Prevent body scroll when mobile drawer is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {/* ── Trigger button ── */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mega-menu-panel"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 999,
          color: 'var(--fg-muted)',
          padding: '0.4rem 0.85rem',
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          transition: 'border-color 0.12s ease, color 0.12s ease',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--fg)';
          (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--fg-muted)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--fg-muted)';
          (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
        }}
      >
        <span>All categories</span>
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.18s ease',
            fontSize: 10,
            lineHeight: 1,
          }}
        >
          &#9660;
        </span>
      </button>

      {/* ── Desktop dropdown panel ── */}
      {open && (
        <>
          {/* Mobile overlay backdrop */}
          <div
            aria-hidden
            onClick={close}
            className="mega-menu-backdrop"
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.6)',
              zIndex: 98,
            }}
          />

          {/* Panel — desktop: dropdown attached to nav; mobile: full-screen drawer */}
          <div
            id="mega-menu-panel"
            role="region"
            aria-label="All categories"
            className="mega-menu-panel"
            style={{
              position: 'fixed',
              zIndex: 99,
              background: 'var(--bg-elev-2, #13161e)',
              border: '1px solid var(--border)',
              overflowY: 'auto',
            }}
          >
            {/* Mobile: close button */}
            <div className="mega-menu-mobile-header">
              <span style={{ fontWeight: 800, fontSize: '1rem', color: 'var(--fg)' }}>
                All categories
              </span>
              <button
                type="button"
                onClick={close}
                aria-label="Close categories menu"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--fg-muted)',
                  fontSize: 22,
                  cursor: 'pointer',
                  lineHeight: 1,
                  padding: '0.25rem',
                }}
              >
                &#x2715;
              </button>
            </div>

            {/* Desktop: column grid; Mobile: accordion */}
            <div className="mega-menu-desktop-grid">
              {groups.map((group) => (
                <DesktopColumn key={group.parent.id} group={group} onNavigate={close} />
              ))}
            </div>

            <div className="mega-menu-mobile-accordion">
              {groups.map((group) => (
                <MobileAccordionItem
                  key={group.parent.id}
                  group={group}
                  isExpanded={expandedParentId === group.parent.id}
                  onToggle={() =>
                    setExpandedParentId((prev) =>
                      prev === group.parent.id ? null : group.parent.id,
                    )
                  }
                  onNavigate={close}
                />
              ))}
            </div>
          </div>
        </>
      )}

      <style>{`
        /* ── Mobile: full-screen drawer ───────────────────── */
        .mega-menu-panel {
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          border-radius: 0;
          padding: 0;
        }
        .mega-menu-backdrop { display: block; }
        .mega-menu-mobile-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 1rem 1.25rem;
          border-bottom: 1px solid var(--border);
          position: sticky;
          top: 0;
          background: var(--bg-elev-2, #13161e);
          z-index: 1;
        }
        .mega-menu-desktop-grid { display: none; }
        .mega-menu-mobile-accordion { display: block; }

        /* ── Desktop: positioned dropdown ─────────────────── */
        @media (min-width: 768px) {
          .mega-menu-panel {
            position: fixed;
            top: 58px; /* just below the 56px header */
            left: 50%;
            transform: translateX(-50%);
            width: min(1100px, 95vw);
            bottom: auto;
            right: auto;
            border-radius: 12px;
            padding: 1.5rem;
            max-height: calc(100vh - 80px);
          }
          .mega-menu-backdrop { display: none; }
          .mega-menu-mobile-header { display: none; }
          .mega-menu-desktop-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
            gap: 0.25rem 1.5rem;
          }
          .mega-menu-mobile-accordion { display: none; }
        }
      `}</style>
    </div>
  );
}

// ── Desktop column ─────────────────────────────────────────────────────────────

function DesktopColumn({
  group,
  onNavigate,
}: {
  group: CategoryGroup;
  onNavigate: () => void;
}) {
  const iconSrc = categoryIconSrc(group.parent);
  const isPhoto = isPhotoThumbnail(group.parent);

  return (
    <div style={{ marginBottom: '1.25rem' }}>
      {/* Parent header — links to parent category page */}
      <Link
        href={`/category/${group.parent.slug}`}
        onClick={onNavigate}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          textDecoration: 'none',
          marginBottom: '0.5rem',
          padding: '0.2rem 0',
        }}
      >
        {iconSrc && (
          <img
            src={iconSrc}
            alt=""
            width={24}
            height={24}
            style={{
              objectFit: isPhoto ? 'cover' : 'contain',
              flexShrink: 0,
              opacity: isPhoto ? 1 : 0.85,
              borderRadius: isPhoto ? 5 : 0,
              background: isPhoto ? 'var(--bg-elev-2)' : 'transparent',
            }}
          />
        )}
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 1.5,
            textTransform: 'uppercase',
            color: 'var(--fg)',
          }}
        >
          {group.parent.name}
        </span>
      </Link>

      {/* Leaf items */}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {group.leaves.map((leaf) => (
          <li key={leaf.id}>
            <LeafLink item={leaf} onNavigate={onNavigate} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Mobile accordion item ─────────────────────────────────────────────────────

function MobileAccordionItem({
  group,
  isExpanded,
  onToggle,
  onNavigate,
}: {
  group: CategoryGroup;
  isExpanded: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  const iconSrc = categoryIconSrc(group.parent);
  const isPhoto = isPhotoThumbnail(group.parent);

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      {/* Accordion trigger row */}
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: '0.9rem 1.25rem',
          cursor: 'pointer',
          textAlign: 'left',
          gap: 8,
        }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          {iconSrc && (
            <img
              src={iconSrc}
              alt=""
              width={32}
              height={32}
              style={{
                objectFit: isPhoto ? 'cover' : 'contain',
                flexShrink: 0,
                opacity: isPhoto ? 1 : 0.85,
                borderRadius: isPhoto ? 6 : 0,
                background: isPhoto ? 'var(--bg-elev-2)' : 'transparent',
              }}
            />
          )}
          <span
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: 'var(--fg)',
            }}
          >
            {group.parent.name}
          </span>
          {group.leaves.length > 0 && (
            <span
              style={{
                fontSize: 11,
                color: 'var(--fg-muted)',
                fontWeight: 500,
              }}
            >
              ({group.leaves.length})
            </span>
          )}
        </span>
        <span
          aria-hidden
          style={{
            fontSize: 10,
            color: 'var(--fg-muted)',
            transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s ease',
            flexShrink: 0,
          }}
        >
          &#9660;
        </span>
      </button>

      {/* Parent-level link (shown when expanded) */}
      {isExpanded && (
        <div style={{ padding: '0 1.25rem 0.75rem' }}>
          <Link
            href={`/category/${group.parent.slug}`}
            onClick={onNavigate}
            style={{
              display: 'block',
              fontSize: 13,
              color: 'var(--accent)',
              textDecoration: 'none',
              padding: '0.35rem 0',
              fontWeight: 600,
            }}
          >
            Browse all {group.parent.name} &rarr;
          </Link>

          {/* Leaf list */}
          <ul style={{ listStyle: 'none', margin: '0.25rem 0 0', padding: 0 }}>
            {group.leaves.map((leaf) => (
              <li key={leaf.id}>
                <LeafLink item={leaf} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Shared leaf link ──────────────────────────────────────────────────────────

function LeafLink({ item, onNavigate }: { item: CategoryItem; onNavigate: () => void }) {
  const iconSrc = categoryIconSrc(item);
  const isPhoto = isPhotoThumbnail(item);

  return (
    <Link
      href={`/category/${item.slug}`}
      onClick={onNavigate}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        textDecoration: 'none',
        padding: '0.28rem 0',
        fontSize: 13,
        color: 'var(--fg-muted)',
        transition: 'color 0.1s ease',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.color = 'var(--fg)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLAnchorElement).style.color = 'var(--fg-muted)';
      }}
    >
      {iconSrc && (
        <img
          src={iconSrc}
          alt=""
          width={22}
          height={22}
          style={{
            objectFit: isPhoto ? 'cover' : 'contain',
            flexShrink: 0,
            opacity: isPhoto ? 0.95 : 0.7,
            borderRadius: isPhoto ? 4 : 0,
            background: isPhoto ? 'var(--bg-elev-2)' : 'transparent',
          }}
        />
      )}
      <span>{item.name}</span>
    </Link>
  );
}
