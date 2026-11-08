// OTA auto-reload hook — the side-effect half of lib/ota-auto-reload.ts.
//
// Applies an already-downloaded update when the user returns to the app, so a
// change lands on their NEXT foreground instead of their next cold start. All
// the decision-making lives in the pure module; this only wires it to
// expo-updates, AppState and the router.
//
// Deliberately swallows every error. An update that fails to apply must leave
// the user on the working bundle they already have — a reload helper that can
// crash the app it is updating is worse than the one-launch delay it fixes.
// (Same principle as field-mobile/lib/session-watchdog.ts.)

import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useSegments } from 'expo-router';
import * as Updates from 'expo-updates';
import { shouldReload } from './ota-auto-reload';
import { noteDownloadedUpdate } from './session-watchdog';

export function useOtaAutoReload(): void {
  const segments = useSegments();
  const { isUpdatePending, downloadedUpdate } = Updates.useUpdates();

  // Record what finished downloading, so the next launch can tell whether it
  // actually ran it (lib/ota-health.ts).
  useEffect(() => {
    noteDownloadedUpdate(downloadedUpdate?.updateId);
  }, [downloadedUpdate?.updateId]);

  // Refs, not state: the AppState listener must read the CURRENT route and
  // pending flag without re-subscribing on every navigation.
  const routeRef = useRef('');
  const pendingRef = useRef(false);
  const reloadedRef = useRef(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  routeRef.current = segments.join('/');
  pendingRef.current = isUpdatePending;

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const prev = appStateRef.current;
      appStateRef.current = next;

      // Only the background → active edge. iOS emits 'inactive' while the app
      // switcher is open or a system sheet is up; treating that as a return
      // would reload people who never actually left.
      const returningToForeground = prev.match(/inactive|background/) !== null && next === 'active';

      const decision = shouldReload({
        isUpdatePending: pendingRef.current,
        route: routeRef.current,
        returningToForeground,
        alreadyReloaded: reloadedRef.current,
      });
      if (!decision) return;

      // Set BEFORE awaiting: reloadAsync does not resolve on success (the JS
      // context is torn down), and a second AppState event arriving first would
      // otherwise start a second reload.
      reloadedRef.current = true;
      Updates.reloadAsync().catch(() => {
        // Failed to apply — stay on the current bundle. Do not clear the flag:
        // retrying on the next foreground would risk a reload loop for exactly
        // the bundle that just failed.
      });
    });

    return () => sub.remove();
  }, []);
}
