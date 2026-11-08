// Android Google sign-in via the Supabase-hosted browser flow (2026-09-24).

import { describe, it, expect } from 'vitest';
import {
  GOOGLE_BROWSER_REDIRECT,
  googleSignInModeFor,
  isAuthCallbackUrl,
  parseAuthCallback,
} from './google-browser-auth';

const IOS = '320714067980-e2dudrcgp50du1co0gdm91t1ie2rn70c.apps.googleusercontent.com';
const ANDROID = 'android-client.apps.googleusercontent.com';

describe('googleSignInModeFor', () => {
  it('gives Android the browser flow when it has no client ID (the #383 gap)', () => {
    expect(googleSignInModeFor('android', { ios: IOS, android: undefined })).toEqual({
      kind: 'browser',
    });
  });

  it('never gives Android the native flow with the iOS client ID (the crash)', () => {
    const mode = googleSignInModeFor('android', { ios: IOS, android: undefined });
    expect(mode?.kind).not.toBe('native');
  });

  it('keeps iOS on the native flow', () => {
    expect(googleSignInModeFor('ios', { ios: IOS, android: undefined })).toEqual({
      kind: 'native',
      client: { clientId: IOS, key: 'iosClientId' },
    });
  });

  it('prefers a native Android client ID if one is ever configured', () => {
    expect(googleSignInModeFor('android', { ios: IOS, android: ANDROID })?.kind).toBe('native');
  });

  it('leaves web and iOS without an ID alone', () => {
    expect(googleSignInModeFor('web', { ios: IOS, android: undefined })).toBeNull();
    expect(googleSignInModeFor('ios', { ios: undefined, android: undefined })).toBeNull();
  });
});

describe('isAuthCallbackUrl', () => {
  it('matches the redirect with a fragment or query', () => {
    expect(isAuthCallbackUrl(`${GOOGLE_BROWSER_REDIRECT}#access_token=a`)).toBe(true);
    expect(isAuthCallbackUrl(`${GOOGLE_BROWSER_REDIRECT}?error=x`)).toBe(true);
    expect(isAuthCallbackUrl(GOOGLE_BROWSER_REDIRECT)).toBe(true);
  });

  it('leaves every other deep link alone', () => {
    expect(isAuthCallbackUrl('bingo://pickup/abc')).toBe(false);
    expect(isAuthCallbackUrl('bingo://verify-card?invoice_id=1')).toBe(false);
    expect(isAuthCallbackUrl('bingo://auth-callbacks')).toBe(false);
    expect(isAuthCallbackUrl('https://bingoauctions.com/l/abc')).toBe(false);
  });
});

describe('parseAuthCallback', () => {
  it('reads the session from the fragment', () => {
    const url = `${GOOGLE_BROWSER_REDIRECT}#access_token=AT&expires_in=3600&refresh_token=RT&token_type=bearer`;
    expect(parseAuthCallback(url)).toEqual({ kind: 'session', accessToken: 'AT', refreshToken: 'RT' });
  });

  it('reports an error from the fragment, preferring the description', () => {
    const url = `${GOOGLE_BROWSER_REDIRECT}#error=access_denied&error_description=User+cancelled`;
    expect(parseAuthCallback(url)).toEqual({ kind: 'error', message: 'User cancelled' });
  });

  it('reports an error from the query', () => {
    expect(parseAuthCallback(`${GOOGLE_BROWSER_REDIRECT}?error=server_error`)).toEqual({
      kind: 'error',
      message: 'server_error',
    });
  });

  it('refuses a redirect without both tokens', () => {
    expect(parseAuthCallback(`${GOOGLE_BROWSER_REDIRECT}#access_token=AT`)).toEqual({ kind: 'invalid' });
    expect(parseAuthCallback(GOOGLE_BROWSER_REDIRECT)).toEqual({ kind: 'invalid' });
  });

  it('refuses tokens on some other URL', () => {
    expect(parseAuthCallback('bingo://pickup/x#access_token=AT&refresh_token=RT')).toEqual({
      kind: 'invalid',
    });
  });
});
