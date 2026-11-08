// Forgot password — sends a Supabase password reset email. The email
// links the user to the operator-web /reset-password page (single
// resetURL for both web and mobile users). User opens the email on
// their phone, taps the link, sets a new password in the browser, and
// returns to the mobile app to sign in with the new credentials.

import { useState } from 'react';
import {
  Text,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Keyboard,
  TouchableWithoutFeedback,
} from 'react-native';
import { Link } from 'expo-router';
import { supabase } from '@auction-platform/supabase-client';
import { BrandedButton, colors, type } from '@auction-platform/design-system';

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
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: colors.bg }}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
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
            BinGo Auctions
          </Text>
          <Text style={{ color: colors.text, fontSize: 32, ...type.displayHero, marginBottom: 8 }}>
            Reset password
          </Text>

          {sent ? (
            <>
              <Text style={{ color: colors.success, marginTop: 16, lineHeight: 22, fontSize: 15 }}>
                If an account exists for {email}, we sent a reset link. Check your inbox (and spam
                folder). The link will open a page in your browser where you can set a new
                password — then come back here to sign in.
              </Text>
              <Link
                href="/login"
                style={{ color: colors.primary, textAlign: 'center', marginTop: 32, fontSize: 14 }}
              >
                ← Back to sign in
              </Link>
            </>
          ) : (
            <>
              <Text style={{ color: colors.textMuted, marginBottom: 24, lineHeight: 20 }}>
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
              {error && <Text style={{ color: colors.danger, marginTop: 8 }}>{error}</Text>}
              <BrandedButton
                variant="primary"
                size="md"
                onPress={onSubmit}
                loading={loading}
                disabled={!email}
                style={{ marginTop: 16 }}
              >
                {loading ? 'Sending…' : 'Send reset link'}
              </BrandedButton>
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
