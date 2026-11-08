// BinGo Staff root layout. Routes to (auth) when signed out and to
// (staff) when signed in. Unlike bidder-mobile, there's no
// StripeProvider — staff don't pay; staff are paid.
//
// The strict role gate lives in (staff)/_layout.tsx, not here, so
// users who land on the auth flow can sign in cleanly without the
// gate flashing a "not staff" screen mid-navigation.

import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { Stack, useRouter, useSegments, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useSession, setTracker } from '@auction-platform/supabase-client';
import { initSentry, setUserId } from '@/lib/sentry';
import { identifyUser, track as posthogTrack } from '@/lib/posthog';
import { installCrashReporter } from '@/lib/crash-reporter';
import { startSessionWatchdog, noteScreen } from '@/lib/session-watchdog';
import { installMemoryGuard } from '@/lib/memory-guard';
import { prunePersistedPhotos } from '@/lib/persist-photo';
import { drainPhotoQueue } from '@/lib/photo-upload-queue';
import { startPhotoQueueRetry } from '@/lib/photo-queue-retry';

(globalThis as { __bingoFetch?: typeof fetch }).__bingoFetch = fetchWithTimeout;

initSentry();
// Layer-1 crash telemetry — lib/sentry is a no-op stub (native SDK removed
// 2026-05-20), so this JS-only handler is the real crash reporting.
installCrashReporter();
// The other half of the same job: crash-reporter sees JS throws, this sees the
// process disappearing without one — the "it backs me out and I start over"
// reports, which leave no crash log anywhere. See lib/session-watchdog.ts.
startSessionWatchdog();
// What the watchdog found: every silent exit happened while backgrounded, on
// every screen. That is the OS reclaiming a large background process, so the
// answer is to be smaller while backgrounded. See lib/memory-guard.ts.
installMemoryGuard();
void prunePersistedPhotos();
// Resume queued lot photos after a kill/restart or a return to the foreground.
void drainPhotoQueue().catch(() => {});
AppState.addEventListener('change', (state) => {
  if (state === 'active') void drainPhotoQueue().catch(() => {});
});
// Foreground/restart are not the only moments connectivity can come back while
// the app stays open on one screen, so retry a non-empty queue on a timer too.
startPhotoQueueRetry();

// Wire posthog into the package-level tracker shim. Same pattern as
// bidder-mobile so any shared package emitting analytics events lands
// in PostHog without taking a direct dep on the SDK.
setTracker((event, props) => {
  void posthogTrack(event, props);
});

// AI calls go through the operator-web proxy (apps/operator-web/api/lottr/*)
// — the mobile bundle holds no AI keys. The Supabase JWT is the auth
// boundary. See apps/field-mobile/lib/lottr-client.ts and the README.
// No setLottingConfig() needed here; the lookup helpers that DO read
// product_lookups directly (cache.ts) accept a Supabase client per-call.

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();
  const pathname = usePathname();
  const { session, ready } = useSession();

  // Feed the live route to the watchdog so a silent kill names the screen it
  // happened on. Without this every report reads "died somewhere".
  useEffect(() => {
    noteScreen(pathname ?? null);
  }, [pathname]);

  useEffect(() => {
    if (!ready) return;
    const inAuthGroup = segments[0] === '(auth)';

    if (session && inAuthGroup) {
      router.replace('/');
    } else if (!session && !inAuthGroup) {
      router.replace('/login');
    }

    setUserId(session?.user?.id ?? null);
    identifyUser(session?.user?.id ?? null).catch(() => {});
  }, [ready, session, segments, router]);

  if (!ready) return null;

  return (
    <>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#0b0d12' },
          headerTintColor: '#e8eaf0',
        }}
      >
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(staff)" options={{ headerShown: false }} />
        <Stack.Screen name="not-staff" options={{ headerShown: false }} />
      </Stack>
      <StatusBar style="light" />
    </>
  );
}
