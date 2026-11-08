// Root layout. Routes the user to (auth) flows when signed out, or (tabs)
// when signed in. After signIn / signUp completes we also ensure a `bidders`
// row exists for the user.

import { Stack, usePathname, useRootNavigationState, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { installCrashReporter } from '../lib/crash-reporter';
import { startSessionWatchdog, noteScreen } from '../lib/session-watchdog';
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';
import {
  useSession,
  ensureBidderRow,
  setTracker,
} from '@auction-platform/supabase-client';
import { colors } from '@auction-platform/design-system';
import Constants from 'expo-constants';
import { registerForPushNotifications } from '@/lib/push';
import { useOtaAutoReload } from '@/lib/useOtaAutoReload';
import { ZipGateHost } from '@/components/ZipGateHost';
// 2026-05-19: Sentry import + initSentry call removed from this layout to
// isolate whether @sentry/react-native is causing the v13/v14 launch
// hang. The library has been seen to deadlock JS module load on iOS
// 26.x even with enableNative: false. The Sentry plugin has also been
// removed from app.config.ts so sentry-cocoa is not auto-initialized
// from AppDelegate either. Net effect: no Sentry monitoring on bidder
// until we can isolate the hang. Will re-introduce gradually.
// import { initSentry, setUserId } from '@/lib/sentry';
import { identifyUser, track as posthogTrack } from '@/lib/posthog';

// initSentry() call removed — see comment above.
const setUserId = (_id: string | null): void => {};

// Wire posthog into the package-level tracker shim so domain components
// (PlaceBidSheet, BuyNowSheet, etc. in @auction-platform/domain-bidding)
// can call track() without taking a direct posthog-react-native dep.
setTracker((event, props) => {
  void posthogTrack(event, props);
});

// Module scope on purpose: the handler is armed before React mounts, so even
// a crash during the very first render gets reported.
installCrashReporter();
// Reports what the previous session could not: a saved crash, a silent kill,
// or an OTA that downloaded and was then refused. See lib/session-watchdog.ts.
startSessionWatchdog();

// The custom URL scheme THIS binary actually registered, read from
// app.config.ts rather than written out again here. The app has been renamed
// twice (bidwizops → clovrbid → bingo) and both sweeps left a stale literal
// behind in a push producer, which silently killed those notification taps —
// so this file refuses to add a third copy.
const configuredScheme = Constants.expoConfig?.scheme;
const APP_SCHEME =
  (Array.isArray(configuredScheme) ? configuredScheme[0] : configuredScheme) ?? 'bingo';

/**
 * Can we hand this `deep_link` to Linking.openURL and expect to land somewhere?
 *
 * Only our own scheme and in-app absolute paths qualify. Anything else — a
 * scheme from a previous rename, an http(s) link that would bounce the user
 * out to a browser, a malformed value — is rejected here so the caller can
 * fall back to `kind` routing instead of burning the tap on a URI the OS will
 * refuse.
 */
function isRoutableDeepLink(link: string): boolean {
  return link.startsWith('/') || link.startsWith(`${APP_SCHEME}://`);
}

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();
  const pathname = usePathname();
  const { session, ready } = useSession();

  // Feed the live route to the watchdog so a silent kill names its screen.
  useEffect(() => {
    noteScreen(pathname ?? null);
  }, [pathname]);
  // Root navigator mount state. `ready` only means the SESSION is hydrated —
  // on a cold launch from a push-notification tap, the queued response can
  // dispatch router.push() before the root <Stack> finishes mounting, which
  // throws ("attempted to navigate before mounting the Root Layout") and
  // crashes the app (tester's iPad, pickup-confirmed tap, 2026-07-02).
  const navState = useRootNavigationState();
  const navReady = Boolean(navState?.key);

  // Apply a downloaded OTA when the user comes back to the app, instead of
  // making them wait for a cold start. See lib/ota-auto-reload.ts.
  useOtaAutoReload();

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const inAuthGroup = segments[0] === '(auth)';

    if (session && inAuthGroup) {
      router.replace('/');
    } else if (!session && !inAuthGroup) {
      router.replace('/login');
    }

    setUserId(session?.user?.id ?? null);
    identifyUser(session?.user?.id ?? null).catch(() => {});

    if (session) {
      ensureBidderRow()
        .then(() => {
          if (cancelled) return;
          registerForPushNotifications().catch(() => {
            // Permission denied or non-device — not actionable for the user.
          });
        })
        .catch((err) => {
          // ensureBidderRow throws for OAuth users without DOB (migration
          // 0082 trigger). That's expected — the (tabs) layout will route
          // them to /complete-profile. Swallow here so push registration
          // can still fire after they complete profile.
          if (cancelled) return;
          if (
            !(err as Error)?.message?.includes('birth_date is required')
          ) {
             
            console.warn('[_layout] ensureBidderRow:', (err as Error).message);
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [ready, session, segments, router]);

  // Tap-to-deep-link: when the user taps a push notification, route them
  // into the relevant pickup screen. Without this the app just opens to
  // its last screen (typically the auctions tab) and the bidder has to
  // hunt for the invoice they just got pinged about.
  // Wired here (not in (tabs)/pickup) so it fires regardless of which tab
  // is mounted.
  useEffect(() => {
    if (!ready || !session || !navReady) return;
    // PR-D (2026-05-29): kind-aware push response router.
    //
    // The previous handler always routed to /pickup/[id] regardless of
    // kind — a payment_requires_action SCA push would land the bidder on
    // a pickup screen instead of the verify-card screen. Now we:
    //   1. Prefer an explicit `deep_link` payload field — passes through
    //      Linking.openURL so it works the same as a Universal Links tap.
    //      Vetted by isRoutableDeepLink first: the old comment here claimed
    //      deep_link was "always a bingo:// URI after the scheme sweep", and
    //      that assumption is exactly what broke — three producers were still
    //      emitting clovrbid:// as of 2026-09-14. Steps 2/3 are now a real
    //      fallback for a bad link, not just for a missing one.
    //   2. Fall back to switching on `kind` and routing by params so
    //      older builds (whose enqueue producer didn't bake deep_link)
    //      still land on the right screen.
    //   3. Default to /pickup/[id] when invoice_id is present, mirroring
    //      today's behavior for any kind the switch doesn't recognize.
    const handlePushResponse = (
      r: Notifications.NotificationResponse,
    ): void => {
      try {
        dispatchPushResponse(r);
      } catch (err) {
        // Never let a navigation dispatch take the app down — a push tap
        // landing on the wrong screen beats a crash-on-launch.
        console.warn('[push] response dispatch failed', (err as Error).message);
      }
    };

    type PushData = {
      invoice_id?: string;
      kind?: string;
      lot_id?: string;
      token?: string;
      deep_link?: string;
    };

    // Steps 2 and 3, extracted so they are callable on their own. This is both
    // the path for payloads with no deep_link AND the recovery path when a
    // deep_link turns out to be unusable — see dispatchPushResponse.
    const routeByKind = (data: PushData | undefined): void => {
      switch (data?.kind) {
        case 'payment_requires_action': {
          const inv = data.invoice_id;
          router.push({
            pathname: '/verify-card',
            params:
              data.token
                ? { token: data.token }
                : typeof inv === 'string' && inv.length > 0
                  ? { invoice_id: inv }
                  : {},
          });
          return;
        }
        case 'outbid':
        case 'closing_soon':
        case 'saved_search_hit': {
          if (typeof data.lot_id === 'string' && data.lot_id.length > 0) {
            router.push({ pathname: '/lot/[id]', params: { id: data.lot_id } });
            return;
          }
          break;
        }
        case 'won':
        case 'pickup_ready':
        case 'pickup_confirmed':
        case 'pickup_no_show_forfeit':
        case 'pickup_no_show_refund_pending': {
          if (typeof data.invoice_id === 'string' && data.invoice_id.length > 0) {
            router.push({
              pathname: '/pickup/[id]',
              params: { id: data.invoice_id },
            });
            return;
          }
          break;
        }
        case 'relot_fee_applied': {
          router.push({ pathname: '/profile/pay-fees' });
          return;
        }
        case 'payment_failed':
        case 'payment_retry_reminder':
        case 'lot_relisted_no_show':
        case 'refund_completed':
        case 'refund_failed': {
          if (typeof data.invoice_id === 'string' && data.invoice_id.length > 0) {
            router.push({
              pathname: '/invoice/[id]',
              params: { id: data.invoice_id },
            });
            return;
          }
          break;
        }
        case 'dispute_opened':
        case 'dispute_evidence_due':
        case 'dispute_update': {
          // Disputes deep-link to the bidder's dispute list (we don't have
          // a per-dispute screen on bidder-app yet — dispute/new is the
          // create flow). Fall through to invoice if invoice_id is present.
          if (typeof data.invoice_id === 'string' && data.invoice_id.length > 0) {
            router.push({
              pathname: '/invoice/[id]',
              params: { id: data.invoice_id },
            });
            return;
          }
          break;
        }
      }

      // 3. Default — preserve today's behavior for unknown kinds.
      if (typeof data?.invoice_id === 'string' && data.invoice_id.length > 0) {
        router.push({ pathname: '/pickup/[id]', params: { id: data.invoice_id } });
      }
    };

    const dispatchPushResponse = (
      r: Notifications.NotificationResponse,
    ): void => {
      const data = r.notification.request.content.data as PushData | undefined;

      // 1. Prefer an explicit deep_link.
      //
      // 2026-09-14: this used to call Linking.openURL and `return` immediately.
      // The `.catch` promised a fall-through to the kind dispatch, but the
      // return ran synchronously — before the rejected promise could settle —
      // so the fallback was unreachable. A deep_link on a stale scheme
      // therefore did not degrade to kind routing, it SUPPRESSED it, and the
      // tap did nothing at all. Two guards now:
      //   • reject a link we know the OS won't take, before spending the tap
      //   • on rejection, actually run the fallback
      const link = data?.deep_link;
      if (typeof link === 'string' && link.length > 0) {
        if (isRoutableDeepLink(link)) {
          Linking.openURL(link).catch(() => {
            // The OS declined it after all. This runs outside
            // handlePushResponse's try/catch, so it needs its own.
            try {
              routeByKind(data);
            } catch (err) {
              console.warn('[push] deep_link fallback failed', (err as Error).message);
            }
          });
          return;
        }
        console.warn('[push] deep_link not routable, using kind instead:', link);
      }

      routeByKind(data);
    };
    // UX-P0-2 fix (2026-05-24 audit): cold-launch push tap silently
    // dropped — listener registers AFTER the tap arrived. Check for a
    // queued response at mount time and handle it before wiring the
    // listener.
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) handlePushResponse(response);
      })
      .catch(() => {
        // No actionable recovery — fall through to the live listener.
      });
    const sub =
      Notifications.addNotificationResponseReceivedListener(handlePushResponse);
    return () => sub.remove();
  }, [ready, session, router, navReady]);

  if (!ready) return null;

  // Stripe removed 2026-07-02: the native @stripe/stripe-react-native module
  // and the StripeProvider wrapper were ripped out — the app is Square-only now
  // (card capture is a web handoff; there is no client-side Stripe SCA). This
  // also drops the iOS-26 launch-hang suspect (synchronous native SDK init on
  // the main thread).
  const stackContent = (
    <>
      {/* TODO: dark-mode StatusBar (audit UX-P1-6) — gate on useColorScheme() once a light theme exists */}
      <Stack
        screenOptions={{ headerStyle: { backgroundColor: colors.bg }, headerTintColor: '#e8eaf0' }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="lot/[id]" options={{ title: 'Lot details' }} />
        <Stack.Screen name="lot/pager" options={{ headerShown: false }} />
        {/* Read-only closed-auction results. Reached from the "Recently
            closed" rail on (tabs)/index.tsx; closed auctions are absent from
            the live rail + browse grid, so this is their only app entry. */}
        <Stack.Screen name="auction/[id]" options={{ title: 'Results' }} />
        <Stack.Screen name="invoice/[id]" options={{ title: 'Invoice' }} />
        <Stack.Screen name="pickup/[id]" options={{ title: 'Pickup' }} />
        <Stack.Screen name="pickup-pass" options={{ title: 'Pickup pass' }} />
        <Stack.Screen name="dispute/new" options={{ title: 'Report a problem' }} />
        {/* Subscription route — GATED OFF in v1 (2026-06-03, red-team
            MON-2/3 kill switch). The priced "Subscribe" screen advertised
            digital perks + steered to web (Apple 3.1.1/3.1.3(a) + Play
            digital-goods risk). With this Stack.Screen removed and the
            Profile link gone (app/(tabs)/profile.tsx), the screen is
            unreachable in the binary on iOS and Android. Memberships are
            web-only for v1; re-register when the member-facing rewrite to
            the 3 real-world perks ships.
        <Stack.Screen name="subscription/index" options={{ title: 'Subscription' }} /> */}
        <Stack.Screen name="identity/verify" options={{ title: 'Verify identity' }} />
        <Stack.Screen name="profile/edit" options={{ title: 'Edit profile' }} />
        <Stack.Screen name="profile/saved-searches" options={{ title: 'Saved searches' }} />
        <Stack.Screen name="profile/payment-method" options={{ title: 'Payment method' }} />
        <Stack.Screen name="profile/pay-fees" options={{ title: 'Pay fees' }} />
        {/* PR-D (2026-05-29): SCA recovery screen — landing target for
            payment_requires_action push taps and the verify-card deep link.
            See apps/bidder-app/app/verify-card.tsx. */}
        <Stack.Screen name="verify-card" options={{ title: 'Verify card' }} />
        <Stack.Screen name="profile/stats" options={{ title: 'My Stats' }} />
        <Stack.Screen name="profile/feedback" options={{ title: 'Feedback' }} />
        <Stack.Screen
          name="complete-profile"
          options={{ headerShown: false, gestureEnabled: false }}
        />
      </Stack>
      <StatusBar style="light" />
      {/* Mandatory ZIP block (ZIP-required-before-bid/checkout plan): one
          host at the root answers every requireZip() call from any bid or
          checkout screen. See lib/zip-gate.ts. */}
      <ZipGateHost />
    </>
  );
  return stackContent;
}
