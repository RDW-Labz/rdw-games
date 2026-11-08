// Staff login — same Supabase project as bidder-mobile, gated on
// having an operator_users row inside (staff)/_layout.tsx.
//
// No "create account" link here. Field-mobile users are invited
// (operator admins create operator_users rows for new staff via the
// operator-web console). Self-signup would let any bidder bypass into
// the field app.
//
// Auth methods supported:
//   - Email + password (primary; works for anyone the admin invited
//     with a direct-password invite)
//   - Continue with Google (when EXPO_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID
//     is set AND Supabase Dashboard has Google provider enabled)
//   - Continue with Apple (when on iOS 13+ AND Supabase Dashboard has
//     Apple provider enabled)
//
// All three methods produce the same Supabase session; the (staff)
// layout's gate then checks operator_users membership. Operator admins
// who set up staff via Google OAuth on operator-web will now have a
// path to sign in on the field app without first running the forgot-
// password flow.

import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Keyboard,
  TouchableWithoutFeedback,
} from 'react-native';
import { Link } from 'expo-router';
import { Image } from 'expo-image';
import { supabase } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';
import { OAuthButtons } from '@/features/auth/OAuthButtons';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    setError(null);
    setLoading(true);
    const { error: e } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (e) setError(e.message);
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: colors.bg }}
    >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: 'center',
            padding: 24,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <Image
            source={require('../../assets/icon.png')}
            style={{ width: 56, height: 56, borderRadius: 14, marginBottom: 16 }}
          />
          <Text
            style={{
              color: colors.primary,
              fontSize: 11,
              ...type.label,
              marginBottom: 12,
            }}
          >
            BinGo Staff
          </Text>
          <Text
            style={{
              color: colors.text,
              fontSize: 32,
              ...type.displayHero,
              marginBottom: 8,
            }}
          >
            Sign in
          </Text>
          <Text
            style={{
              color: colors.textMuted,
              fontSize: 14,
              lineHeight: 20,
              marginBottom: 24,
            }}
          >
            Field app for warehouse staff and operators. If your operator
            admin invited you, use the same email + password you use on
            the bidder app.
          </Text>

          <TextInput
            testID="staff-signin-email-input"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            placeholder="Email"
            placeholderTextColor={colors.textMuted}
            value={email}
            onChangeText={setEmail}
            style={inputStyle}
          />
          <TextInput
            testID="staff-signin-password-input"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder="Password"
            placeholderTextColor={colors.textMuted}
            value={password}
            onChangeText={setPassword}
            style={inputStyle}
            onSubmitEditing={onSubmit}
          />
          {error && (
            <Text style={{ color: colors.danger, marginTop: 12 }}>{error}</Text>
          )}
          <Pressable
            testID="staff-signin-submit"
            onPress={onSubmit}
            disabled={loading || !email || password.length < 8}
            style={{
              marginTop: 16,
              padding: 16,
              backgroundColor: colors.primary,
              borderRadius: 10,
              opacity: loading || !email || password.length < 8 ? 0.5 : 1,
            }}
          >
            <Text
              style={{
                color: '#000',
                textAlign: 'center',
                fontSize: 15,
                ...type.label,
              }}
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </Text>
          </Pressable>
          <View style={{ alignItems: 'center', marginTop: 16 }}>
            {/* typed-routes types regenerate on `expo start`; cast unblocks
                ahead-of-server-start typecheck */}
            <Link
              href={'/forgot-password' as never}
              style={{ color: colors.textMuted, fontSize: 13 }}
            >
              Forgot password?
            </Link>
          </View>

          {/* Google + Apple OAuth. The component self-hides each button
              based on platform support (Apple ≥ iOS 13) and env config
              (Google needs EXPO_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID).
              Errors bubble up to the same `error` state as password
              sign-in so the UX is consistent. */}
          <OAuthButtons onError={setError} />
        </ScrollView>
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );
}

const inputStyle = {
  padding: 14,
  marginTop: 12,
  backgroundColor: colors.surface,
  borderColor: colors.border,
  borderWidth: 1,
  borderRadius: 10,
  color: colors.text,
  fontSize: 16,
};
