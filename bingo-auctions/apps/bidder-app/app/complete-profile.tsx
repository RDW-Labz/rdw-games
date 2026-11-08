// /complete-profile — DOB + consent collection for OAuth bidders.
//
// Apple/Google Sign In creates a Supabase auth.users row but cannot
// supply birth_date, which migration 0082's trigger requires for any
// new bidder created after 2026-05-16. This screen collects the missing
// info and calls /api/bidder/signup to create the bidders row.
//
// Flow:
//   1. Apple Sign In → session created → root layout mounts (tabs)
//   2. useBidderRole sees session but no bidders row → state =
//      'pending_provision' → (tabs)/_layout.tsx routes here
//   3. User fills DOB + consents → POSTs to /api/bidder/signup
//   4. On success → router.replace('/(tabs)/') → tabs remount
//   5. useBidderRole re-runs → bidder row now exists → state = 'bidder'
//
// Modeled after (auth)/signup.tsx minus auth.signUp (user is already
// authenticated) and minus display name input (uses what Apple/Google
// provided in user_metadata.full_name or falls back to the email prefix).

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
  View,
} from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import Checkbox from 'expo-checkbox';
import * as WebBrowser from 'expo-web-browser';
import { useRouter } from 'expo-router';
import { supabase } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';
import { captureSignupCompleted } from '@/lib/analytics';
import { sanitizeZipInput, saveMyZip, validateZip } from '@/lib/postal-code';

const OPERATOR_WEB_URL =
  (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_OPERATOR_WEB_URL) ||
  'https://bingoauctions.com';

const LEGAL_BASE = OPERATOR_WEB_URL;

function today(): Date {
  return new Date();
}

function calcAge(dob: Date): number {
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function displayDate(d: Date | null): string {
  if (!d) return 'Select date of birth';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function CompleteProfileScreen() {
  const router = useRouter();

  const [dob, setDob] = useState<Date | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [pickerDate, setPickerDate] = useState<Date>(new Date(2000, 0, 1));

  const [ageAck, setAgeAck] = useState(false);
  const [tosAck, setTosAck] = useState(false);
  const [bidderAck, setBidderAck] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Optional ZIP (0434). Empty never blocks; only a non-empty, non-5-digit
  // value asks to be fixed.
  const [zip, setZip] = useState('');
  const [zipError, setZipError] = useState<string | null>(null);

  function onDateChange(_event: DateTimePickerEvent, selected?: Date) {
    if (Platform.OS === 'android') setShowDatePicker(false);
    if (selected) {
      setPickerDate(selected);
      setDob(selected);
    }
  }

  const canSubmit = !loading && !!dob && ageAck && tosAck && bidderAck;

  async function onSubmit() {
    setError(null);
    if (!dob) {
      setError('Date of birth is required.');
      return;
    }
    if (calcAge(dob) < 18) {
      setError('You must be at least 18 years old to bid.');
      return;
    }
    if (!ageAck || !tosAck || !bidderAck) {
      setError('Please check all required boxes.');
      return;
    }
    const zipCheck = validateZip(zip);
    if (!zipCheck.ok) {
      setZipError(zipCheck.error);
      return;
    }
    setLoading(true);

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setError('Session expired. Please sign in again.');
      setLoading(false);
      router.replace('/login');
      return;
    }

    try {
      const res = await fetch(`${OPERATOR_WEB_URL}/api/bidder/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          birth_date: toISODate(dob),
          consent_slugs: ['terms', 'privacy', 'bidder-agreement'],
          consent_method: 'oauth_signup_checkbox',
        }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        setError(json.error ?? 'Profile completion failed. Please try again.');
        setLoading(false);
        return;
      }
    } catch {
      setError('Network error — please check your connection and try again.');
      setLoading(false);
      return;
    }

    captureSignupCompleted({ method: 'oauth' });

    // Best effort: a ZIP that doesn't save (offline, server not ready) never
    // holds up signup; the home-screen prompt asks again later.
    if (zipCheck.zip) await saveMyZip(supabase, zipCheck.zip);

    setLoading(false);
    // 2026-06-02 (Apple Guideline 2.1 rejection): land the new bidder
    // straight in (tabs) so they can browse auctions, open lots, and view
    // their profile WITHOUT a card on file. The auto-charge policy (mig
    // 0105) is still enforced server-side — place_bid() returns
    // 'no_payment_method' and app/lot/[id].tsx's dispatchRejectionAction
    // routes to /profile/payment-method at the moment a bid is placed.
    // A card is therefore required to BID, never to browse. Forcing the
    // card-onboarding screen here was the hard gate the App Review demo
    // account dead-ended on ("ONE LAST THING — Add a card to start
    // bidding" with no way forward). Removed.
    router.replace('/(tabs)' as never);
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
          <Text style={{ color: colors.text, fontSize: 28, ...type.displayHero, marginBottom: 8 }}>
            One more step
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 14, marginBottom: 24, lineHeight: 20 }}>
            Auctions are age-restricted. We need your date of birth and a
            quick acknowledgement before you can bid.
          </Text>

          <Pressable
            onPress={() => setShowDatePicker(true)}
            style={[inputStyle, { justifyContent: 'center' }]}
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

          {showDatePicker && Platform.OS === 'ios' && (
            <Pressable
              onPress={() => setShowDatePicker(false)}
              style={{ alignSelf: 'flex-end', padding: 8, marginTop: 4 }}
            >
              <Text style={{ color: colors.primary, ...type.label, fontSize: 14 }}>Done</Text>
            </Pressable>
          )}

          <TextInput
            testID="complete-profile-zip"
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

          <View style={{ marginTop: 20, gap: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Checkbox
                value={ageAck}
                onValueChange={setAgeAck}
                color={ageAck ? colors.primary : undefined}
              />
              <Text style={{ flex: 1, color: colors.text, fontSize: 14, lineHeight: 20 }}>
                I am at least 18 years old
              </Text>
            </View>

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

          {error && <Text style={{ color: colors.danger, marginTop: 14 }}>{error}</Text>}

          <Pressable
            onPress={onSubmit}
            disabled={!canSubmit}
            style={{
              marginTop: 20,
              padding: 16,
              backgroundColor: colors.primary,
              borderRadius: 10,
              opacity: canSubmit ? 1 : 0.5,
            }}
          >
            <Text
              style={{ color: '#000', textAlign: 'center', fontSize: 15, ...type.label }}
            >
              {loading ? 'Continuing…' : 'Continue'}
            </Text>
          </Pressable>

          <Pressable
            onPress={async () => {
              // scope:'local' — this device only (2026-07-10 shared-login incident).
              await supabase.auth.signOut({ scope: 'local' });
              router.replace('/login');
            }}
            style={{ marginTop: 24, padding: 12 }}
          >
            <Text style={{ color: colors.textMuted, textAlign: 'center', fontSize: 13 }}>
              Sign out
            </Text>
          </Pressable>
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
