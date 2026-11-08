/**
 * Apple App Site Association (AASA) — Universal Link binding for iOS.
 *
 * Served at https://bingoauctions.com/.well-known/apple-app-site-association
 * (no extension; Apple's required path).
 *
 * What it does:
 *   When a user with the BinGo Auctions bidder app installed taps any
 *   https://bingoauctions.com/l/{qr_token} link (from a printed QR sticker,
 *   a shared URL, an email, etc.), iOS intercepts the tap and opens
 *   the app directly, deep-linking to the in-app lot screen via the
 *   `expo-router` link handler.
 *
 *   Without this file, the URL opens in Safari and hits the web
 *   /lot/{code} fallback (which works, but loses the in-app experience).
 *
 * Validation:
 *   - Apple fetches this file when the app is installed and caches it.
 *     Subsequent fetches are infrequent (every ~24h).
 *   - Must be served with Content-Type: application/json.
 *   - Must NOT redirect — Apple's resolver follows zero redirects.
 *   - Must NOT require auth (no cookies, no CSRF, no rate-limit blocks).
 *
 * Why a route handler instead of a public/.well-known/ static file:
 *   Next.js + opennextjs-cloudflare serves /public/ assets with MIME
 *   types derived from file extensions. The AASA file has NO extension,
 *   so static serving sets Content-Type: application/octet-stream and
 *   Apple silently ignores the file. A route handler lets us pin the
 *   correct Content-Type.
 *
 * If the bidder-app's Team ID or bundle id changes, update the appID
 * below to match the format `<TEAM_ID>.<BUNDLE_ID>`.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-static'; // never hits a DB, can be edge-cached

/**
 * `<TEAM_ID>.<BUNDLE_ID>` for the bidder app.
 *
 * 2026-08-07: this said `com.cluerholdings.auctionplatform`, but the shipped
 * iOS bundle is `com.bingoauctions.bidder` (apps/bidder-app/app.config.ts).
 * A bundle that isn't the installed one can never satisfy Apple's check, so
 * Universal Links silently failed and every /l/{qr_token} tap — every printed
 * QR sticker — opened Safari instead of the app. The Android assetlinks file
 * had the identical mismatch and is fixed alongside this.
 *
 * The stale name is all over docs/ (the bundle was renamed and the docs never
 * followed). app.config.ts is the source of truth for what actually ships.
 */
const BIDDER_APP_ID = '73554WL25P.com.bingoauctions.bidder';

const AASA = {
  applinks: {
    apps: [], // legacy field, must be empty array
    details: [
      {
        appID: BIDDER_APP_ID,
        // Limit Universal Link interception to the qr_token short-URL
        // route. Everything else on bingoauctions.com (browse, lot detail,
        // marketing) still opens in Safari, which is what we want —
        // operators using the dashboard shouldn't get hijacked into the
        // bidder app.
        paths: ['/l/*'],
      },
    ],
  },
  // appclips, webcredentials: omitted — not used yet.
};

export async function GET() {
  return new NextResponse(JSON.stringify(AASA, null, 2), {
    status: 200,
    headers: {
      // Apple's documented requirement.
      'content-type': 'application/json',
      // Long cache is safe; if we rotate Team ID we redeploy + invalidate.
      'cache-control': 'public, max-age=86400, immutable',
    },
  });
}
