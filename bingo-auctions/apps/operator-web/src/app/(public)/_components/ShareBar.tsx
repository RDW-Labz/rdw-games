'use client';

// Share bar for public lot pages (marketing batch, 2026-07-05). Bidders do
// the posting: copy link, Facebook share, and the native share sheet on
// phones (covers Messenger/SMS — where local deals actually spread). Each
// medium gets its own utm_medium so signups from shares are attributable
// in analytics. OG cards (photo + title + current bid) already render for
// shared links via the lot page's generateMetadata.

import { useEffect, useState } from 'react';

// Shared secondary button at the small size. These were hand-rolled with
// their own 8px radius and 0.45rem/0.85rem padding, which is why the share
// row never quite lined up with the buttons around it. Only the muted label
// color is local — everything structural comes from .btn-secondary.btn-sm.
const BTN_CLASS = 'btn-secondary btn-sm btn-icon';
const btnStyle: React.CSSProperties = { color: 'var(--fg-muted)', cursor: 'pointer' };

/** Fire-and-forget click counter for the /marketing scoreboard (mig 0232). */
export function beaconShareClick(medium: string, lotCode?: string) {
  try {
    void fetch('/api/telemetry/share-click', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ medium, ...(lotCode ? { lot_code: lotCode } : {}) }),
      keepalive: true,
    });
  } catch {
    // Never let telemetry interfere with the share itself.
  }
}

export function ShareBar({ url, title, lotCode }: { url: string; title: string; lotCode?: string }) {
  // navigator.share only exists on (mostly mobile) browsers — decide after
  // mount so SSR and first client render agree and hydration stays clean.
  const [canNativeShare, setCanNativeShare] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCanNativeShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  const withUtm = (medium: string) =>
    `${url}${url.includes('?') ? '&' : '?'}utm_source=share&utm_medium=${medium}`;

  const handleCopy = async () => {
    beaconShareClick('copy', lotCode);
    try {
      await navigator.clipboard.writeText(withUtm('copy'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API denied (rare; http or old browser) — fall back to a
      // prompt the user can copy from manually.
      window.prompt('Copy this link:', withUtm('copy'));
    }
  };

  const handleNativeShare = async () => {
    beaconShareClick('native', lotCode);
    try {
      await navigator.share({ title, url: withUtm('native') });
    } catch {
      // User dismissed the sheet — not an error.
    }
  };

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '1rem 0 0' }}>
      <button type="button" onClick={handleCopy} className={BTN_CLASS} style={btnStyle}>
        {copied ? '✓ Copied!' : '🔗 Copy link'}
      </button>
      {/* Owner report 2026-07-08: on phones the facebook.com/sharer URL gets
          intercepted by the installed FB app, which drops the composer and
          just lands on the feed ("goes to fb and nothing else"). The native
          share sheet posts to FB reliably, so when it exists (mobile) the
          FB button routes through it; desktop keeps the classic sharer
          popup, which works. */}
      {canNativeShare ? (
        <button
          type="button"
          className={BTN_CLASS}
          style={btnStyle}
          onClick={async () => {
            beaconShareClick('facebook', lotCode);
            try {
              await navigator.share({ title, url: withUtm('facebook') });
            } catch {
              // User dismissed the sheet — not an error.
            }
          }}
        >
          Share to Facebook
        </button>
      ) : (
        <a
          href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(withUtm('facebook'))}`}
          target="_blank"
          rel="noopener noreferrer"
          className={BTN_CLASS}
          style={btnStyle}
          onClick={() => beaconShareClick('facebook', lotCode)}
        >
          Share to Facebook
        </a>
      )}
      {canNativeShare && (
        <button type="button" onClick={handleNativeShare} className={BTN_CLASS} style={btnStyle}>
          Share…
        </button>
      )}
    </div>
  );
}
