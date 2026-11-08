// Bidder feedback — "Report a bug or suggest an idea".
//
// Owner ask 2026-08-13. Distinct from /dispute/new, which is deliberately
// money-bearing: a dispute attaches to an invoice and a lot and resolves into
// a refund decision. This is for "the watchlist tab scrolls to the top every
// time I come back" — no lot, no money, nowhere to go before now.
//
// The form asks for two things (which kind, what happened) and collects the
// rest. Build/OTA/device identity comes from collectDiagnostics() rather than
// from the reporter, because a bug report that can't say which bundle it came
// from costs a triage round-trip every time — see #248, where a tester sat on
// a stale build for eight days and nobody could tell.

import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  submitFeedback,
  collectDiagnostics,
  FEEDBACK_MIN_LENGTH,
  type FeedbackKind,
} from '@auction-platform/supabase-client';
import { BrandedButton, colors } from '@auction-platform/design-system';
import { ErrorBoundary } from '../../components/ErrorBoundary';

const CARD_BG = '#1A1D24';
const CARD_BORDER = '#232839';
const TEXT_PRIMARY = '#e8eaf0';
const TEXT_MUTED = '#8a93a6';
// Accent tracks the live brand (BinGo orange) rather than the stale
// '#5FE065' literal still hard-coded in profile.tsx — the chips sit directly
// above a BrandedButton `primary`, and two different accents in one column
// reads as a bug.
const ACCENT = colors.primary;
// Selected-chip wash. Kept as an explicit rgba rather than an opacity on the
// whole Pressable so the label text stays at full contrast.
const SELECTED_CHIP_BG = 'rgba(255, 122, 0, 0.10)';

export default function FeedbackScreen() {
  return (
    <ErrorBoundary label="Feedback">
      <FeedbackScreenInner />
    </ErrorBoundary>
  );
}

function FeedbackScreenInner() {
  // Which entry point sent them here. The Profile card passes nothing; the
  // invoice-screen link passes from=invoice. Recorded as `screen` so we can
  // tell whether a new entry point actually produces reports instead of
  // guessing — the Profile card took zero in its first sixteen days, and
  // without this we could not tell a working link from an unused one.
  const { from } = useLocalSearchParams<{ from?: string }>();
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const diagnostics = collectDiagnostics();
  const tooShort = message.trim().length < FEEDBACK_MIN_LENGTH;

  async function send() {
    if (busy || tooShort) return;
    setBusy(true);
    try {
      const result = await submitFeedback({
        app: 'bidder',
        kind,
        message,
        screen: from ? `/profile/feedback?from=${from}` : '/profile/feedback',
      });
      if (!result.ok) {
        Alert.alert("Couldn't send", result.reason);
        return;
      }
      Alert.alert(
        'Thank you',
        kind === 'bug'
          ? "Your report is in. We'll take a look — you don't need to do anything else."
          : "Your idea is in. We read every one of these.",
        [{ text: 'OK', onPress: () => router.back() }],
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: colors.bg }}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 96 : 0}
    >
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={{ padding: 16, paddingBottom: 64 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: TEXT_PRIMARY, fontSize: 22, fontWeight: '800' }}>
          Tell us what you think
        </Text>
        <Text style={{ color: TEXT_MUTED, marginTop: 8, lineHeight: 20 }}>
          Found something broken, or thought of something that would make BinGo
          better? This goes straight to the people who build the app.
        </Text>

        {/* Problems with a specific item you won are a different thing, and
            they need the invoice + photos the dispute flow captures. Point at
            it explicitly so those don't land here and stall. */}
        <Text style={{ color: TEXT_MUTED, marginTop: 10, fontSize: 12, lineHeight: 18 }}>
          Something wrong with an item you won? Use{' '}
          <Text style={{ color: ACCENT, fontWeight: '700' }}>Report a problem</Text>{' '}
          on that invoice instead — it reaches the warehouse with your photos.
        </Text>

        <KindChips value={kind} onChange={setKind} />

        <Text
          style={{
            color: TEXT_MUTED,
            fontSize: 12,
            textTransform: 'uppercase',
            marginTop: 24,
            letterSpacing: 0.6,
          }}
        >
          {kind === 'bug' ? 'What happened?' : "What's your idea?"}
        </Text>
        <TextInput
          value={message}
          onChangeText={setMessage}
          placeholder={
            kind === 'bug'
              ? 'e.g. I tapped Watchlist and the app closed. It happens every time right after I place a bid.'
              : 'e.g. Let me set a max bid on a whole auction, not one lot at a time.'
          }
          placeholderTextColor={TEXT_MUTED}
          multiline
          textAlignVertical="top"
          accessibilityLabel={kind === 'bug' ? 'Describe what happened' : 'Describe your idea'}
          style={{
            marginTop: 8,
            backgroundColor: CARD_BG,
            borderColor: CARD_BORDER,
            borderWidth: 1,
            borderRadius: 8,
            padding: 12,
            color: TEXT_PRIMARY,
            minHeight: 140,
            fontSize: 15,
          }}
        />

        <DiagnosticsNote
          appVersion={diagnostics.app_version}
          updateId={diagnostics.update_id}
          deviceModel={diagnostics.device_model}
          osVersion={diagnostics.os_version}
        />

        <View style={{ marginTop: 20 }}>
          <BrandedButton
            variant="primary"
            size="lg"
            loading={busy}
            disabled={tooShort}
            onPress={() => void send()}
          >
            {kind === 'bug' ? 'Send report' : 'Send idea'}
          </BrandedButton>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// Two chips rather than a picker: the choice is binary and a tester should be
// able to make it without reading. Both stay visible so the unselected option
// is discoverable — a segmented control that hides its alternative trains
// people to file everything as whichever one is default.
function KindChips({
  value,
  onChange,
}: {
  value: FeedbackKind;
  onChange: (next: FeedbackKind) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
      {(['bug', 'idea'] as const).map((k) => {
        const selected = value === k;
        return (
          <Pressable
            key={k}
            onPress={() => onChange(k)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={k === 'bug' ? 'Report a bug' : 'Suggest an idea'}
            style={{
              flex: 1,
              minHeight: 56,
              justifyContent: 'center',
              paddingVertical: 12,
              paddingHorizontal: 14,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: selected ? ACCENT : CARD_BORDER,
              backgroundColor: selected ? SELECTED_CHIP_BG : CARD_BG,
            }}
          >
            <Text
              style={{
                color: selected ? ACCENT : TEXT_PRIMARY,
                fontWeight: '800',
                fontSize: 15,
              }}
            >
              {k === 'bug' ? 'Something’s broken' : 'I have an idea'}
            </Text>
            <Text style={{ color: TEXT_MUTED, fontSize: 12, marginTop: 2 }}>
              {k === 'bug' ? 'Report a bug' : 'Suggest an improvement'}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// Shown, not hidden: the reporter should know what's attached before they
// send. It's also the fastest way for them to read their own build number
// back to us over the phone.
function DiagnosticsNote({
  appVersion,
  updateId,
  deviceModel,
  osVersion,
}: {
  appVersion: string | null;
  updateId: string | null;
  deviceModel: string | null;
  osVersion: string | null;
}) {
  const short = updateId && updateId !== 'embedded' ? updateId.slice(0, 8) : 'embedded';
  return (
    <View
      style={{
        marginTop: 16,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: CARD_BORDER,
        backgroundColor: CARD_BG,
      }}
    >
      <Text style={{ color: TEXT_MUTED, fontSize: 12, lineHeight: 18 }}>
        We&apos;ll attach your app version and device so we can reproduce it:
      </Text>
      <Text style={{ color: TEXT_PRIMARY, fontSize: 12, marginTop: 4, fontWeight: '600' }}>
        v{appVersion ?? '?'} · {short}
        {deviceModel ? ` · ${deviceModel}` : ''}
        {osVersion ? ` · ${Platform.OS === 'ios' ? 'iOS' : 'Android'} ${osVersion}` : ''}
      </Text>
    </View>
  );
}
