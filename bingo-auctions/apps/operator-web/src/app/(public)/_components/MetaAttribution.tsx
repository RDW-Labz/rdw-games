'use client';

// Ships the Meta click cookies to our own server so the Conversions API can
// attribute a conversion to the ad that caused it (mig 0341).
//
// Without this, Ads Manager under-reports: the server-side Purchase events
// match a PERSON via hashed email, but nothing ties them to a CLICK. A working
// campaign then looks like a failing one, which is the most expensive way to be
// wrong about advertising.
//
// ── WHY A COMPONENT AND NOT A ONE-OFF CALL AT SIGNUP ────────────────────────
// The click and the account are often days apart — click an ad Monday, browse,
// register Thursday. _fbc is written by the Pixel on the ad landing and then
// persists in the browser for up to 90 days, so the reliable moment to read it
// is "any storefront page load where the visitor happens to be signed in",
// not one specific step of a funnel.
//
// Renders nothing. Fires at most once per session (sessionStorage), because the
// values change rarely and a POST on every navigation would be noise.

import { useEffect } from 'react';
import { hasOptedOutOfAdTracking } from './MetaPixel';

const ONCE_KEY = 'bingo:meta-attribution-sent';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split('; ')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

export function MetaAttribution() {
  useEffect(() => {
    // The opt-out governs here as everywhere else. An opted-out visitor has no
    // Pixel, so there is usually nothing to read anyway — but a stale cookie
    // from before they opted out would otherwise still be forwarded, and the
    // server would (correctly) refuse it. Checking here saves the round trip
    // and keeps the promise on the client too.
    if (hasOptedOutOfAdTracking()) return;

    try {
      if (window.sessionStorage.getItem(ONCE_KEY)) return;
    } catch {
      /* Private mode: fall through and send once per page instead of once per
         session. Harmless — the endpoint is idempotent. */
    }

    const fbp = readCookie('_fbp');
    const fbc = readCookie('_fbc');
    if (!fbp && !fbc) return;

    // Deliberately fire-and-forget: this is measurement, and it must never
    // block, retry loudly, or surface an error to someone browsing lots. A
    // signed-out visitor gets a 401 here, which is the expected case and not
    // worth reporting.
    void fetch('/api/bidder/attribution', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fbp, fbc }),
    })
      .then((r) => {
        if (!r.ok) return;
        try {
          window.sessionStorage.setItem(ONCE_KEY, '1');
        } catch {
          /* nothing to remember with; see above */
        }
      })
      .catch(() => {});
  }, []);

  return null;
}
