// Google sign-in through the browser, for platforms with no native client ID.
//
// 2026-09-24: #383 hid the Google button on Android, because Android has no
// Google OAuth client ID of its own (the iOS one crashed the sign-in screen).
// Instead of minting one, Android uses the same Supabase-hosted Google login
// the website uses: signInWithOAuth returns an authorize URL, a Custom Tab
// opens it, and Supabase redirects back to bingo://auth-callback with the
// session in the URL fragment (implicit flow, supabase-js's default here).
//
// JS only: expo-web-browser and the `bingo` scheme are both in Play 0.1.1's
// native build, and prod Auth allows `bingo://**` as a redirect.

import { googleClientFor, type GoogleClientChoice, type GoogleClientIds } from './google-client-id';

export const GOOGLE_BROWSER_REDIRECT = 'bingo://auth-callback';

export type GoogleSignInMode =
  | { kind: 'native'; client: GoogleClientChoice }
  | { kind: 'browser' }
  | null;

/** Native button where this platform has its own client ID; browser on Android otherwise. */
export function googleSignInModeFor(platform: string, ids: GoogleClientIds): GoogleSignInMode {
  const client = googleClientFor(platform, ids);
  if (client) return { kind: 'native', client };
  if (platform === 'android') return { kind: 'browser' };
  return null;
}

export function isAuthCallbackUrl(url: string): boolean {
  if (!url.startsWith(GOOGLE_BROWSER_REDIRECT)) return false;
  const rest = url.slice(GOOGLE_BROWSER_REDIRECT.length);
  return rest === '' || rest[0] === '#' || rest[0] === '?' || rest[0] === '/';
}

export type AuthCallback =
  | { kind: 'session'; accessToken: string; refreshToken: string }
  | { kind: 'error'; message: string }
  | { kind: 'invalid' };

/** Reads the redirect Supabase sends back. Tokens arrive in the fragment; errors may come in either part. */
export function parseAuthCallback(url: string): AuthCallback {
  if (!isAuthCallbackUrl(url)) return { kind: 'invalid' };
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  const params = new URLSearchParams(queryAt === -1 ? '' : beforeHash.slice(queryAt + 1));
  const fragment = new URLSearchParams(hashAt === -1 ? '' : url.slice(hashAt + 1));
  fragment.forEach((value, key) => params.set(key, value));

  const error = params.get('error_description') || params.get('error');
  if (error) return { kind: 'error', message: error };

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (accessToken && refreshToken) return { kind: 'session', accessToken, refreshToken };
  return { kind: 'invalid' };
}
