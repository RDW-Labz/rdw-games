// One-time "What's your ZIP code?" sheet on the home (Browse) tab (0434).
//
// Never blocks anything: it is a dismissible bottom sheet that only shows
// while the home tab is focused, a short moment after launch, for a signed-in
// bidder whose own row says it's due (lib/postal-code.ts isZipPromptDue). It
// is never mounted on lot / bid / checkout / payment screens, and it hides as
// soon as Browse loses focus. Checked once per app launch.
//
// "Not now" (and Android back) → snooze_my_postal_code_prompt(): hidden for 30
// days; after the third time it never comes back. Every server error is
// ignored: before 0434 is applied the lookup fails and the sheet never shows.

import { useCallback, useEffect, useRef, useState } from 'react';
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
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@auction-platform/supabase-client';
import { colors, type } from '@auction-platform/design-system';
import {
  PENDING_ZIP_STORAGE_KEY,
  fetchZipPromptState,
  isZipPromptDue,
  pendingZipFor,
  sanitizeZipInput,
  saveMyZip,
  snoozeZipPrompt,
  validateZip,
} from '@/lib/postal-code';

/** Wait this long on Browse before showing, so a launch that deep-links
 *  straight into a lot never flashes the sheet. */
const SHOW_DELAY_MS = 2500;

// Once per app process ("on next launch"), not once per Browse mount.
let checkedThisLaunch = false;

export function ZipPrompt({ suppressed }: { suppressed?: boolean }) {
  const [due, setDue] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  const [zip, setZip] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const closedRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  useEffect(() => {
    if (checkedThisLaunch) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const user = data.session?.user;
        if (!user) return; // not signed in: check again on a later mount
        checkedThisLaunch = true;

        let state = await fetchZipPromptState(supabase, user.id);
        if (!state) return; // lookup failed / 0434 not applied → never prompt

        // A ZIP typed at email signup (no session then) is saved now.
        let pendingRaw: string | null = null;
        try {
          pendingRaw = await AsyncStorage.getItem(PENDING_ZIP_STORAGE_KEY);
        } catch {
          pendingRaw = null;
        }
        const pending = pendingZipFor(pendingRaw, user.email);
        if (pendingRaw) {
          if (!pending || state.postal_code) {
            AsyncStorage.removeItem(PENDING_ZIP_STORAGE_KEY).catch(() => {});
          } else {
            const res = await saveMyZip(supabase, pending);
            if (res !== 'failed') AsyncStorage.removeItem(PENDING_ZIP_STORAGE_KEY).catch(() => {});
            if (res === 'saved') state = { ...state, postal_code: pending };
          }
        }

        if (!cancelled && isZipPromptDue(state, new Date())) setDue(true);
      } catch {
        /* fail soft: no prompt */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!due || !focused || suppressed || closedRef.current) {
      setVisible(false);
      return;
    }
    const t = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => clearTimeout(t);
  }, [due, focused, suppressed]);

  function close() {
    closedRef.current = true;
    setVisible(false);
    setDue(false);
    Keyboard.dismiss();
  }

  function notNow() {
    close();
    void snoozeZipPrompt(supabase);
  }

  async function save() {
    const v = validateZip(zip);
    if (!v.ok || v.zip === null) {
      setError(v.ok ? 'Enter a 5-digit ZIP' : v.error);
      return;
    }
    setError(null);
    setSaving(true);
    const res = await saveMyZip(supabase, v.zip);
    setSaving(false);
    if (res === 'invalid') {
      setError('Enter a 5-digit ZIP');
      return;
    }
    // 'saved', or 'failed' (offline / server not ready): either way get out
    // of the bidder's way. A failed save leaves the ZIP empty, so the prompt
    // can come back on a later launch.
    close();
  }

  if (!visible) return null;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={notNow}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          onPress={notNow}
          accessibilityLabel="Close"
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' }}
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
            What&apos;s your ZIP code?
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 14, marginTop: 4 }}>
            (helps us plan auctions near you)
          </Text>
          <TextInput
            testID="zip-prompt-input"
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
              testID="zip-prompt-not-now"
              onPress={notNow}
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
              <Text style={{ color: colors.text, fontWeight: '700' }}>Not now</Text>
            </Pressable>
            <Pressable
              testID="zip-prompt-save"
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
                <Text style={{ color: colors.bg, fontWeight: '800' }}>Save</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
