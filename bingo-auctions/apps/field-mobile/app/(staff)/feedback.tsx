// Staff feedback — the TestFlight testers' channel back to us.
//
// Owner ask 2026-08-13: "Could we make a submit bug or recommendation for my
// testers somewhere." Until now a tester who hit something broken on the
// warehouse floor had to remember it, leave the app, and text about it. Most
// of that never arrives.
//
// TWO THINGS THIS CAPTURES THAT A TEXT MESSAGE CANNOT:
//
//   1. The bundle. app_version + update_id come off the device. #248 cost a
//      tester eight days on build 27 while 28-31 shipped past him, and the
//      only reason it went unnoticed that long is that nobody could say which
//      build a given phone was on. Every report now says.
//   2. Who filed it. This app signs in once per *device* as a shared station
//      account, then identifies the human by PIN (WorkerContext). So author_id
//      is the iPhone. The clocked-in worker's name rides along in
//      reporter_label — otherwise a report from the packing station is
//      unattributable and we can't ask a follow-up question.
//
// ── AND THE WAY BACK (2026-08-30) ───────────────────────────────────────────
// The form was write-only for its first two weeks. Twenty reports came in;
// most were fixed and shipped; every one of them still read 'new' to the
// person who filed it, because nothing ever showed them otherwise. From the
// floor that is indistinguishable from nobody reading them, and the cost is
// the twenty-first report never getting written.
//
// So the screen now shows the reporter their own reports back, with the
// status and whatever note triage left. Opening it marks them seen, which is
// what clears the badge on the home screen.

import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Image,
  ActivityIndicator,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as Crypto from 'expo-crypto';
import {
  submitFeedback,
  collectDiagnostics,
  listMyReports,
  FEEDBACK_MIN_LENGTH,
  FEEDBACK_STATUS_LABEL,
  supabase,
  type FeedbackKind,
  type FeedbackAttachment,
  type FeedbackReport,
} from '@auction-platform/supabase-client';
import { markSeen } from '@/features/feedback/seen-store';
import { feedbackAck, REPLY_LABEL } from '@/lib/feedback-ack';
import { uploadFileFromUri } from '@/lib/upload-file';
import { colors, type } from '@auction-platform/design-system';
import { useActiveWorker } from '@/features/auth/WorkerContext';

/** 0325's CHECK allows six; the UI stops at three, which is plenty of evidence
 *  for one bug and keeps the upload burden off warehouse wifi. */
const MAX_ATTACHMENTS = 3;

function extensionFor(fileName: string | null | undefined, contentType: string): string {
  const fromName = fileName?.split('.').pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,4}$/.test(fromName)) return fromName;
  if (contentType.includes('quicktime')) return 'mov';
  if (contentType.startsWith('video')) return 'mp4';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('heic')) return 'heic';
  return 'jpg';
}

export default function StaffFeedbackScreen() {
  const { worker } = useActiveWorker();
  // Set when the form is opened from a specific failure — e.g. the "Report it"
  // button on AI mode's crash-recovery prompt. A report that names the screen
  // it came from is worth several that say "the app".
  const { from } = useLocalSearchParams<{ from?: string }>();
  const [attachments, setAttachments] = useState<
    (FeedbackAttachment & { localUri: string })[]
  >([]);
  const [uploading, setUploading] = useState(false);
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const [reports, setReports] = useState<FeedbackReport[] | null>(null);

  const diagnostics = collectDiagnostics();
  const tooShort = message.trim().length < FEEDBACK_MIN_LENGTH;

  const loadReports = useCallback(async () => {
    const label = worker?.displayName ?? null;
    if (!label) {
      setReports([]);
      return;
    }
    const rows = await listMyReports(label);
    setReports(rows);
    // Seen on arrival, not on scroll. They are looking at the list; a badge
    // that survives the visit would just be noise on the next home screen.
    void markSeen(label);
  }, [worker?.displayName]);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  // Uploaded on pick, not on submit. Two reasons: a 40 MB recording finishing
  // in the background while they type costs no extra wait, and an upload that
  // fails is recoverable here — on submit it would either lose the words
  // already typed or send a report whose evidence silently vanished.
  const addAttachment = useCallback(async () => {
    if (uploading || attachments.length >= MAX_ATTACHMENTS) return;

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.7,
      // 180s, raised from 60 on 2026-08-20: a staff member tried to attach a recording
      // of the crash and it was too long. A bug that takes a minute to
      // reproduce is exactly the bug worth filming, and the cap was cutting
      // off the evidence right where it got useful.
      videoMaxDuration: 180,
    }).catch(() => null);
    if (!picked || picked.canceled || !picked.assets?.[0]) return;

    const asset = picked.assets[0];
    const { data: u } = await supabase.auth.getUser();
    if (!u?.user) {
      Alert.alert('Signed out', 'Sign in and try again.');
      return;
    }

    const isVideo = asset.type === 'video';
    const contentType =
      asset.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg');
    const ext = extensionFor(asset.fileName, contentType);
    // uid folder first — mig 0325's INSERT policy checks exactly that segment.
    const path = `${u.user.id}/${Crypto.randomUUID()}.${ext}`;

    setUploading(true);
    try {
      const result = await uploadFileFromUri(
        'feedback-attachments',
        path,
        asset.uri,
        contentType,
      );
      if (!result.ok) {
        Alert.alert("Couldn't attach that", result.reason);
        return;
      }
      setAttachments((prev) => [
        ...prev,
        { path, content_type: contentType, bytes: result.bytes, localUri: asset.uri },
      ]);
    } finally {
      setUploading(false);
    }
  }, [attachments.length, uploading]);

  async function send() {
    if (busy || tooShort) return;
    setBusy(true);
    try {
      const result = await submitFeedback({
        app: 'staff',
        kind,
        message,
        screen: typeof from === 'string' && from ? from : '/feedback',
        reporterLabel: worker?.displayName ?? null,
        attachments: attachments.map(({ path, content_type, bytes }) => ({
          path,
          content_type,
          bytes,
        })),
      });
      if (!result.ok) {
        Alert.alert("Couldn't send", result.reason);
        return;
      }
      const ack = feedbackAck(worker?.displayName);
      Alert.alert(ack.title, ack.body, [{ text: 'OK', onPress: () => router.back() }]);
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
        testID="staff-feedback-screen"
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={{ padding: 24, paddingBottom: 64 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: colors.text, fontSize: 24, ...type.displayHero }}>
          Report a bug or idea
        </Text>
        <Text
          style={{
            color: colors.textMuted,
            marginTop: 8,
            fontSize: 14,
            lineHeight: 20,
          }}
        >
          Anything that slowed you down, broke, or should work differently.
          Short and specific beats polished.
        </Text>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
          {(['bug', 'idea'] as const).map((k) => {
            const selected = kind === k;
            return (
              <Pressable
                key={k}
                testID={`feedback-kind-${k}`}
                onPress={() => setKind(k)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                style={{
                  flex: 1,
                  minHeight: 56,
                  justifyContent: 'center',
                  padding: 14,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: selected ? colors.primary : colors.border,
                  backgroundColor: selected ? colors.primary : colors.surface,
                }}
              >
                <Text
                  style={{
                    color: selected ? '#000' : colors.text,
                    fontSize: 14,
                    ...type.label,
                  }}
                >
                  {k === 'bug' ? 'Something broke' : 'I have an idea'}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text
          style={{
            color: colors.textMuted,
            fontSize: 11,
            marginTop: 24,
            ...type.label,
          }}
        >
          {kind === 'bug' ? 'What happened?' : "What's your idea?"}
        </Text>
        <TextInput
          testID="feedback-message"
          value={message}
          onChangeText={setMessage}
          placeholder={
            kind === 'bug'
              ? 'e.g. Scanning a relot label on Quick Lot spins forever. Happens on every box from the blue cart.'
              : 'e.g. Let me print a label straight from the bin audit screen.'
          }
          placeholderTextColor={colors.textMuted}
          multiline
          textAlignVertical="top"
          accessibilityLabel={kind === 'bug' ? 'Describe what happened' : 'Describe your idea'}
          style={{
            marginTop: 8,
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 10,
            padding: 12,
            color: colors.text,
            minHeight: 140,
            fontSize: 15,
          }}
        />

        {/* Evidence. A five-second recording of the app closing itself says
            more than any description of it, and is the only way to show a
            failure the reporter cannot reproduce on demand. */}
        <View style={{ marginTop: 20 }}>
          <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
            Screenshot or screen recording (optional)
          </Text>

          {attachments.length > 0 && (
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              {attachments.map((a) => (
                <View key={a.path} style={{ alignItems: 'center' }}>
                  {/* A video thumbnail would need another native module; the
                      label is honest and costs nothing. */}
                  {a.content_type.startsWith('video') ? (
                    <View
                      style={{
                        width: 72,
                        height: 72,
                        borderRadius: 8,
                        borderWidth: 1,
                        borderColor: colors.border,
                        backgroundColor: colors.surface,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ color: colors.text, fontSize: 11 }}>Video</Text>
                    </View>
                  ) : (
                    <Image
                      source={{ uri: a.localUri }}
                      style={{
                        width: 72,
                        height: 72,
                        borderRadius: 8,
                        borderWidth: 1,
                        borderColor: colors.border,
                      }}
                    />
                  )}
                  <Pressable
                    onPress={() =>
                      setAttachments((prev) => prev.filter((x) => x.path !== a.path))
                    }
                    accessibilityLabel="Remove attachment"
                    hitSlop={8}
                  >
                    <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 4 }}>
                      Remove
                    </Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          {attachments.length < MAX_ATTACHMENTS && (
            <Pressable
              testID="feedback-add-attachment"
              onPress={() => void addAttachment()}
              disabled={uploading}
              style={{
                marginTop: 10,
                minHeight: 52,
                padding: 14,
                borderRadius: 10,
                borderWidth: 1,
                borderStyle: 'dashed',
                borderColor: colors.border,
                backgroundColor: colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'row',
                gap: 8,
                opacity: uploading ? 0.5 : 1,
              }}
            >
              {uploading && <ActivityIndicator size="small" color={colors.text} />}
              <Text style={{ color: colors.text, fontSize: 14 }}>
                {uploading ? 'Uploading…' : 'Add screenshot or recording'}
              </Text>
            </Pressable>
          )}

          <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 6, lineHeight: 16 }}>
            Recordings up to three minutes. To record: swipe down from the
            top-right, tap the record button, do the thing that breaks, then
            come back here.
          </Text>
        </View>

        {/* Attribution is visible, not silent — a tester should be able to see
            that a report from a shared station will carry their name, and
            notice when it says the wrong person because someone forgot to
            switch. */}
        <View
          style={{
            marginTop: 16,
            padding: 12,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface,
          }}
        >
          <Text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 18 }}>
            Attached automatically:
          </Text>
          <Text
            style={{
              color: colors.text,
              fontSize: 12,
              marginTop: 4,
              fontWeight: '600',
            }}
          >
            v{diagnostics.app_version ?? '?'} ·{' '}
            {diagnostics.update_id && diagnostics.update_id !== 'embedded'
              ? diagnostics.update_id.slice(0, 8)
              : 'embedded'}
            {diagnostics.device_model ? ` · ${diagnostics.device_model}` : ''}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 4 }}>
            {worker
              ? `Filed as ${worker.displayName}`
              : 'Not clocked in — this report won’t say who sent it.'}
          </Text>
        </View>

        <Pressable
          testID="feedback-submit"
          onPress={() => void send()}
          // Also blocked mid-upload: submitting then would file the report
          // without the evidence still in flight, which is the one outcome
          // worse than no attachment at all.
          disabled={busy || tooShort || uploading}
          style={{
            marginTop: 24,
            padding: 18,
            borderRadius: 10,
            backgroundColor: colors.primary,
            opacity: busy || tooShort || uploading ? 0.4 : 1,
            minHeight: 56,
            justifyContent: 'center',
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
            {busy ? 'Sending…' : kind === 'bug' ? 'Send report' : 'Send idea'}
          </Text>
        </Pressable>

        <MyReports reports={reports} hasWorker={Boolean(worker)} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** Colour for a status. Only 'fixed' gets the green tick — the point of the
 *  whole section is that a fix is visibly different from an acknowledgement,
 *  so nothing else is allowed to look like one. */
function toneFor(status: FeedbackReport['status']): { fg: string; mark: string } {
  switch (status) {
    case 'fixed':
      return { fg: '#22c55e', mark: '✓' };
    case 'wont_fix':
      return { fg: colors.textMuted, mark: '—' };
    case 'planned':
    case 'triaged':
      return { fg: colors.primary, mark: '•' };
    default:
      return { fg: colors.textMuted, mark: '•' };
  }
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The reporter's own reports, newest first.
 *
 * Deliberately below the form rather than on a separate screen: the moment
 * someone is about to file a report is exactly when it is worth showing them
 * that the last one went somewhere. It is also the only moment we can be sure
 * they will look.
 */
function MyReports({
  reports,
  hasWorker,
}: {
  reports: FeedbackReport[] | null;
  hasWorker: boolean;
}) {
  // Not clocked in: we cannot tell whose reports these would be, and guessing
  // from the shared station account would show one person another's list.
  if (!hasWorker) return null;
  // Still loading, or genuinely none yet. Either way an empty heading is worse
  // than no heading.
  if (!reports || reports.length === 0) return null;

  return (
    <View style={{ marginTop: 36 }} testID="feedback-my-reports">
      <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
        Your reports
      </Text>

      {reports.map((r) => {
        const tone = toneFor(r.status);
        return (
          <View
            key={r.id}
            testID={`feedback-report-${r.status}`}
            style={{
              marginTop: 10,
              padding: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ color: tone.fg, fontSize: 14, fontWeight: '700' }}>
                {tone.mark}
              </Text>
              <Text style={{ color: tone.fg, fontSize: 12, ...type.label }}>
                {FEEDBACK_STATUS_LABEL[r.status]}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 12, marginLeft: 'auto' }}>
                {shortDate(r.created_at)}
              </Text>
            </View>

            <Text
              style={{ color: colors.text, fontSize: 13, marginTop: 6, lineHeight: 18 }}
              numberOfLines={3}
            >
              {r.message}
            </Text>

            {/* The note is the part that makes this worth reading. "Fixed" on
                its own invites "fixed how?" from someone who then has to go
                find out whether their workaround is still needed. */}
            {r.triage_note ? (
              <Text
                style={{
                  color: colors.textMuted,
                  fontSize: 12,
                  marginTop: 8,
                  lineHeight: 17,
                  fontStyle: 'italic',
                }}
              >
                {`${REPLY_LABEL} ${r.triage_note}`}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
