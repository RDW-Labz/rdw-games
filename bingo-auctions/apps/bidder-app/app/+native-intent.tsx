// Expo Router hook for incoming system URLs (deep links, push taps).
//
// 2026-09-24: Android Google sign-in returns through bingo://auth-callback.
// While the app is running, expo-web-browser's own listener takes that URL
// and _oauth-buttons.tsx sets the session; if the router also routed it, the
// user would land on an "Unmatched Route" screen. So the router ignores it.
//
// Cold start (Android killed the app while the Custom Tab was open): nobody is
// waiting for the redirect, so the session is set here and the app opens at
// its default route. Every other URL passes through untouched.

import { supabase } from '@auction-platform/supabase-client';
import { isAuthCallbackUrl, parseAuthCallback } from '../lib/google-browser-auth';

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    if (!isAuthCallbackUrl(path)) return path;
    if (initial) {
      const cb = parseAuthCallback(path);
      if (cb.kind === 'session') {
        supabase.auth
          .setSession({ access_token: cb.accessToken, refresh_token: cb.refreshToken })
          .catch(() => {});
      }
    }
    return null;
  } catch {
    return path;
  }
}
