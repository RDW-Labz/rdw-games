import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Keyboard,
  TouchableWithoutFeedback,
} from 'react-native';
import { Link } from 'expo-router';
import { Image } from 'expo-image';
import { supabase } from '@auction-platform/supabase-client';
import { BrandedButton, colors, type } from '@auction-platform/design-system';
import { OAuthButtons } from './_oauth-buttons';

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
    // Navigation happens via the root layout's useEffect when session changes.
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: colors.bg }}
      // Tabs bar isn't shown on auth screens; offset accounts for the
      // status bar height only.
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
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
            BinGo Auctions
          </Text>
          <Text style={{ color: colors.text, fontSize: 32, ...type.displayHero, marginBottom: 8 }}>
            Sign in
          </Text>
          <Text style={{ color: colors.textMuted, marginBottom: 24, lineHeight: 20 }}>
            Bid on lots from any operator on the platform with one account.
          </Text>
          <TextInput
            testID="signin-email-input"
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
            testID="signin-password-input"
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
          {error && <Text style={{ color: colors.danger, marginTop: 8 }}>{error}</Text>}
          <BrandedButton
            testID="signin-submit"
            variant="primary"
            size="md"
            onPress={onSubmit}
            loading={loading}
            disabled={!email || !password}
            style={{ marginTop: 16 }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </BrandedButton>

          <View style={{ alignItems: 'center', marginTop: 12 }}>
            {/* typed-routes types regenerate on `expo start`; cast unblocks
                ahead-of-server-start typecheck */}
            <Link
              href={'/forgot-password' as never}
              style={{ color: colors.textMuted, fontSize: 13 }}
            >
              Forgot password?
            </Link>
          </View>

          <OAuthButtons onError={setError} />

          <Link
            href="/signup"
            style={{ color: colors.primary, textAlign: 'center', marginTop: 24, fontSize: 14 }}
          >
            Don&apos;t have an account? Create one
          </Link>
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

void View; // imported for compat with older RN style typings
