// The mandatory ZIP sheet. Mounted ONCE at the app root (app/_layout.tsx);
// every bid/checkout call site opens it indirectly by calling
// lib/zip-gate.ts's requireZip() — this component just answers.
//
// Unlike components/home/ZipPrompt.tsx (dismissible, snoozable, home-tab
// only), this one has no snooze and no "Not now": "Cancel" simply backs out
// of the bid/checkout action that triggered it (nothing is placed/charged),
// and the bidder sees the same block on their very next attempt.

import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supabase } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';
import { sanitizeZipInput } from '@/lib/postal-code';
import { checkZip, registerZipGateListener, resolveZipGate, saveAndResolveZipGate } from '@/lib/zip-gate';
import {
  fetchOptionalProfileState,
  needsOptionalProfilePrompt,
  saveOptionalProfile,
} from '@/lib/optional-profile';
import { OptionalProfileFields } from '@/components/OptionalProfileFields';

type Step = 'zip' | 'optional';

export function ZipGateHost() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState<Step>('zip');
  const [zip, setZip] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Optional-profile step fields.
  const [phone, setPhone] = useState('');
  const [smsConsent, setSmsConsent] = useState(false);
  const [heardAbout, setHeardAbout] = useState<string | null>(null);
  const [heardAboutOther, setHeardAboutOther] = useState('');

  useEffect(() => {
    registerZipGateListener((open) => {
      if (open) {
        setStep('zip');
        setZip('');
        setError(null);
        setPhone('');
        setSmsConsent(false);
        setHeardAbout(null);
        setHeardAboutOther('');
      }
      setVisible(open);
    });
    return () => registerZipGateListener(null);
  }, []);

  function cancel() {
    Keyboard.dismiss();
    setVisible(false);
    resolveZipGate(false);
  }

  /** After a successful ZIP save: offer the optional-profile step once
   *  (skippable), never again once optional_profile_prompted_at is set. A
   *  failed/unknown lookup (0448 not applied, offline) means "don't show" —
   *  this step never blocks anything the ZIP step didn't already clear. */
  async function maybeShowOptionalStep() {
    const { data } = await supabase.auth.getUser();
    const uid = data.user?.id;
    const state = uid ? await fetchOptionalProfileState(supabase, uid) : null;
    if (needsOptionalProfilePrompt(state)) {
      setStep('optional');
      return;
    }
    setVisible(false);
  }

  async function save() {
    setError(null);
    setSaving(true);
    const result = await checkZip(zip);
    if (!result.ok) {
      setSaving(false);
      setError(result.error);
      return;
    }
    const res = await saveAndResolveZipGate(result.zip);
    setSaving(false);
    if (res === 'invalid') {
      setError('Enter a 5-digit ZIP');
      return;
    }
    if (res === 'failed') {
      setError('Could not save your ZIP. Check your connection and try again.');
      return;
    }
    // 'saved' — the waiting bid/checkout call already resolved true (see
    // resolveZipGate). Offer the optional step next, still in this sheet.
    void maybeShowOptionalStep();
  }

  function skipOptional() {
    setVisible(false);
    void saveOptionalProfile(supabase, { smsConsent: false });
  }

  async function saveOptional() {
    setSaving(true);
    const res = await saveOptionalProfile(supabase, {
      phone: phone.trim() || null,
      smsConsent,
      heardAbout: heardAbout ?? undefined,
      heardAboutOther,
    });
    setSaving(false);
    // Any outcome (saved, invalid, failed) closes the nudge — this step
    // never blocks anything. An invalid/failed save just means the bidder
    // can set it later from their profile.
    setVisible(false);
  }

  if (!visible) return null;

  if (step === 'optional') {
    return (
      <Modal visible animationType="slide" transparent onRequestClose={skipOptional}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          <Pressable
            onPress={skipOptional}
            accessibilityLabel="Close"
            style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' }}
          />
          <View
            accessibilityViewIsModal
            style={{
              backgroundColor: colors.bg,
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              borderTopWidth: 1,
              borderColor: colors.border,
              padding: 18,
              paddingBottom: 28,
              maxHeight: '85%',
            }}
          >
            <Text style={{ color: colors.text, fontSize: 18, ...type.display }}>
              A couple more things? (optional)
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 14, marginTop: 4 }}>
              Skip any of this — you can always add it later from your profile.
            </Text>
            <View style={{ marginTop: 14 }}>
              <OptionalProfileFields
                phone={phone}
                onPhoneChange={setPhone}
                smsConsent={smsConsent}
                onSmsConsentChange={setSmsConsent}
                heardAbout={heardAbout}
                onHeardAboutChange={setHeardAbout}
                heardAboutOther={heardAboutOther}
                onHeardAboutOtherChange={setHeardAboutOther}
              />
            </View>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
              <Pressable
                testID="optional-profile-skip"
                onPress={skipOptional}
                disabled={saving}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: colors.border,
                  alignItems: 'center',
                  opacity: saving ? 0.5 : 1,
                }}
              >
                <Text style={{ color: colors.text, fontWeight: '700' }}>Skip</Text>
              </Pressable>
              <Pressable
                testID="optional-profile-save"
                onPress={() => void saveOptional()}
                disabled={saving}
                style={{
                  flex: 1,
                  paddingVertical: 14,
                  borderRadius: 10,
                  backgroundColor: colors.primary,
                  alignItems: 'center',
                  opacity: saving ? 0.7 : 1,
                }}
              >
                {saving ? (
                  <ActivityIndicator color={colors.bg} />
                ) : (
                  <Text style={{ color: colors.bg, fontWeight: '800' }}>Save</Text>
                )}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    );
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={cancel}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          onPress={cancel}
          accessibilityLabel="Close"
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' }}
        />
        <View
          accessibilityViewIsModal
          style={{
            backgroundColor: colors.bg,
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
            borderTopWidth: 1,
            borderColor: colors.border,
            padding: 18,
            paddingBottom: 28,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 18, ...type.display }}>
            Your ZIP code
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 14, marginTop: 4 }}>
            One-time — we need this before you bid or check out.
          </Text>
          <TextInput
            testID="zip-gate-input"
            value={zip}
            onChangeText={(t) => {
              setZip(sanitizeZipInput(t));
              if (error) setError(null);
            }}
            placeholder="ZIP code"
            placeholderTextColor={colors.textMuted}
            keyboardType="number-pad"
            maxLength={5}
            textContentType="postalCode"
            autoComplete="postal-code"
            returnKeyType="done"
            autoFocus
            onSubmitEditing={save}
            accessibilityLabel="ZIP code"
            style={{
              marginTop: 14,
              padding: 14,
              backgroundColor: colors.surface,
              borderColor: error ? colors.danger : colors.border,
              borderWidth: 1,
              borderRadius: 10,
              color: colors.text,
              fontSize: 18,
              letterSpacing: 2,
            }}
          />
          {error && <Text style={{ color: colors.danger, marginTop: 6 }}>{error}</Text>}
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
            <Pressable
              testID="zip-gate-cancel"
              onPress={cancel}
              disabled={saving}
              style={{
                flex: 1,
                paddingVertical: 14,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.border,
                alignItems: 'center',
                opacity: saving ? 0.5 : 1,
              }}
            >
              <Text style={{ color: colors.text, fontWeight: '700' }}>Cancel</Text>
            </Pressable>
            <Pressable
              testID="zip-gate-save"
              onPress={save}
              disabled={saving}
              style={{
                flex: 1,
                paddingVertical: 14,
                borderRadius: 10,
                backgroundColor: colors.primary,
                alignItems: 'center',
                opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? (
                <ActivityIndicator color={colors.bg} />
              ) : (
                <Text style={{ color: colors.bg, fontWeight: '800' }}>Continue</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
