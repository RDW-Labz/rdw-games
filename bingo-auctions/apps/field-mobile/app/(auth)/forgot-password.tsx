// Forgot password — for operator staff who forgot the temp password
// they got via the /staff invite (or who just want to set their own
// password). Same flow as the bidder-app: Supabase sends an email
// linking to the operator-web /reset-password page; user sets a new
// password in the browser, then comes back to the field app to sign in.

import { useState } from 'react';
import {
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
import { supabase } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';

const RESET_REDIRECT_URL = 'https://bingoauctions.com/reset-password';

export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    setError(null);
    setLoading(true);
    const { error: e } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: RESET_REDIRECT_URL,
    });
    setLoading(false);
    if (e) {
      setError(e.message);
      return;
    }
    setSent(true);
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: colors.bg }}
    >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }}
          keyboardShouldPersistTaps="handled"
        >
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
            Reset password
          </Text>

          {sent ? (
            <>
              <Text
                style={{ color: colors.success, marginTop: 16, lineHeight: 22, fontSize: 15 }}
              >
                If an account exists for {email}, we sent a reset link. Check your inbox (and
                spam folder). Tap the link — it opens a page in your browser to set a new
                password — then come back here to sign in.
              </Text>
              <Link
                href="/login"
                style={{
                  color: colors.primary,
                  textAlign: 'center',
                  marginTop: 32,
                  fontSize: 14,
                }}
              >
                ← Back to sign in
              </Link>
            </>
          ) : (
            <>
              <Text
                style={{
                  color: colors.textMuted,
                  fontSize: 14,
                  lineHeight: 20,
                  marginBottom: 24,
                }}
              >
                Enter your email and we&apos;ll send you a link to set a new password.
              </Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                placeholder="Email"
                placeholderTextColor={colors.textMuted}
                value={email}
                onChangeText={setEmail}
                style={inputStyle}
                onSubmitEditing={onSubmit}
              />
              {error && (
                <Text style={{ color: colors.danger, marginTop: 12 }}>{error}</Text>
              )}
              <Pressable
                onPress={onSubmit}
                disabled={loading || !email}
                style={{
                  marginTop: 16,
                  padding: 16,
                  backgroundColor: colors.primary,
                  borderRadius: 10,
                  opacity: loading || !email ? 0.5 : 1,
                }}
              >
                <Text style={{ color: '#000', textAlign: 'center', fontSize: 15, ...type.label }}>
                  {loading ? 'Sending…' : 'Send reset link'}
                </Text>
              </Pressable>
              <Link
                href="/login"
                style={{
                  color: colors.textMuted,
                  textAlign: 'center',
                  marginTop: 18,
                  fontSize: 14,
                }}
              >
                ← Back to sign in
              </Link>
            </>
          )}
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
