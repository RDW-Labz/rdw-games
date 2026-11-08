// Sign-in-with-Google + Sign-in-with-Apple buttons for the field-mobile
// login screen. Mirror of bidder-app/(auth)/_oauth-buttons.tsx — both
// apps use the same Supabase project, so the auth contract is identical.
// We keep a per-app copy instead of extracting to a shared package
// because the design-system import + the screen wrapper diverge per
// app, and the component is small enough that drift is cheap.
//
// Both providers exchange a provider-issued identity token for a
// Supabase session via supabase.auth.signInWithIdToken. Apple Sign-In
// uses the native iOS UI (expo-apple-authentication). Google Sign-In
// opens an in-app browser (expo-auth-session) and returns an id_token.
//
// Self-hiding rules:
//   - Google: hidden when EXPO_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID isn't set
//     (you haven't created an iOS OAuth client in Google Cloud Console yet).
//   - Apple:  hidden by SHOW_APPLE_SIGNIN flag below AND by
//     AppleAuthentication.isAvailableAsync() === false (Android / iOS < 13).
//     The flag is OFF by default because enabling Apple Sign-In requires
//     three coordinated pieces of config (see SHOW_APPLE_SIGNIN comment).
//
// IMPORTANT: even when the button renders, signInWithIdToken still
// requires the corresponding provider to be enabled in Supabase
// Dashboard → Authentication → Providers. If it isn't, the user sees
// "Provider (issuer ...) is not enabled" — fail loud, not silent.

import { useEffect, useState } from 'react';
import { Text, Pressable, View } from 'react-native';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';

WebBrowser.maybeCompleteAuthSession();

// Apple Sign-In is currently OFF — package and code temporarily removed.
//
// The integration was implemented and worked locally, but adding it to the
// Build 13 EAS pipeline failed at the fastlane signing step:
//
//   Provisioning profile doesn't include the
//   com.apple.developer.applesignin entitlement
//
// expo-apple-authentication's config plugin auto-attaches the entitlement
// regardless of app.json's `usesAppleSignIn` flag, and the iOS bundle
// identifier (com.cluerholdings.bidwizops) doesn't yet have "Sign in with
// Apple" capability enabled on Apple Developer Portal. EAS can't sign an
// IPA with an entitlement the profile doesn't list.
//
// To re-enable, do FOUR things in this order:
//   1. Apple Developer Portal → Certificates, Identifiers & Profiles →
//      Identifiers → com.cluerholdings.bidwizops → Capabilities tab →
//      check "Sign in with Apple" → Save. This rebuilds the provisioning
//      profile to include com.apple.developer.applesignin.
//   2. apps/field-mobile/package.json → re-add `expo-apple-authentication`.
//      Run `npx expo install expo-apple-authentication` to get a version
//      matching the SDK.
//   3. apps/field-mobile/app.json → re-add `"usesAppleSignIn": true` under
//      the ios block (currently parked as _appleSignIn_TODO).
//   4. This file → restore the AppleAuthentication import, the onApple
//      function, the appleAvailable state + useEffect probe, and the
//      AppleAuthentication.AppleAuthenticationButton at the bottom of the
//      render. Look at apps/bidder-app/app/(auth)/_oauth-buttons.tsx for
//      the working reference shape — both apps should stay in sync.
//   5. Supabase Dashboard → Authentication → Providers → Apple → enable
//      (with Services ID, Team ID, Key ID, and Secret Key from the .p8
//      file Apple Developer Portal generated under "Keys").
//
// Until this is done, login is email+password (and Google OAuth if the
// EXPO_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID env var is set on the build).

// 2026-05-20: hook split. Previously this component called
// `Google.useIdTokenAuthRequest({iosClientId: googleClientId})`
// unconditionally — if `EXPO_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID` was unset,
// the hook threw `Client Id property iosClientId must be defined to use
// Google auth on this platform` at render time, killing the login screen.
// React hooks can't be called conditionally, so we move the Google hook
// into a sub-component that only mounts when the client ID is present.
// GHA simulator smoke test caught this against v28 before it reached
// TestFlight.
function GoogleButton({
  clientId,
  onError,
}: {
  clientId: string;
  onError?: (msg: string) => void;
}) {
  const [, googleResponse, promptGoogle] = Google.useIdTokenAuthRequest({
    iosClientId: clientId,
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
    <Pressable
      onPress={() => promptGoogle()}
      style={{
        padding: 14,
        backgroundColor: '#fff',
        borderRadius: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
      }}
    >
      <Text style={{ fontSize: 18, fontWeight: '700', color: '#4285F4' }}>G</Text>
      <Text style={{ color: '#1f1f1f', fontSize: 15, ...type.label }}>
        Continue with Google
      </Text>
    </Pressable>
  );
}

export function OAuthButtons({ onError }: { onError?: (msg: string) => void }) {
  const googleClientId = process.env.EXPO_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID;
  // Future: appleAvailable goes here when Apple Sign In is re-enabled
  // for the staff app per the SHOW_APPLE_SIGNIN comment above.
  if (!googleClientId) return null;

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

      <GoogleButton clientId={googleClientId} onError={onError} />
    </View>
  );
}
