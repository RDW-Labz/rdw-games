// Reusable Sign-in-with-Google + Sign-in-with-Apple buttons for the
// bidder-app login + signup screens.
//
// Apple and iOS Google exchange a provider-issued identity token for a
// Supabase session via supabase.auth.signInWithIdToken. Apple Sign-In
// uses the native iOS UI (expo-apple-authentication). iOS Google opens an
// in-app browser (expo-auth-session) and returns an id_token.
//
// Android Google (2026-09-24) has no client ID of its own, so it uses the
// Supabase-hosted Google login the website uses: signInWithOAuth, a Custom
// Tab, and a bingo://auth-callback redirect carrying the session.
// lib/google-browser-auth.ts; app/+native-intent.tsx keeps the router off it.
//
// Buttons hide themselves automatically:
//   - Google: native where THIS platform has its own client ID
//             (EXPO_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID on iOS), browser on
//             Android, hidden elsewhere. lib/google-browser-auth.ts
//   - Apple:  hidden if AppleAuthentication.isAvailableAsync() === false
//             (covers Android + iOS < 13)

import { useEffect, useState } from 'react';
import { Text, View, Platform, Alert } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import * as Crypto from 'expo-crypto';
import { supabase } from '@auction-platform/supabase-client';
import { type GoogleClientChoice } from '../../lib/google-client-id';
import {
  GOOGLE_BROWSER_REDIRECT,
  googleSignInModeFor,
  parseAuthCallback,
} from '../../lib/google-browser-auth';
import { BrandedButton, colors } from '@auction-platform/design-system';

WebBrowser.maybeCompleteAuthSession();

// 2026-05-20: Google hook moved into a sub-component. Calling
// `Google.useIdTokenAuthRequest({iosClientId: undefined})` throws
// `Client Id property iosClientId must be defined to use Google auth on
// this platform` at render — fatal to the login screen if the env var
// is unset (e.g., simulator smoke tests, accidentally-cleared CI env).
// React hooks must run unconditionally, so we isolate the hook to a
// component that only mounts when the client ID exists.
function GoogleButton({
  client,
  onError,
}: {
  client: GoogleClientChoice;
  onError?: (msg: string) => void;
}) {
  // The provider requires the key for the platform it runs on; an iOS ID on
  // Android threw at render and crashed the login screen (2026-08-10 → 09-24).
  const [, googleResponse, promptGoogle] = Google.useIdTokenAuthRequest({
    [client.key]: client.clientId,
  });
  useEffect(() => {
    if (googleResponse?.type !== 'success') return;
    const idToken = googleResponse.params?.id_token;
    if (!idToken) {
      onError?.('Google did not return an ID token.');
      return;
    }
    supabase.auth
      .signInWithIdToken({ provider: 'google', token: idToken })
      .then(({ error }) => {
        if (error) onError?.(error.message);
      });
  }, [googleResponse, onError]);

  return (
    <BrandedButton
      variant="ghost"
      size="md"
      onPress={() => promptGoogle()}
      leftIcon={
        <Text style={{ fontSize: 18, fontWeight: '700', color: '#4285F4' }}>G</Text>
      }
    >
      Continue with Google
    </BrandedButton>
  );
}

function GoogleBrowserButton({ onError }: { onError?: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);

  async function signIn() {
    if (busy) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: GOOGLE_BROWSER_REDIRECT, skipBrowserRedirect: true },
      });
      if (error || !data?.url) {
        onError?.(error?.message ?? 'Could not start Google sign-in.');
        return;
      }
      const result = await WebBrowser.openAuthSessionAsync(data.url, GOOGLE_BROWSER_REDIRECT);
      // cancel / dismiss: the user closed the tab. Nothing to report.
      if (result.type !== 'success') return;
      const cb = parseAuthCallback(result.url);
      if (cb.kind === 'error') {
        onError?.(cb.message);
      } else if (cb.kind === 'invalid') {
        onError?.('Google sign-in did not return a session.');
      } else {
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: cb.accessToken,
          refresh_token: cb.refreshToken,
        });
        if (sessionError) onError?.(sessionError.message);
      }
    } catch (err) {
      onError?.((err as Error).message ?? 'Google sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <BrandedButton
      variant="ghost"
      size="md"
      onPress={() => {
        void signIn();
      }}
      loading={busy}
      leftIcon={
        <Text style={{ fontSize: 18, fontWeight: '700', color: '#4285F4' }}>G</Text>
      }
    >
      Continue with Google
    </BrandedButton>
  );
}

export function OAuthButtons({ onError }: { onError?: (msg: string) => void }) {
  // Literal process.env reads: Expo only inlines EXPO_PUBLIC_* written this way.
  const google = googleSignInModeFor(Platform.OS, {
    ios: process.env.EXPO_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID,
    android: process.env.EXPO_PUBLIC_GOOGLE_OAUTH_ANDROID_CLIENT_ID,
  });
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    if (Platform.OS === 'ios') {
      AppleAuthentication.isAvailableAsync().then(setAppleAvailable).catch(() => setAppleAvailable(false));
    }
  }, []);

  async function onApple() {
    try {
      // Apple Sign In nonce contract:
      //   - Apple receives the SHA-256 HASH of a random raw nonce
      //     (Apple bakes that hash into the identityToken JWT claims).
      //   - Supabase receives the RAW nonce + the identityToken. Supabase
      //     re-hashes the raw value and compares it to the claim — only
      //     accepts the token if they match.
      // Earlier code passed the hash to BOTH sides, so Supabase re-hashed
      // an already-hashed value and rejected every token as a forgery.
      // The user-visible message was a generic "not allowed" / invalid
      // token error.
      const rawNonce = Math.random().toString(36).slice(2);
      const hashedNonce = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        rawNonce,
      );
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: hashedNonce,
      });
      if (!credential.identityToken) {
        onError?.('Apple did not return an identity token.');
        return;
      }
      const { error } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: credential.identityToken,
        nonce: rawNonce,
      });
      if (error) onError?.(error.message);
    } catch (err) {
      // User cancellation throws — that's not an error worth surfacing.
      const code = (err as { code?: string }).code;
      if (code !== 'ERR_REQUEST_CANCELED') {
        onError?.((err as Error).message ?? 'Apple sign-in failed.');
      }
    }
  }

  if (!google && !appleAvailable) return null;

  return (
    <View style={{ marginTop: 18, gap: 10 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          marginVertical: 4,
        }}
      >
        <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
        <Text style={{ color: colors.textMuted, fontSize: 11 }}>OR</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
      </View>

      {google?.kind === 'native' && <GoogleButton client={google.client} onError={onError} />}
      {google?.kind === 'browser' && <GoogleBrowserButton onError={onError} />}

      {appleAvailable && (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
          cornerRadius={10}
          style={{ width: '100%', height: 50 }}
          onPress={onApple}
        />
      )}
    </View>
  );
}

// Suppress unused-import warning when Alert isn't reached
void Alert;
