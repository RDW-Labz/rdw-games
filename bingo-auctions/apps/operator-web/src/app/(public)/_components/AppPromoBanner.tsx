'use client';

/**
 * AppPromoBanner — sticky-ish promo strip on the bidder homepage.
 *
 * Renders ONLY on the homepage (the parent page.tsx places it there) and
 * only when the user hasn't dismissed it in the last 7 days. Dismissal is
 * stored in localStorage as a UTC ISO timestamp:
 *
 *   key:  `app_banner_dismissed_until`
 *   val:  ISO8601 string — when the banner should reappear
 *
 * Why client-side: SSR can't read localStorage, so we render hidden by
 * default (display: none) and reveal in a useEffect once we know the
 * dismissal state. That avoids a flash of the banner for users who've
 * already dismissed it.
 *
 * Position: NOT `position: sticky` — that would compete with the nav's
 * own sticky behavior and make the banner stack awkwardly during scroll.
 * Instead the banner is just a normal in-flow strip directly under the
 * nav. The "always-visible at top" feel comes from the nav being sticky
 * and the banner being the next thing the user sees.
 *
 * Why no app store IDs: both CTAs link to /download, which shows the App
 * Store and Play badges together. Store URLs live in lib/app-links — this
 * banner deliberately holds none of its own. (The header used to say
 * "TestFlight only"; both apps have been live for months.)
 *
 * MAC.BID parity note: their iOS app is a wrapped webview with no real
 * push (silent SMS instead) and no warehouse map. Our differentiators
 * (outbid push, QR scan, AR pickup map) are listed in the supporting
 * line; mobile drops that line to save vertical space.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

// ── Constants ────────────────────────────────────────────────────────────────

const DISMISS_KEY = 'app_banner_dismissed_until';
const DISMISS_DAYS = 7;

// ── Component ────────────────────────────────────────────────────────────────

export function AppPromoBanner() {
  // Start hidden — we don't know dismissal state until after hydration.
  // (Rendering visible would cause a layout flash for repeat dismissers.)
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const until = window.localStorage.getItem(DISMISS_KEY);
      if (!until) {
        setVisible(true);
        return;
      }
      const untilMs = Date.parse(until);
      // Invalid value or expired → show again. Otherwise stay hidden.
      if (!Number.isFinite(untilMs) || untilMs < Date.now()) {
        setVisible(true);
      }
    } catch {
      // localStorage can throw in some private-browsing modes — treat as
      // "first visit" and show.
      setVisible(true);
    }
  }, []);

  function dismiss() {
    try {
      const until = new Date(
        Date.now() + DISMISS_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      window.localStorage.setItem(DISMISS_KEY, until);
    } catch {
      // Even if we can't persist, the user gets the in-session dismissal
      // they wanted.
    }
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="Get the BinGo Auctions mobile app"
      style={{
        background: 'var(--accent-dim)',
        borderBottom: '1px solid var(--accent)',
        position: 'relative',
        // No `position: sticky` here — see file header for rationale.
      }}
      className="app-promo-banner"
    >
      <div
        style={{
          maxWidth: 1100,
          margin: '0 auto',
          padding: '0 1rem 0 1.25rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.9rem',
          minHeight: 56,
        }}
        className="app-promo-banner-inner"
      >
        {/* Icon */}
        <span
          aria-hidden
          style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}
        >
          {'\u{1F4F1}'}
        </span>

        {/* Copy */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 800,
              color: 'var(--fg)',
              letterSpacing: -0.2,
              lineHeight: 1.2,
            }}
          >
            Bid from your phone.
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--fg-muted)',
              lineHeight: 1.3,
              marginTop: 2,
            }}
            className="app-promo-banner-sub"
          >
            Push outbid alerts, in-warehouse QR scan, AR pickup maps.
          </div>
        </div>

        {/* CTAs */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexShrink: 0,
          }}
          className="app-promo-banner-ctas"
        >
          {/* Shared buttons at the small size. These were hand-rolled with a
              hardcoded #0a0c11 fill — a near-black that is not in the palette
              and does not follow the theme. */}
          <Link
            href="/download"
            aria-label="Get the iOS app"
            className="btn-dark btn-sm btn-icon"
            style={{ whiteSpace: 'nowrap' }}
          >
            <span aria-hidden style={{ fontSize: 13 }}>{'\u{1F34F}'}</span>
            iOS
          </Link>
          <Link
            href="/download"
            aria-label="Get on Android"
            className="btn-dark btn-sm btn-icon"
            style={{ whiteSpace: 'nowrap' }}
          >
            <span aria-hidden style={{ fontSize: 13 }}>{'\u{1F916}'}</span>
            Android
          </Link>
        </div>

        {/* Dismiss */}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss app promo for a week"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--fg-muted)',
            cursor: 'pointer',
            fontSize: 20,
            lineHeight: 1,
            padding: '4px 6px',
            flexShrink: 0,
            // Bigger hit area on touch
            minWidth: 32,
            minHeight: 32,
          }}
        >
          {'×'}
        </button>
      </div>

      <style>{`
        /* Mobile — stack CTAs vertically, drop the supporting line, taller. */
        @media (max-width: 640px) {
          .app-promo-banner-inner   { min-height: 88px; flex-wrap: wrap; gap: 0.6rem; padding: 10px 14px !important; }
          .app-promo-banner-sub     { display: none; }
          .app-promo-banner-ctas    { width: 100%; }
          .app-promo-banner-ctas a  { flex: 1; justify-content: center; }
        }
      `}</style>
    </div>
  );
}
