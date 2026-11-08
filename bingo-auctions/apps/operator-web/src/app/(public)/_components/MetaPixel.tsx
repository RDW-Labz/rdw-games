'use client';

// Meta Pixel — browser-side, PUBLIC STOREFRONT ONLY.
//
// Mounted from (public)/layout.tsx rather than the root layout on purpose. The
// root layout also wraps the operator console and the staff-facing pages, and
// putting an ad tracker on screens where warehouse workers do their job would
// be tracking employees at work to no advertising benefit.
//
// ── WHAT THIS FIRES, AND WHAT IT DELIBERATELY DOES NOT ───────────────────────
// PageView, plus ViewContent on a lot page. That is the whole browser surface.
//
// The money events — Purchase, Lead (first bid), CompleteRegistration — are
// sent SERVER-side by the Conversions API drain and are not fired here. Two
// reasons, and they both matter more than the extra coverage would:
//
//   1. The server sees all of them and the browser sees a fraction. Bidding is
//      mostly in the native app, and `place_bid` is a PostgREST RPC with no web
//      request to attach a Pixel event to.
//   2. Firing the same conversion from both sides is only safe when the two
//      carry an identical event_id. That is buildable (the outbox ids are
//      stable and derived from the row), but a duplicated Purchase inflates
//      reported ROAS and silently corrupts the optimisation signal, which is
//      the exact thing this work exists to make trustworthy. Server-only is the
//      conservative default; the dedup path is documented in meta-capi.ts if
//      browser conversions are ever wanted.
//
// The dataset id is a literal (meta-dataset.ts) because it is public anyway, so
// this is LIVE on the storefront. What still gates it per visitor is the
// advertising opt-out below — GPC, or the choice made at /privacy-choices —
// which is disclosed in the privacy policy before any of this fires.

import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { browserPixelId } from '@/lib/social/meta-dataset';

const PIXEL_ID = browserPixelId();

/** Where the browser-side opt-out is remembered. Mirrors bidders.ad_tracking_opt_out
 *  (mig 0340) for people who are not signed in and therefore have no row. */
export const AD_OPT_OUT_KEY = 'bingo:ad-tracking-opt-out';

/**
 * Has this visitor declined advertising tracking?
 *
 * Global Privacy Control counts on its own. Under California law a GPC header
 * IS a valid opt-out request, so honouring it is not a courtesy — treating it
 * as advisory while the privacy policy says we honour it would make the policy
 * false. It is checked FIRST so a GPC user is covered without ever having
 * found our opt-out page.
 *
 * Defaults to opted-OUT if localStorage throws (private mode, blocked storage).
 * The failure that matters here is tracking someone who said no, not missing an
 * ad event.
 */
export function hasOptedOutOfAdTracking(): boolean {
  if (typeof window === 'undefined') return true;
  const nav = window.navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl) return true;
  try {
    return window.localStorage.getItem(AD_OPT_OUT_KEY) === '1';
  } catch {
    return true;
  }
}

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { callMethod?: (...args: unknown[]) => void };
  }
}

export function MetaPixel() {
  const pathname = usePathname();

  // The opt-out lives in localStorage and on `navigator`, neither of which
  // exists during SSR. Reading it straight in the render body would make the
  // server (always "opted out", so no script) disagree with the first client
  // render (maybe a script) — a hydration mismatch. So the first client render
  // deliberately matches the server, and the decision is made after mount.
  //
  // Erring toward NOT rendering is also the right way round: a frame of missing
  // tracking costs an ad event, a frame of wrongly-rendered tracking loads
  // Meta's script for someone who declined.
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    setAllowed(!hasOptedOutOfAdTracking());
  }, []);

  // App Router does not reload the page between routes, so the snippet's own
  // one-shot PageView would only ever count the first screen of a session.
  useEffect(() => {
    if (!PIXEL_ID || !allowed || typeof window === 'undefined' || !window.fbq) return;
    window.fbq('track', 'PageView');
  }, [pathname, allowed]);

  // Not just a guarded track() call: an opted-out visitor should never load
  // Meta's script at all. Loading it and declining to send events would still
  // hand Meta the request, the IP and the referrer.
  if (!PIXEL_ID || !allowed) return null;

  return (
    <Script id="meta-pixel" strategy="afterInteractive">
      {`
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window,document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${PIXEL_ID}');
fbq('track', 'PageView');
      `}
    </Script>
  );
}

/**
 * ViewContent for a lot page. Safe to call when the Pixel is absent — it is a
 * no-op, so callers need no guard of their own.
 *
 * `content_ids` uses the lot UUID, matching the catalog feed's `id` column, or
 * retargeting cannot join an ad to the item that was viewed.
 */
export function trackLotView(lotId: string, valueCents: number | null): void {
  if (typeof window === 'undefined' || !window.fbq) return;
  if (hasOptedOutOfAdTracking()) return;
  window.fbq('track', 'ViewContent', {
    content_type: 'product',
    content_ids: [lotId],
    ...(valueCents != null ? { currency: 'USD', value: (valueCents / 100).toFixed(2) } : {}),
  });
}
