/**
 * Canonical outbound links for the BinGo apps and public site.
 *
 * Why this file exists (2026-08-07): the App Store URL was hardcoded in
 * /download pointing at ASC record 6767012532 — a record that was provisioned
 * under the old `com.bingoauctions.bidder` bundle but NEVER received a build,
 * so the only "Download on the App Store" link on the site returned 404. The
 * live listing is 6785655751, which is what apps/bidder-app/eas.json actually
 * submits to. Meanwhile the page still advertised Android as "coming soon"
 * even though the app is live on Play.
 *
 * A single hardcoded copy is what let those drift. Everything that links to a
 * store, the site, or a lot now comes from here — including the Meta catalog
 * feed, which would otherwise become a second place to get this wrong.
 */

/** Live App Store record. `eas.json` submit profiles use `ascAppId` 6785655751. */
export const IOS_APP_STORE_ID = '6785655751';

/** Live Play package. Matches `android.package` in apps/bidder-app/app.config.ts. */
export const ANDROID_PACKAGE = 'com.bingoauctions.bidder';

/**
 * Bidder-app custom URL scheme. MUST match `scheme` in apps/bidder-app/app.config.ts.
 *
 * Renamed twice (bidwizops → clovrbid → bingo) and both sweeps missed producers,
 * leaving push notifications whose tap did nothing at all. Keep this the only
 * literal — `deep-link-scheme.test.ts` fails the build if a raw scheme reappears.
 */
export const BIDDER_APP_SCHEME = 'bingo';

export const APP_STORE_URL = `https://apps.apple.com/us/app/id${IOS_APP_STORE_ID}`;
export const PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;

/** Public site origin, no trailing slash. Mirrors the cron drains' convention. */
export const SITE_URL = (process.env.PUBLIC_APP_URL ?? 'https://bingoauctions.com').replace(
  /\/$/,
  '',
);

/**
 * The canonical shareable URL for a lot.
 *
 * Deliberately the `/l/{qr_token}` short form rather than `/lot/{code}`:
 * `/l/*` is the ONLY path in the iOS AASA file and the only `pathPattern` in
 * the Android intentFilters, so it is the one URL shape that opens the app
 * directly on both platforms when installed. It 302s to `/lot/{code}` for
 * everyone else, so there is no downside to preferring it everywhere.
 *
 * Falls back to the long form when a lot predates qr_token backfill.
 */
export function lotShareUrl(lot: { qr_token?: string | null; lot_code?: string | null }): string {
  if (lot.qr_token) return `${SITE_URL}/l/${lot.qr_token}`;
  if (lot.lot_code) return `${SITE_URL}/lot/${encodeURIComponent(lot.lot_code)}`;
  return `${SITE_URL}/browse`;
}

/**
 * Build a push-notification `deep_link` targeting a bidder-app route.
 *
 * `path` is the in-app route without a leading slash — 'pickup/<uuid>',
 * 'invoice/<uuid>', 'profile/pay-fees' — and must correspond to a real
 * expo-router file under apps/bidder-app/app/.
 *
 * Consumed by apps/bidder-app/app/_layout.tsx, which hands the value to
 * Linking.openURL. A scheme the OS doesn't recognise is REFUSED, so getting
 * this wrong makes the notification tap inert — write the payload key as
 * `deep_link` (nothing reads any other key) or the value is silently ignored.
 */
export function bidderDeepLink(path: string): string {
  return `${BIDDER_APP_SCHEME}://${path.replace(/^\/+/, '')}`;
}
