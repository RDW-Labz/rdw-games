// Bidder profile editing — display_name + phone + ZIP + notification preferences.
// Email is the auth identity and not edited here (use auth flow to change).
// ZIP (0434) is saved through set_my_postal_code(), never a direct update; the
// field is hidden when the bidder's ZIP can't be read (0434 not applied yet).

import { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  Alert,
  ActivityIndicator,
  Switch,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { router } from 'expo-router';
import { supabase } from '@auction-platform/supabase-client';
import { colors } from '@auction-platform/design-system';
import { fetchZipPromptState, sanitizeZipInput, saveMyZip, validateZip } from '@/lib/postal-code';
import {
  fetchOptionalProfileState,
  saveOptionalProfile,
  type OptionalProfileState,
} from '@/lib/optional-profile';
import { OptionalProfileFields } from '@/components/OptionalProfileFields';

export default function EditProfileScreen() {
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [pushEnabled, setPushEnabled] = useState(true);
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  // null = ZIP not readable (field hidden); otherwise the saved ZIP ('' = none).
  const [savedZip, setSavedZip] = useState<string | null>(null);
  const [zip, setZip] = useState('');
  const [zipError, setZipError] = useState<string | null>(null);

  // Optional profile fields (0448): null = not readable yet (section hidden,
  // same fail-soft rule as ZIP — before 0448 is applied or on a load error).
  const [optionalState, setOptionalState] = useState<OptionalProfileState | null>(null);
  const [smsConsent, setSmsConsent] = useState(false);
  const [heardAbout, setHeardAbout] = useState<string | null>(null);
  const [heardAboutOther, setHeardAboutOther] = useState('');

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data } = await supabase
        .from('bidders')
        .select(
          'display_name, phone, identity_verified_at, push_enabled, email_enabled, sms_enabled',
        )
        .eq('id', u.user.id)
        .single();
      if (data) {
        setDisplayName((data.display_name as string | null) ?? '');
        setPhone((data.phone as string | null) ?? '');
        setVerifiedAt((data.identity_verified_at as string | null) ?? null);
        setPushEnabled((data.push_enabled as boolean | null) ?? true);
        setEmailEnabled((data.email_enabled as boolean | null) ?? true);
        setSmsEnabled((data.sms_enabled as boolean | null) ?? false);
      }
      // Separate read so a missing column (before 0434) can't break the
      // profile load above.
      const zipState = await fetchZipPromptState(supabase, u.user.id);
      if (zipState) {
        setSavedZip(zipState.postal_code ?? '');
        setZip(zipState.postal_code ?? '');
      }

      // Same pattern for the 0448 optional-profile columns.
      const opt = await fetchOptionalProfileState(supabase, u.user.id);
      setOptionalState(opt);
      if (opt) {
        setSmsConsent(!!opt.sms_consent_at);
        setHeardAbout(opt.heard_about);
        setHeardAboutOther(opt.heard_about_other ?? '');
      }
      setLoading(false);
    })();
  }, []);

  function normalizePhone(raw: string): string | null {
    const digits = raw.replace(/[^\d+]/g, '');
    if (!digits) return null;
    if (digits.startsWith('+')) return digits;
    // Assume US if 10 digits, no country code typed.
    if (/^\d{10}$/.test(digits)) return `+1${digits}`;
    if (/^1\d{10}$/.test(digits)) return `+${digits}`;
    return digits.startsWith('+') ? digits : `+${digits}`;
  }

  async function save() {
    const zipCheck = validateZip(zip);
    if (savedZip !== null && !zipCheck.ok) {
      setZipError(zipCheck.error);
      return;
    }
    setZipError(null);
    setSaving(true);
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setSaving(false);
      return;
    }
    // SMS without a phone is meaningless — auto-disable to avoid silent loss.
    const phoneNormalized = normalizePhone(phone);
    const effectiveSms = smsEnabled && phoneNormalized != null;
    if (smsEnabled && !phoneNormalized) {
      Alert.alert(
        'Phone required for SMS',
        'Add a phone number above before enabling SMS notifications.',
      );
      setSaving(false);
      return;
    }
    const { error } = await supabase
      .from('bidders')
      .update({
        display_name: displayName.trim() || null,
        phone: phoneNormalized,
        push_enabled: pushEnabled,
        email_enabled: emailEnabled,
        sms_enabled: effectiveSms,
      })
      .eq('id', u.user.id);
    if (error) {
      setSaving(false);
      Alert.alert('Save failed', error.message);
      return;
    }
    if (savedZip !== null && zipCheck.ok && (zipCheck.zip ?? '') !== savedZip) {
      const res = await saveMyZip(supabase, zipCheck.zip);
      if (res === 'invalid') {
        setSaving(false);
        setZipError('Enter a 5-digit ZIP');
        return;
      }
      if (res === 'failed') {
        setSaving(false);
        Alert.alert('ZIP not saved', 'Your other changes were saved. Try the ZIP again in a moment.');
        return;
      }
      setSavedZip(zipCheck.zip ?? '');
    }
    // 0448: heard_about / heard_about_other, and SMS consent only if it
    // isn't already on record (see OptionalProfileFields' consentedAt note —
    // a timestamped consent is never re-sent/overwritten by this save).
    if (optionalState) {
      const res = await saveOptionalProfile(supabase, {
        smsConsent: optionalState.sms_consent_at ? false : smsConsent,
        heardAbout: heardAbout ?? undefined,
        heardAboutOther,
      });
      if (res === 'failed') {
        setSaving(false);
        Alert.alert(
          'Some changes not saved',
          'Your other changes were saved. Try "How did you hear about us?" again in a moment.',
        );
        return;
      }
    }
    setSaving(false);
    Alert.alert('Saved');
    router.back();
  }

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator color="#8a93a6" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: colors.bg }}
      // Stack header is shown for this route; offset accounts for it on iOS.
      keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
    >
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 24, paddingBottom: 64 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase' }}>
        Display name
      </Text>
      <TextInput
        value={displayName}
        onChangeText={setDisplayName}
        placeholder="What other bidders see"
        placeholderTextColor="#8a93a6"
        style={inputStyle}
        accessibilityLabel="Display name"
        accessibilityHint="What other bidders see"
      />

      <Text style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase', marginTop: 24 }}>
        Phone
      </Text>
      <TextInput
        value={phone}
        onChangeText={setPhone}
        placeholder="+1 (555) 555-5555"
        placeholderTextColor="#8a93a6"
        keyboardType="phone-pad"
        // UX-P2 (2026-05-24 audit): textContentType lets iOS autofill
        // from Contacts; autoComplete is the Android counterpart.
        textContentType="telephoneNumber"
        autoComplete="tel"
        style={inputStyle}
        accessibilityLabel="Phone number"
        accessibilityHint="Used by operators to contact you about pickups, and for SMS notifications if enabled"
      />
      <Text style={{ color: '#8a93a6', fontSize: 12, marginTop: 4 }}>
        Used by operators to contact you about pickups, and for SMS notifications if enabled.
      </Text>

      {savedZip !== null && (
        <>
          <Text style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase', marginTop: 24 }}>
            ZIP code
          </Text>
          <TextInput
            testID="profile-zip-input"
            value={zip}
            onChangeText={(t) => {
              setZip(sanitizeZipInput(t));
              if (zipError) setZipError(null);
            }}
            placeholder="Optional"
            placeholderTextColor="#8a93a6"
            keyboardType="number-pad"
            maxLength={5}
            textContentType="postalCode"
            autoComplete="postal-code"
            style={[inputStyle, zipError ? { borderColor: colors.danger } : null]}
            accessibilityLabel="ZIP code"
            accessibilityHint="Optional. Helps us plan auctions near you. Leave empty to remove it."
          />
          {zipError ? (
            <Text style={{ color: colors.danger, fontSize: 12, marginTop: 4 }}>{zipError}</Text>
          ) : (
            <Text style={{ color: '#8a93a6', fontSize: 12, marginTop: 4 }}>
              Optional. Helps us plan auctions near you. Clear it to remove it.
            </Text>
          )}
        </>
      )}

      {optionalState && (
        <View style={{ marginTop: 24 }}>
          <OptionalProfileFields
            phone={phone}
            onPhoneChange={setPhone}
            showPhoneField={false}
            smsConsent={smsConsent}
            onSmsConsentChange={setSmsConsent}
            consentedAt={optionalState.sms_consent_at}
            heardAbout={heardAbout}
            onHeardAboutChange={setHeardAbout}
            heardAboutOther={heardAboutOther}
            onHeardAboutOtherChange={setHeardAboutOther}
          />
        </View>
      )}

      <Text style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase', marginTop: 32 }}>
        Notifications
      </Text>
      <NotificationToggle
        label="Push"
        hint="Outbid alerts, won, pickup-ready, dispute updates."
        value={pushEnabled}
        onChange={setPushEnabled}
      />
      <NotificationToggle
        label="Email"
        hint="Same events, also delivered to your email."
        value={emailEnabled}
        onChange={setEmailEnabled}
      />
      <NotificationToggle
        label="SMS"
        hint={
          phone
            ? 'Text messages for high-priority events. Standard carrier rates apply.'
            : 'Add a phone number above to enable.'
        }
        value={smsEnabled}
        onChange={setSmsEnabled}
        disabled={!phone}
      />

      <View
        style={{
          marginTop: 32,
          padding: 12,
          borderColor: '#232839',
          borderWidth: 1,
          borderRadius: 6,
        }}
      >
        <Text style={{ color: '#8a93a6', fontSize: 12, textTransform: 'uppercase' }}>
          Identity verification
        </Text>
        <Text style={{ color: verifiedAt ? '#34d39a' : '#8a93a6', marginTop: 4 }}>
          {verifiedAt
            ? `Verified ${new Date(verifiedAt).toLocaleDateString()}`
            : 'Not verified yet'}
        </Text>
      </View>

      <Pressable
        onPress={save}
        disabled={saving}
        style={{
          marginTop: 32,
          padding: 16,
          backgroundColor: '#4f8cff',
          borderRadius: 8,
          opacity: saving ? 0.6 : 1,
        }}
      >
        {saving ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={{ color: '#fff', textAlign: 'center', fontWeight: '700', fontSize: 16 }}>
            Save
          </Text>
        )}
      </Pressable>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

function NotificationToggle({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View
      style={{
        marginTop: 12,
        padding: 12,
        borderColor: '#232839',
        borderWidth: 1,
        borderRadius: 6,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#e8eaf0', fontSize: 15, fontWeight: '600' }}>{label}</Text>
        <Text style={{ color: '#8a93a6', fontSize: 12, marginTop: 2 }}>{hint}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: '#232839', true: '#4f8cff' }}
        thumbColor={value ? '#fff' : '#8a93a6'}
      />
    </View>
  );
}

const inputStyle = {
  marginTop: 4,
  padding: 14,
  backgroundColor: '#1c2e49',
  borderColor: '#232839',
  borderWidth: 1,
  borderRadius: 6,
  color: '#e8eaf0',
  fontSize: 16,
};
