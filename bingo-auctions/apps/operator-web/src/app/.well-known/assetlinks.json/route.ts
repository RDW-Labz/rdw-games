/**
 * Android Asset Links (Digital Asset Links) — App Links binding for Android.
 *
 * Served at https://bingoauctions.com/.well-known/assetlinks.json
 *
 * What it does:
 *   The Android equivalent of Apple's apple-app-site-association file.
 *   When a user with the BinGo Auctions bidder app installed taps any
 *   https://bingoauctions.com/l/{qr_token} link (from a printed QR sticker,
 *   a shared URL, an email, etc.), the OS intercepts the tap and opens
 *   the app directly, deep-linking to the in-app lot screen via the
 *   expo-router link handler.
 *
 *   Without this file (and a matching `intentFilters` block in
 *   apps/bidder-app/app.config.ts with `autoVerify: true`), the URL opens
 *   in Chrome and hits the web /lot/{code} fallback.
 *
 * Validation:
 *   - The Android OS fetches this file when the app is installed and
 *     verifies it asynchronously.
 *   - Must be served with Content-Type: application/json.
 *   - Must NOT redirect.
 *   - Must NOT require auth.
 *   - The sha256_cert_fingerprints array MUST contain the SHA-256
 *     fingerprint of the Play App Signing key used to sign release builds.
 *     EAS Build manages the upload key; Google Play re-signs with the
 *     Play App Signing key. The fingerprint to use here is the one shown
 *     in Play Console under: Setup → App integrity → App signing →
 *     SHA-256 certificate fingerprint (App signing key certificate).
 *
 * CURRENT STATE (2026-08-07):
 *   FIXED — this file declared `com.cluerholdings.auctionplatform`, which was
 *   never published to Play (the store URL for it 404s). The shipped bidder
 *   app is `com.bingoauctions.bidder` (apps/bidder-app/app.config.ts), which
 *   is live. Because the declared package didn't match the installed one,
 *   Android App Links auto-verification could never succeed, so every tap on
 *   https://bingoauctions.com/l/{qr_token} — including every printed QR
 *   sticker on a box — fell back to Chrome instead of opening the app.
 *
 *   The package name is now correct. The FINGERPRINT still needs confirming:
 *   the value below was pulled on 2026-06-04 for the old package, so it is
 *   not trustworthy for this one. Get the real value from
 *     Play Console → Setup → App integrity → App signing
 *       → SHA-256 certificate fingerprint (App signing key certificate)
 *   or headlessly via scripts/get-play-app-signing-sha.mjs, and set it as the
 *   ANDROID_APP_SIGNING_SHA256 env var on the Worker — no code change or
 *   redeploy of this file required. Verify afterwards with:
 *     https://developers.google.com/digital-asset-links/tools/generator
 *
 *   Multiple fingerprints can be supplied comma-separated — useful if the
 *   upload key and app-signing key differ, or during a key rotation.
 *
 * If the bidder-app's package name changes, update ANDROID_PACKAGE below.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
// Rendered per request (not force-static) so ANDROID_APP_SIGNING_SHA256 can be
// rotated by setting the Worker env var alone. The response is trivial and the
// cache-control header below still keeps Google's fetcher off the origin.
export const dynamic = 'force-dynamic';

/** Package name of the bidder app that is actually live on Play. Must match
 *  `android.package` in apps/bidder-app/app.config.ts or verification fails. */
const ANDROID_PACKAGE = 'com.bingoauctions.bidder';

/**
 * Real Play app-signing SHA-256 for com.bingoauctions.bidder, retrieved
 * 2026-08-07 from the Play Developer API (versionCode 9) by the "Get Play App
 * Signing SHA-256" workflow.
 *
 * This is only the fallback — ANDROID_APP_SIGNING_SHA256 (set in
 * wrangler.jsonc `vars`) is what normally supplies it, so a key rotation needs
 * no code change. But the fallback has to be CORRECT, not merely non-empty:
 * it previously held 8E:0C:D7:…, the fingerprint of the never-published
 * com.cluerholdings.auctionplatform, which meant any gap in the env var
 * silently served a valid-looking file for the wrong app. A wrong fingerprint
 * fails exactly like a missing one, with no error anywhere to notice.
 */
const FALLBACK_SHA256 =
  'F7:12:96:53:F9:9D:25:2B:F0:D5:63:66:6D:BC:E0:92:AB:E1:0B:07:B2:96:BD:6C:F5:38:E3:E0:BA:AB:E2:91';

/** Google accepts several fingerprints (upload key vs app-signing key, or a
 *  rotation window), so the env var is comma-separated. */
function signingFingerprints(): string[] {
  const raw = process.env.ANDROID_APP_SIGNING_SHA256?.trim();
  if (!raw) return [FALLBACK_SHA256];
  const parsed = raw
    .split(',')
    .map((f) => f.trim().toUpperCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [FALLBACK_SHA256];
}

export async function GET() {
  const assetLinks = [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: ANDROID_PACKAGE,
        sha256_cert_fingerprints: signingFingerprints(),
      },
    },
  ];

  return new NextResponse(JSON.stringify(assetLinks, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // Not `immutable` any more: the fingerprint is env-driven, so a rotation
      // must be able to propagate without waiting out a day-long cache.
      'cache-control': 'public, max-age=3600',
    },
  });
}
