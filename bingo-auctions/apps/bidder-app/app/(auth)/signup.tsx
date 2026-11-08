import { useEffect, useState } from 'react';
import {
  Text,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Keyboard,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import Checkbox from 'expo-checkbox';
import * as WebBrowser from 'expo-web-browser';
import { Image } from 'expo-image';
import { Link } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@auction-platform/supabase-client';
import { BrandedButton, colors, type } from '@auction-platform/design-system';
import { OAuthButtons } from './_oauth-buttons';
import { captureSignupStarted, captureSignupCompleted } from '@/lib/analytics';
import {
  PENDING_ZIP_STORAGE_KEY,
  encodePendingZip,
  sanitizeZipInput,
  saveMyZip,
  validateZip,
} from '@/lib/postal-code';

// Base URL for the operator-web (bidder signup API lives there).
// Falls back to the local dev URL when the env var is absent.
const OPERATOR_WEB_URL =
  (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_OPERATOR_WEB_URL) ||
  'https://bingoauctions.com';

const LEGAL_BASE = OPERATOR_WEB_URL;

/** ISO date string for today — used to clamp the DOB picker max date. */
function today(): Date {
  return new Date();
}

/** Calculate age in whole years (UTC). */
function calcAge(dob: Date): number {
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

/** Format a Date as YYYY-MM-DD for the API call. */
function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Human-readable date for display (e.g. "May 16, 1990"). */
function displayDate(d: Date | null): string {
  if (!d) return 'Select date of birth';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Failure beacon → operator-web /api/telemetry/signup-failure (mig 0223).
// Auth-rejected signups create no auth.users row, so this is the operator's
// only visibility into customers who bounced. Fire and forget.
function reportSignupFailure(attemptedEmail: string, message: string) {
  try {
    void fetch(`${OPERATOR_WEB_URL}/api/telemetry/signup-failure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: attemptedEmail, message, source: 'bidder-app' }),
    }).catch(() => {});
  } catch {
    /* best effort */
  }
}

// Raw GoTrue messages read as internals ("email rate limit exceeded",
// "For security purposes, you can only request this after 10 seconds").
// Diagnosed 2026-07-08: the throttle (double-submit within Supabase's 60s
// per-email cooldown) and browser network blips were the top failure
// beacons and had no friendly copy.
function friendlyAuthError(message: string): string {
  if (/after \d+ seconds|security purposes/i.test(message)) {
    return 'You just requested that — your confirmation email is already on its way. Check your inbox (and spam) in a minute. Still nothing? Use “Continue with Google” to get in instantly.';
  }
  if (/rate limit/i.test(message)) {
    return 'We’re getting a rush of signups and can’t send another confirmation email just yet. Use “Continue with Google” to get in instantly — or try email signup again in about an hour.';
  }
  if (/failed to fetch|load failed|network/i.test(message)) {
    return 'Network hiccup — that didn’t go through. Check your connection and try again.';
  }
  return message;
}

export default function SignupScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Optional ZIP (0434). Empty never blocks signup; only a non-empty,
  // non-5-digit value asks to be fixed.
  const [zip, setZip] = useState('');
  const [zipError, setZipError] = useState<string | null>(null);

  // DOB picker
  const [dob, setDob] = useState<Date | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [pickerDate, setPickerDate] = useState<Date>(new Date(2000, 0, 1)); // internal picker state

  // Consent checkboxes
  const [ageAck, setAgeAck] = useState(false);
  const [tosAck, setTosAck] = useState(false);
  const [bidderAck, setBidderAck] = useState(false);

  // Fires once per mount. Pairs with bidder_signup_completed downstream
  // so the funnel can measure abandonment between landing and submit.
  useEffect(() => {
    captureSignupStarted();
  }, []);

  function onDateChange(_event: DateTimePickerEvent, selected?: Date) {
    // On Android the picker dismisses itself on each interaction.
    if (Platform.OS === 'android') setShowDatePicker(false);
    if (selected) {
      setPickerDate(selected);
      setDob(selected);
    }
  }

  const canSubmit =
    !loading &&
    !!email &&
    password.length >= 8 &&
    !!displayName.trim() &&
    !!dob &&
    ageAck &&
    tosAck &&
    bidderAck;

  async function onSubmit() {
    setError(null);
    setInfo(null);

    if (!dob) {
      setError('Date of birth is required.');
      return;
    }
    if (calcAge(dob) < 18) {
      setError('You must be at least 18 years old to create a bidder account.');
      return;
    }
    if (!ageAck || !tosAck || !bidderAck) {
      setError('Please check all required boxes before continuing.');
      return;
    }
    const zipCheck = validateZip(zip);
    if (!zipCheck.ok) {
      setZipError(zipCheck.error);
      return;
    }

    setLoading(true);

    // Step 1 — create Supabase auth user
    const { data, error: signUpErr } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName } },
    });

    if (signUpErr) {
      reportSignupFailure(email.trim().toLowerCase(), signUpErr.message);
      setError(friendlyAuthError(signUpErr.message));
      setLoading(false);
      return;
    }

    // Retrieve the session token to forward to the API
    const session = data.session;
    if (!session) {
      // Email confirmation required — no session to save the ZIP with yet.
      // Keep it on this device for this email; the home screen saves it on
      // the first signed-in launch (components/home/ZipPrompt.tsx).
      if (zipCheck.zip) {
        AsyncStorage.setItem(PENDING_ZIP_STORAGE_KEY, encodePendingZip(zipCheck.zip, email)).catch(
          () => {},
        );
      }
      // Email confirmation required — show info and do not attempt the API call yet.
      setInfo('Check your inbox for a confirmation email, then sign in.');
      setLoading(false);
      return;
    }

    // Step 2 — POST to operator-web to create bidder + persist consent
    try {
      const res = await fetch(`${OPERATOR_WEB_URL}/api/bidder/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          birth_date: toISODate(dob),
          consent_slugs: ['terms', 'privacy', 'bidder-agreement'],
          consent_method: 'signup_checkbox',
        }),
      });

      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? 'Signup failed. Please try again.');
        setLoading(false);
        return;
      }
    } catch {
      setError('Network error — please check your connection and try again.');
      setLoading(false);
      return;
    }

    captureSignupCompleted({ method: 'email' });

    // Best effort: a ZIP that doesn't save (offline, server not ready) never
    // holds up signup; the home-screen prompt asks again later.
    if (zipCheck.zip) await saveMyZip(supabase, zipCheck.zip);

    setLoading(false);
    // expo-router will pick up the auth state change and navigate automatically.
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: colors.bg }}
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
          <Text style={{ color: colors.text, fontSize: 32, ...type.displayHero, marginBottom: 24 }}>
            Create account
          </Text>

          {/* --- Basic fields --- */}
          <TextInput
            autoCapitalize="words"
            placeholder="Display name"
            placeholderTextColor={colors.textMuted}
            value={displayName}
            onChangeText={setDisplayName}
            style={inputStyle}
          />
          <TextInput
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
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder="Password (8+ chars)"
            placeholderTextColor={colors.textMuted}
            value={password}
            onChangeText={setPassword}
            style={inputStyle}
          />

          <TextInput
            testID="signup-zip"
            value={zip}
            onChangeText={(t) => {
              setZip(sanitizeZipInput(t));
              if (zipError) setZipError(null);
            }}
            placeholder="ZIP code (optional)"
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            maxLength={5}
            textContentType="postalCode"
            autoComplete="postal-code"
            accessibilityLabel="ZIP code, optional"
            style={[inputStyle, zipError ? { borderColor: colors.danger } : null]}
          />
          {zipError ? (
            <Text style={{ color: colors.danger, fontSize: 12, marginTop: 4 }}>{zipError}</Text>
          ) : (
            <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 4 }}>
              Optional. Helps us plan auctions near you.
            </Text>
          )}

          {/* --- Date of birth picker --- */}
          <Pressable
            onPress={() => setShowDatePicker(true)}
            style={[inputStyle, { marginTop: 12, justifyContent: 'center' }]}
          >
            <Text style={{ color: dob ? colors.text : colors.textMuted, fontSize: 16 }}>
              {displayDate(dob)}
            </Text>
          </Pressable>

          {showDatePicker && (
            <DateTimePicker
              value={pickerDate}
              mode="date"
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              maximumDate={today()}
              onChange={onDateChange}
              textColor={colors.text}
            />
          )}

          {/* iOS inline picker has no dismiss — add a Done button */}
          {showDatePicker && Platform.OS === 'ios' && (
            <Pressable
              onPress={() => setShowDatePicker(false)}
              style={{
                alignSelf: 'flex-end',
                padding: 8,
                marginTop: 4,
              }}
            >
              <Text style={{ color: colors.primary, ...type.label, fontSize: 14 }}>Done</Text>
            </Pressable>
          )}

          {/* --- Consent checkboxes --- */}
          <View style={{ marginTop: 20, gap: 14 }}>
            <ConsentRow
              checked={ageAck}
              onChange={setAgeAck}
              label="I am at least 18 years old"
            />

            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
              <Checkbox
                value={tosAck}
                onValueChange={setTosAck}
                color={tosAck ? colors.primary : undefined}
                style={{ marginTop: 2 }}
              />
              <Text style={{ flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 }}>
                {'I agree to the '}
                <Text
                  style={{ color: colors.primary, textDecorationLine: 'underline' }}
                  onPress={() => WebBrowser.openBrowserAsync(`${LEGAL_BASE}/legal/terms`)}
                >
                  Terms of Service
                </Text>
                {' and '}
                <Text
                  style={{ color: colors.primary, textDecorationLine: 'underline' }}
                  onPress={() => WebBrowser.openBrowserAsync(`${LEGAL_BASE}/legal/privacy`)}
                >
                  Privacy Policy
                </Text>
              </Text>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
              <Checkbox
                value={bidderAck}
                onValueChange={setBidderAck}
                color={bidderAck ? colors.primary : undefined}
                style={{ marginTop: 2 }}
              />
              <Text style={{ flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 }}>
                {'I agree to the '}
                <Text
                  style={{ color: colors.primary, textDecorationLine: 'underline' }}
                  onPress={() =>
                    WebBrowser.openBrowserAsync(`${LEGAL_BASE}/legal/bidder-agreement`)
                  }
                >
                  Bidder Agreement
                </Text>
              </Text>
            </View>
          </View>

          {error && <Text style={{ color: colors.danger, marginTop: 12 }}>{error}</Text>}
          {info && <Text style={{ color: colors.success, marginTop: 12 }}>{info}</Text>}

          <BrandedButton
            variant="primary"
            size="md"
            onPress={onSubmit}
            loading={loading}
            disabled={!canSubmit && !loading}
            style={{ marginTop: 20 }}
          >
            {loading ? 'Creating…' : 'Create account'}
          </BrandedButton>

          <OAuthButtons onError={setError} />

          <Link
            href="/login"
            style={{ color: colors.primary, textAlign: 'center', marginTop: 24, fontSize: 14 }}
          >
            Already have an account? Sign in
          </Link>
        </ScrollView>
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );
}

function ConsentRow({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Checkbox
        value={checked}
        onValueChange={onChange}
        color={checked ? colors.primary : undefined}
      />
      <Text style={{ flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 }}>{label}</Text>
    </View>
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
