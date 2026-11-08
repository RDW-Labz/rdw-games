'use client';

// One-time welcome banner — shown on the first dashboard visit, explains
// the three apps that make up the BinGo Auctions ecosystem, then disappears
// after the operator dismisses it.
//
// Dismiss state lives in localStorage keyed by operatorId so a single user
// who admins multiple operators sees the banner once per operator. (If
// they switch devices they'll see it again on the new device — that's
// fine for a one-time orientation message.)

import { useEffect, useState } from 'react';

// 2026-05-21: renamed from `bidwizops:welcome-dismissed:` as part of the
// brand rename to BinGo Auctions. Operators who saw the old banner under the
// previous key will see it once more (acceptable one-time UX cost).
const STORAGE_PREFIX = 'clovrbid:welcome-dismissed:';

export function WelcomeBanner({
  operatorId,
  businessName,
  fieldAppUrl,
  bidderAppUrl,
}: {
  operatorId: string;
  businessName: string;
  fieldAppUrl: string | null;
  bidderAppUrl: string | null;
}) {
  // Start hidden; only render after hydration confirms localStorage state.
  // Prevents the flash-of-banner that would happen if we rendered on the
  // server and then unmounted client-side.
  const [hydrated, setHydrated] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(localStorage.getItem(STORAGE_PREFIX + operatorId) === '1');
    setHydrated(true);
  }, [operatorId]);

  function dismiss(): void {
    localStorage.setItem(STORAGE_PREFIX + operatorId, '1');
    setDismissed(true);
  }

  if (!hydrated || dismissed) return null;

  return (
    <section
      style={{
        marginBottom: '1.5rem',
        padding: '1.25rem 1.5rem',
        background: 'linear-gradient(135deg, rgba(79, 140, 255, 0.10), rgba(79, 140, 255, 0.03))',
        border: '1px solid rgba(79, 140, 255, 0.35)',
        borderRadius: 10,
        position: 'relative',
      }}
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          width: 28,
          height: 28,
          borderRadius: 14,
          border: 'none',
          background: 'transparent',
          color: 'var(--fg-muted)',
          cursor: 'pointer',
          fontSize: 18,
          lineHeight: 1,
        }}
      >
        ×
      </button>
      <h2 style={{ margin: '0 0 0.5rem 0', fontSize: '1.15rem' }}>
        Welcome to BinGo Auctions, {businessName}
      </h2>
      <p style={{ margin: '0 0 1rem 0', color: 'var(--fg-muted)', lineHeight: 1.55, fontSize: 14 }}>
        BinGo Auctions is three apps that work together. You&apos;re on the
        web console right now — that&apos;s where you build auctions,
        review lots, and manage your team. Your warehouse crew and your
        bidders use mobile apps.
      </p>
      <div style={{ display: 'grid', gap: '0.65rem', marginBottom: '1rem' }}>
        <AppRow
          label="Picker app"
          who="Warehouse staff (iPad / iPhone)"
          purpose="Scan barcodes, photo-lot items, take pickups."
          url={fieldAppUrl}
          fallback="TestFlight link not configured yet."
        />
        <AppRow
          label="Bidder app"
          who="Your customers (iPhone)"
          purpose="Browse your auctions, place bids, request pickups."
          url={bidderAppUrl}
          fallback="TestFlight link not configured yet."
        />
      </div>
      <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
        Quick-start: create a warehouse → upload a floor plan → add bins
        → import inventory or scan items → schedule your first auction.
        The checklist below tracks where you are.
      </div>
    </section>
  );
}

function AppRow({
  label,
  who,
  purpose,
  url,
  fallback,
}: {
  label: string;
  who: string;
  purpose: string;
  url: string | null;
  fallback: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.6rem 0.85rem',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {label}{' '}
          <span style={{ color: 'var(--fg-muted)', fontWeight: 400, fontSize: 12 }}>
            · {who}
          </span>
        </div>
        <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 2 }}>
          {purpose}
        </div>
      </div>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          style={{
            padding: '0.4rem 0.85rem',
            background: 'var(--accent)',
            color: '#fff',
            borderRadius: 4,
            textDecoration: 'none',
            fontSize: 12,
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          Install ↗
        </a>
      ) : (
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
          {fallback}
        </span>
      )}
    </div>
  );
}
