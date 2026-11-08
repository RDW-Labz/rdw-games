'use client';

/**
 * AccountMenu — WEB-NAV. Replaces the single "My account" link in the
 * (public) nav for signed-in bidders with a compact dropdown.
 *
 * Why a dropdown, not top-level links: the (public) nav has a documented
 * 390px width budget (iPhone 14) — the auth cluster is flexShrink:0, so
 * every always-on link pushes the nav past the viewport (see the layout's
 * overflow-guard comment ~128-134). A dropdown surfaces Watch List / Winning
 * / My Bids / Past wins / Pickup / Receipts behind ONE trigger button, so the
 * nav footprint is identical to the old single "My account" link at every
 * breakpoint. No new always-on buttons.
 *
 * The trigger is the same .btn-secondary chip the old link used; the panel
 * is absolutely positioned and does not participate in the nav row's flex
 * width, so it can't bust the budget.
 *
 * Accessibility: button[aria-haspopup][aria-expanded] toggles a menu;
 * Escape + click-outside close it; route change closes it (usePathname).
 * Items are plain <Link>s so they work without JS once rendered (the panel
 * just needs the toggle).
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Item = { href: string; label: string; hint?: string };

// Order mirrors the bidder app's tab priority: live-bidding surfaces first
// (Watch List, Winning, My Bids), then history/fulfillment (Past wins,
// Pickup, Receipts). "Winning" is the leading subset of My Bids — same as
// the mobile "Leading" pill — so it deep-links into the filtered list, NOT
// a separate page.
const ITEMS: Item[] = [
  { href: '/profile/watchlist', label: 'Watch List' },
  { href: '/profile/my-bids?f=leading', label: 'Winning', hint: 'Lots you’re leading' },
  { href: '/profile/my-bids', label: 'My Bids' },
  // /profile/notifications shipped in S14 but no nav ever linked it — the
  // owner couldn't find "somewhere so people know they're outbid or won"
  // (2026-07-08) even though the page existed the whole time.
  { href: '/profile/notifications', label: 'Notifications', hint: 'Outbid, won & payment alerts' },
  { href: '/profile/past-wins', label: 'Past wins' },
  { href: '/profile/pickup', label: 'Pickup' },
  { href: '/profile/invoices', label: 'Receipts' },
];

export function AccountMenu({ isOperator }: { isOperator: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // Close on route change so a navigation collapses the menu.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on Escape + outside click while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onPointer(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        className="btn-secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: '0.45rem 1rem',
          fontSize: 13,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
        }}
      >
        Account
        <span
          aria-hidden
          style={{
            fontSize: 9,
            lineHeight: 1,
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.12s ease',
          }}
        >
          &#9660;
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            minWidth: 200,
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
            padding: '0.4rem',
            zIndex: 60,
          }}
        >
          {/* Account home — the full profile dashboard. */}
          <MenuLink href="/profile" label="My account" emphasis />

          <div
            style={{
              height: 1,
              background: 'var(--border)',
              margin: '0.35rem 0.25rem',
            }}
          />

          {ITEMS.map((it) => (
            <MenuLink key={it.href} href={it.href} label={it.label} hint={it.hint} />
          ))}

          {isOperator && (
            <>
              <div
                style={{
                  height: 1,
                  background: 'var(--border)',
                  margin: '0.35rem 0.25rem',
                }}
              />
              <MenuLink href="/dashboard" label="Operator console" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuLink({
  href,
  label,
  hint,
  emphasis,
}: {
  href: string;
  label: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <Link
      href={href}
      role="menuitem"
      style={{
        display: 'block',
        padding: '0.5rem 0.6rem',
        borderRadius: 7,
        textDecoration: 'none',
        color: 'var(--fg)',
        fontSize: 14,
        fontWeight: emphasis ? 700 : 500,
        lineHeight: 1.3,
      }}
    >
      {label}
      {hint && (
        <span
          style={{
            display: 'block',
            fontSize: 11,
            color: 'var(--fg-muted)',
            fontWeight: 400,
            marginTop: 1,
          }}
        >
          {hint}
        </span>
      )}
    </Link>
  );
}
