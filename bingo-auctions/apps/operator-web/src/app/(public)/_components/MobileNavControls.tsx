'use client';

/**
 * MobileNavControls — W1 + W2 mobile-web discovery pack.
 *
 * Renders two icon buttons visible only on small screens (CSS-controlled via
 * .public-nav-mobile-controls in the public layout <style> block):
 *
 *   1. Hamburger (☰) — opens the existing CategoryMegaMenuClient drawer.
 *      The drawer is already fully built for mobile (full-screen accordion)
 *      but was previously unreachable because its wrapper was CSS-hidden on
 *      phones. Groups are passed down from the server layout (same data fetch
 *      as the desktop mega-menu — no extra DB hit).
 *
 *   2. Search icon — toggles an inline SearchBar below the nav bar.
 *      The SearchBar already exists and is fully functional; it was only
 *      CSS-hidden on phones via .public-nav-search { display:none }.
 *      Hidden again once ≥640px (desktop bar takes over) via
 *      .public-nav-mobile-search-btn { display:none } in layout CSS.
 *
 * No new dependencies. Reuses SearchBar + CategoryMegaMenuClient directly.
 */

import Link from 'next/link';
import { useState, useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { SearchBar } from './SearchBar';
import { CategoryMegaMenuClient } from './CategoryMegaMenuClient';
import type { CategoryGroup } from './CategoryMegaMenu';

interface MobileNavControlsProps {
  categoryGroups: CategoryGroup[];
  /** Lots closing within the Final Call window right now. Drives the pulsing
   *  dot; the link renders (dimmed) even at 0 so phone users can FIND the
   *  page — before 2026-07-07 Final Call was desktop-nav-only and the owner
   *  couldn't locate it on mobile. */
  finalCallCount: number;
}

export function MobileNavControls({ categoryGroups, finalCallCount }: MobileNavControlsProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();
  const searchPanelRef = useRef<HTMLDivElement>(null);

  // Close both panels on route change
  useEffect(() => {
    setSearchOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  // Focus the search input when panel opens
  useEffect(() => {
    if (searchOpen) {
      const input = searchPanelRef.current?.querySelector('input');
      if (input) {
        setTimeout(() => (input as HTMLInputElement).focus(), 80);
      }
    }
  }, [searchOpen]);

  return (
    <>
      {/* ── Icon button row ── */}
      <div className="public-nav-mobile-controls">
        {/* Final Call — same semantics as the desktop link: red + pulsing dot
            while lots are closing, dimmed otherwise, always tappable.
            On narrow phones (<480px) the text label collapses to a timer
            glyph (CSS: .public-nav-mobile-fc-*): the full label pushed the
            390px iPhone-14 nav row to 438px scrollWidth (audit-fixes e2e
            "no horizontal scroll", threshold 400 — failed 2026-07-07). */}
        <Link
          href="/final-call?from=nav"
          aria-label={
            finalCallCount > 0
              ? `Final Call — ${finalCallCount} lots closing in under 2 minutes`
              : 'Final Call — no lots in the rush right now'
          }
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 5,
            color: 'var(--urgent-red)',
            textDecoration: 'none',
            fontWeight: 800,
            fontSize: 12,
            letterSpacing: 0.3,
            opacity: finalCallCount > 0 ? 1 : 0.5,
            padding: '0.35rem 0.4rem',
            flexShrink: 0,
            minHeight: 36,
          }}
        >
          {finalCallCount > 0 && (
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--urgent-red)',
                animation: 'final-call-nav-pulse 1.5s ease-in-out infinite',
              }}
            />
          )}
          <span aria-hidden className="public-nav-mobile-fc-icon" style={{ fontSize: 16, lineHeight: 1 }}>
            &#9201;
          </span>
          <span className="public-nav-mobile-fc-label">Final Call</span>
        </Link>

        {/* W2: hamburger — opens category drawer */}
        <button
          type="button"
          aria-label="Browse all categories"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((v) => !v);
            setSearchOpen(false);
          }}
          style={iconBtnStyle}
        >
          <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>&#9776;</span>
        </button>

        {/* W1: search icon — reveals inline SearchBar panel */}
        <button
          type="button"
          aria-label={searchOpen ? 'Close search' : 'Search lots and categories'}
          aria-expanded={searchOpen}
          className="public-nav-mobile-search-btn"
          onClick={() => {
            setSearchOpen((v) => !v);
            setMenuOpen(false);
          }}
          style={iconBtnStyle}
        >
          <span aria-hidden style={{ fontSize: 16, lineHeight: 1 }}>&#128269;</span>
        </button>
      </div>

      {/* ── W1: inline search panel (drops below the 56px nav bar) ── */}
      {searchOpen && (
        <div
          ref={searchPanelRef}
          style={{
            position: 'fixed',
            top: 56,
            left: 0,
            right: 0,
            zIndex: 49,
            background: 'rgba(10, 12, 17, 0.97)',
            borderBottom: '1px solid var(--border)',
            padding: '0.65rem 0.75rem',
            backdropFilter: 'blur(12px)',
          }}
        >
          <SearchBar />
        </div>
      )}

      {/* ── W2: CategoryMegaMenuClient — mobile-only instance ── */}
      {/* Rendered only while open; categories are pre-fetched by the server
          layout (same query as the desktop mega-menu — zero extra DB hit). */}
      {menuOpen && (
        <MobileMenuPortal
          groups={categoryGroups}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </>
  );
}

/**
 * MobileMenuPortal — renders CategoryMegaMenuClient in its open state for
 * the mobile hamburger trigger.
 *
 * CategoryMegaMenuClient owns its own `open` boolean. To open it immediately
 * on mount (bypassing the user clicking its internal trigger button), we
 * locate the trigger via ref and click it once after mount. A MutationObserver
 * on aria-expanded propagates close back up to the parent so the portal
 * unmounts when the user closes the drawer (Esc, ×, route change).
 */
function MobileMenuPortal({
  groups,
  onClose,
}: {
  groups: CategoryGroup[];
  onClose: () => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Open the drawer immediately on mount by clicking CategoryMegaMenuClient's
  // internal trigger button.
  useEffect(() => {
    const btn = wrapperRef.current?.querySelector<HTMLButtonElement>(
      'button[aria-controls="mega-menu-panel"]',
    );
    btn?.click();
  }, []);

  // Propagate close back to parent when the component's drawer closes itself.
  useEffect(() => {
    const btn = wrapperRef.current?.querySelector(
      'button[aria-controls="mega-menu-panel"]',
    );
    if (!btn) return;
    const observer = new MutationObserver(() => {
      if (btn.getAttribute('aria-expanded') === 'false') {
        onClose();
      }
    });
    observer.observe(btn, { attributes: true, attributeFilter: ['aria-expanded'] });
    return () => observer.disconnect();
  }, [onClose]);

  return (
    <div ref={wrapperRef} style={{ position: 'fixed', zIndex: 98, top: 0, left: 0 }}>
      <CategoryMegaMenuClient groups={groups} />
    </div>
  );
}

// ── Shared icon button style ─────────────────────────────────────────────────

const iconBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--fg-muted)',
  padding: '0.35rem 0.5rem',
  cursor: 'pointer',
  lineHeight: 1,
  flexShrink: 0,
  minWidth: 36,
  minHeight: 36,
};
