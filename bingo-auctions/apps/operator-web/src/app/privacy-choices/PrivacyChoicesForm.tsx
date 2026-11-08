'use client';

// The advertising opt-out control the privacy policy links to.
//
// Works signed-out, on purpose: a CCPA "do not share" request cannot be gated
// behind making an account, and requiring someone to identify themselves in
// order to be tracked less is the wrong shape. Signed-out visitors get the
// browser-side opt-out, which is what stops the Pixel. Signed-in bidders get
// that plus the durable server-side flag, which is what stops the Conversions
// API and survives a cleared cache.

import { useEffect, useState } from 'react';
import { AD_OPT_OUT_KEY, hasOptedOutOfAdTracking } from '../(public)/_components/MetaPixel';

export function PrivacyChoicesForm() {
  const [optedOut, setOptedOut] = useState<boolean | null>(null);
  const [gpc, setGpc] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const nav = window.navigator as Navigator & { globalPrivacyControl?: boolean };
    setGpc(Boolean(nav.globalPrivacyControl));
    setOptedOut(hasOptedOutOfAdTracking());

    // The server is the authority when there is an account, because it is what
    // the Conversions API drain actually reads.
    void fetch('/api/bidder/ad-tracking', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { ok?: boolean; optedOut?: boolean } | null) => {
        if (!j?.ok) return;
        setSignedIn(true);
        if (j.optedOut) {
          setOptedOut(true);
          try {
            window.localStorage.setItem(AD_OPT_OUT_KEY, '1');
          } catch {
            /* storage blocked — the server flag still governs */
          }
        }
      })
      .catch(() => {});
  }, []);

  async function choose(next: boolean) {
    setBusy(true);
    setSaved(false);
    try {
      window.localStorage.setItem(AD_OPT_OUT_KEY, next ? '1' : '0');
    } catch {
      /* Private mode. hasOptedOutOfAdTracking() fails closed, so a visitor who
         cannot store the choice is treated as opted out anyway. */
    }
    if (signedIn) {
      await fetch('/api/bidder/ad-tracking', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optOut: next }),
      }).catch(() => {});
    }
    setOptedOut(next);
    setBusy(false);
    setSaved(true);
  }

  if (optedOut === null) {
    return <p style={{ color: 'var(--fg-muted)' }}>Loading your current setting…</p>;
  }

  return (
    <div
      style={{
        marginTop: '1.5rem',
        padding: '1.25rem',
        border: '1px solid var(--border, #d0d7de)',
        borderRadius: 10,
        background: 'var(--bg-elev, #f6f8fa)',
      }}
    >
      {gpc && (
        <p style={{ margin: '0 0 1rem', fontSize: 14 }}>
          <strong>Your browser is sending a Global Privacy Control signal.</strong> We treat that as
          an opt-out request and are already honoring it. You do not need to do anything else.
        </p>
      )}

      <p style={{ margin: '0 0 1rem', fontWeight: 700 }}>
        {optedOut
          ? 'You are opted OUT of sharing for advertising.'
          : 'You are currently opted IN to sharing for advertising.'}
      </p>

      <button
        type="button"
        onClick={() => void choose(!optedOut)}
        disabled={busy || gpc}
        style={{
          padding: '0.7rem 1.1rem',
          borderRadius: 8,
          border: '1px solid var(--border, #d0d7de)',
          background: optedOut ? 'transparent' : 'var(--accent, #1f6feb)',
          color: optedOut ? 'var(--fg, #0d1117)' : '#fff',
          fontWeight: 700,
          cursor: busy || gpc ? 'default' : 'pointer',
          opacity: busy || gpc ? 0.6 : 1,
        }}
      >
        {busy ? 'Saving…' : optedOut ? 'Allow sharing for advertising' : 'Do not share my information'}
      </button>

      {saved && (
        <p style={{ marginTop: '0.75rem', fontSize: 13, color: 'var(--success, #1a7f37)' }}>
          Saved.{' '}
          {signedIn
            ? 'This applies to your account on every device, and we have stopped any events that had not been sent yet.'
            : 'This applies to this browser. Sign in and set it again to apply it to your account everywhere.'}
        </p>
      )}

      {!signedIn && (
        <p style={{ marginTop: '0.75rem', fontSize: 13, color: 'var(--fg-muted, #57606a)' }}>
          You are not signed in, so this choice is remembered in this browser only. If you have an
          account, sign in and set it here to make it stick across devices.
        </p>
      )}
    </div>
  );
}
