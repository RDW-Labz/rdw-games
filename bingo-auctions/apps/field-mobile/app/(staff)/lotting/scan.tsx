// LotTR — Scan screen: Photo / Type / Keyword tabs.
//
// Three sub-modes (UPC removed in W2-rest — use Quick Lot for barcode scanning):
//
//   PHOTO   Camera → router.push('/lotting/photo') — no duplicate flow.
//           (W2-rest: consolidated; scan.tsx no longer owns its own photo
//            capture pipeline.)
//
//   TYPE    Brand + model + title inputs → searchKeyword → top hit →
//           editable card.
//
//   KEYWORD Brand + model keyword search. Visually de-emphasized as the
//           last-resort fallback — same logic as TYPE but with a different
//           label and hint copy to make it clear it's for edge cases.
//           (Ported from the deleted lotting/keyword.tsx.)
//
// All modes funnel to the same EditableCandidateCard + useLotCreation path.
// The session's defaultCondition pre-fills the condition field; the lotter
// can change per-lot without affecting the session.
//
// Scan → review → Save is the full path. No intermediate modal stack.

import { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
  ScrollView,
  SafeAreaView,
  Platform,
  KeyboardAvoidingView,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  searchKeyword,
  type LotCandidate,
} from '@/lib/lottr-client';
import { colors, type as typeTokens } from '@auction-platform/design-system';
import {
  EditableCandidateCard,
  candidateToEditable,
  editableToCandidate,
  type EditableCandidate,
} from '@/features/lotting/EditableCandidateCard';
import { useLotCreation } from '@/features/lotting/useLotCreation';
import { uploadPendingPhotos, isLocalPhotoUri } from '@/features/lotting/uploadPendingPhotos';
import { relocatePendingLotPhotos } from '@/features/lotting/relocatePendingLotPhotos';
import { useLottingSession, activeLotSource } from '@/features/lotting/SessionContext';
import { useLottingMode } from '@/features/lotting/LottingModeContext';
import { LottingModeToggle } from '@/features/lotting/LottingModeToggle';
import { PreStickeredScanner } from '@/features/lotting/PreStickeredScanner';
import { supabase, useOperatorRole, hasOperatorRole } from '@auction-platform/supabase-client';


// W2-rest: 'upc' tab removed. Use Quick Lot for barcode scanning.
type Tab = 'photo' | 'type' | 'keyword';

// ── Main screen ───────────────────────────────────────────────────────────────

export default function ScanScreen() {
  const router = useRouter();
  // C2: role drives the manager-only sticker-skip gate on PreStickeredScanner.
  const role = useOperatorRole();
  const { session } = useLottingSession();
  const { create, creating } = useLotCreation();
  const { mode: lottingMode } = useLottingMode();
  // Pre-stickered / LPN Flow B: after handleSave succeeds the scanner modal
  // opens to capture the sticker UUID/code.
  const [pendingSticker, setPendingSticker] = useState<{ lotId: string; lotCode: string } | null>(null);

  const [tab, setTab] = useState<Tab>('photo');

  // Shared candidate state — photo tab delegates to /lotting/photo; only
  // type/keyword paths produce a capturedUri (none in current impl).
  const [editable, setEditable] = useState<EditableCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<string | null>(null);

  // Mirrors quick.tsx: when set, the success toast renders amber instead
  // of green and surfaces the photo failure reason so the user knows to
  // retry from Inventory. null = no photo issue (or photo not attempted).
  const [justCreatedPhotoIssue, setJustCreatedPhotoIssue] = useState<string | null>(null);

  // Type / Keyword modes share the same text input
  const [typeQuery, setTypeQuery] = useState('');

  const sessionDefaults = {
    defaultCondition: session.defaultCondition,
    defaultStartBid: session.defaultStartBid,
  };

  const resetCandidate = useCallback(() => {
    setEditable(null);
    setStatusMsg('');
    setError(null);
  }, []);

  const switchTab = useCallback(
    (t: Tab) => {
      resetCandidate();
      setTypeQuery('');
      setTab(t);
    },
    [resetCandidate],
  );

  function applyCandidate(c: LotCandidate) {
    setEditable(candidateToEditable(c, sessionDefaults));
    setStatusMsg('');
  }

  // ── Type / Keyword mode ────────────────────────────────────────────────────

  async function runSearch() {
    if (!typeQuery.trim() || busy) return;
    setBusy(true);
    setError(null);
    setStatusMsg(`Searching "${typeQuery.trim().slice(0, 40)}"…`);
    try {
      const hits = await searchKeyword(typeQuery.trim());
      if (!hits.length) {
        setError('No results found. You can still create a lot manually.');
        setStatusMsg('');
        return;
      }
      const p = hits[0]!.product;
      const synth: LotCandidate = {
        title: p.title ?? typeQuery.trim(),
        fullTitle: p.title ?? typeQuery.trim(),
        brand: p.brand ?? '',
        model: p.model ?? '',
        upc: p.upc ?? '',
        category: 'Other',
        subcategory: '',
        packagingMsrp: null,
        condition: '',
        description: p.description ?? p.specs ?? '',
        searchQuery: typeQuery.trim(),
        confidence: p.confidence === 'none' ? 'low' : p.confidence,
        notes: '',
        prices: [],
        stockPhotos: p.image_urls ?? [],
        msrp: p.msrp_cents != null ? p.msrp_cents / 100 : null,
        avg: p.avg_asking_cents != null ? p.avg_asking_cents / 100 : null,
        startBid: p.start_bid_cents != null ? p.start_bid_cents / 100 : null,
        specs: p.specs ?? '',
      };
      applyCandidate(synth);
    } catch (err) {
      setError((err as Error).message);
      setStatusMsg('');
    } finally {
      setBusy(false);
    }
  }

  // ── Lot creation ───────────────────────────────────────────────────────────

  async function handleSave() {
    if (!editable || creating) return;
    if (!editable.title.trim()) {
      Alert.alert('Title required', 'Enter a title before saving.');
      return;
    }
    try {
      // D4: the review card's "+ Add photo" tile can put local file:// URIs
      // into stockPhotos. createDraftLotFromCandidate runs them through
      // filterSafeImageUrls (https-only) and would SILENTLY DROP them, losing
      // the photo. Upload any locals to lot-photos FIRST and swap them for
      // their public URLs; already-remote https URLs pass through unchanged.
      let candidate = editableToCandidate(editable);
      const hadLocalPhotos = candidate.stockPhotos.some((u) => isLocalPhotoUri(u));
      let photoDropWarning: string | null = null;
      if (role.kind === 'staff' && hadLocalPhotos) {
        const { urls, failedCount } = await uploadPendingPhotos(role.operatorId, candidate.stockPhotos);
        candidate = { ...candidate, stockPhotos: urls };
        // Surface silently-dropped photos instead of a clean success.
        if (failedCount > 0) {
          photoDropWarning = `${failedCount} photo${failedCount === 1 ? '' : 's'} couldn't be uploaded and ${failedCount === 1 ? 'was' : 'were'} left off. The lot still saved.`;
        }
      }
      const result = await create({
        candidate,
        // No capturedPhotoUri on this path — photo capture is handled by /lotting/photo.
        // Type/keyword candidates have stock photos from the catalog response.
      });
      if (!result) return;
      // Best-effort: lift the just-uploaded "_pending" photos into the lot's
      // own {lotCode}/ folder now that the code exists. Fire-and-forget + COPY
      // (not move) so a failure can never break the working photo_urls.
      if (hadLocalPhotos && role.kind === 'staff') {
        void relocatePendingLotPhotos(
          supabase,
          result.lotId,
          role.operatorId,
          result.lotCode,
          candidate.stockPhotos,
        );
      }
      setJustCreated(result.lotCode);
      // Prefer the pending-photo drop warning (RLS/upload failure on the stock
      // photos) over the capture-photo status; either one means photos were
      // silently left off and the operator must know.
      setJustCreatedPhotoIssue(
        photoDropWarning ??
          (result.photoStatus === 'failed' ? (result.photoErrorReason ?? 'unknown') : null),
      );
      resetCandidate();
      // Flow B: open the sticker scanner for any non-"generate" mode.
      // PreStickeredScanner routes by the scanned value (UUID →
      // claim_prestickered_qr; any other code → claim_sticker_code).
      if (lottingMode !== 'generate') {
        setPendingSticker({ lotId: result.lotId, lotCode: result.lotCode });
      }
      // Lengthen the toast when there's a photo issue so the user can
      // read the warning before it disappears.
      setTimeout(
        () => {
          setJustCreated(null);
          setJustCreatedPhotoIssue(null);
        },
        result.photoStatus === 'failed' ? 5500 : 3000,
      );
    } catch (err) {
      Alert.alert("Couldn't create lot", (err as Error).message);
    }
  }

  // Tab labels — Keyword is visually de-emphasized as the last-resort mode.
  // W2-rest: UPC tab removed; Photo tab now delegates to /lotting/photo.
  const TAB_CONFIG: { id: Tab; label: string; dimmed?: boolean }[] = [
    { id: 'photo', label: '📷 Photo' },
    { id: 'type', label: '⌨ Type' },
    { id: 'keyword', label: '🔍 Keyword', dimmed: true },
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header */}
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.primary, fontSize: 16, fontWeight: '900' }}>
            Scan
          </Text>
          {/* Active-source badge: matches the Quick Lot header so the
              operator always knows what they're tagging. Tap → back to
              hub to swap trucks. */}
          {activeLotSource(session) ? (
            <Pressable onPress={() => router.back()} hitSlop={6} style={{ marginTop: 2 }}>
              <Text style={{ color: colors.primary, fontSize: 11, fontWeight: '800' }} numberOfLines={1}>
                📦 {activeLotSource(session)}
              </Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable onPress={() => router.back()} style={s.closeBtn} hitSlop={12}>
          <Text style={{ color: colors.textMuted, fontSize: 15, fontWeight: '700' }}>
            Done
          </Text>
        </Pressable>
      </View>

      <LottingModeToggle disabled={busy || creating} />

      {/* Tab bar */}
      <View style={s.tabBar}>
        {TAB_CONFIG.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => switchTab(t.id)}
            style={[
              s.tabBtn,
              tab === t.id && s.tabBtnActive,
              t.dimmed && tab !== t.id && s.tabBtnDimmed,
            ]}
          >
            <Text
              style={[
                s.tabText,
                tab === t.id && s.tabTextActive,
                t.dimmed && tab !== t.id && s.tabTextDimmed,
              ]}
            >
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 64 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* ── PHOTO TAB ── */}
          {/* W2-rest: photo tab delegates to /lotting/photo (the dedicated
              AI Photo Scan screen) instead of running its own camera flow.
              This eliminates the duplicate photo-capture pipeline that
              previously lived in scan.tsx. */}
          {tab === 'photo' && !editable && (
            <>
              <View
                style={{
                  padding: 20,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '800', textAlign: 'center' }}>
                  📷 AI Photo Scan
                </Text>
                <Text style={{ color: colors.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 19 }}>
                  Snap a photo and AI identifies the item instantly. Tap below to open the photo scanner.
                </Text>
                <Pressable
                  onPress={() => router.push('/lotting/photo')}
                  style={s.primaryBtn}
                >
                  <Text style={s.primaryBtnText}>Open Photo Scan</Text>
                </Pressable>
              </View>
            </>
          )}

          {/* ── TYPE TAB ── */}
          {tab === 'type' && !editable && (
            <>
              <Text style={{ color: colors.textMuted, fontSize: 13 }}>
                Type the brand + model or product name to find prices.
              </Text>
              <TextInput
                placeholder="DeWalt DCD771C2 20V Drill"
                placeholderTextColor={colors.textMuted}
                value={typeQuery}
                onChangeText={setTypeQuery}
                autoCorrect={false}
                style={s.textInput}
                returnKeyType="search"
                onSubmitEditing={runSearch}
                autoFocus
              />
              <Pressable
                onPress={runSearch}
                disabled={busy || !typeQuery.trim()}
                style={[
                  s.primaryBtn,
                  (!typeQuery.trim() || busy) && { backgroundColor: colors.surfaceHi },
                ]}
              >
                {busy ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={[s.primaryBtnText, !typeQuery.trim() && { color: colors.textMuted }]}>
                    Search + price
                  </Text>
                )}
              </Pressable>
            </>
          )}

          {/* ── KEYWORD TAB — de-emphasized, last-resort fallback ── */}
          {tab === 'keyword' && !editable && (
            <>
              <View style={s.keywordHintBox}>
                <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 19 }}>
                  Last-resort search — use when photo scan and UPC both fail.
                  Type the brand + model number for best results
                  (e.g. "DeWalt DCD771C2").
                </Text>
              </View>
              <TextInput
                placeholder="Brand + model, or product name"
                placeholderTextColor={colors.textMuted}
                value={typeQuery}
                onChangeText={setTypeQuery}
                autoCorrect={false}
                style={s.textInput}
                returnKeyType="search"
                onSubmitEditing={runSearch}
                autoFocus
              />
              <Pressable
                onPress={runSearch}
                disabled={busy || !typeQuery.trim()}
                style={[
                  s.keywordSearchBtn,
                  (!typeQuery.trim() || busy) && { opacity: 0.5 },
                ]}
              >
                {busy ? (
                  <ActivityIndicator color={colors.primary} />
                ) : (
                  <Text style={s.keywordSearchBtnText}>Search</Text>
                )}
              </Pressable>
            </>
          )}

          {/* ── Shared: busy indicator ── */}
          {busy && statusMsg ? (
            <View style={s.statusRow}>
              <ActivityIndicator color={colors.primary} size="small" />
              <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '700' }}>
                {statusMsg}
              </Text>
            </View>
          ) : null}

          {/* ── Shared: error ── */}
          {error && (
            <View style={s.errorBox}>
              <Text style={{ color: colors.danger, fontWeight: '700' }}>{error}</Text>
              <Pressable onPress={resetCandidate} hitSlop={8}>
                <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 6 }}>
                  Tap to dismiss
                </Text>
              </Pressable>
            </View>
          )}

          {/* ── Shared: just-created toast ── */}
          {/* Two variants: clean success (green) vs success-with-photo-issue
              (amber) so the user knows the lot saved but the photo didn't. */}
          {justCreated && (
            <View
              style={[
                s.successToast,
                justCreatedPhotoIssue
                  ? {
                      backgroundColor: 'rgba(245,158,11,0.12)',
                      borderColor: 'rgba(245,158,11,0.45)',
                    }
                  : null,
              ]}
            >
              <Text
                style={{
                  color: justCreatedPhotoIssue ? '#f59e0b' : '#22c55e',
                  fontWeight: '800',
                  fontSize: 14,
                }}
              >
                Lot created — {justCreated}
                {justCreatedPhotoIssue ? '  ⚠' : ''}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>
                {justCreatedPhotoIssue
                  ? `Photo upload failed: ${justCreatedPhotoIssue}. Open Inventory to retry.`
                  : lottingMode === 'generate'
                    ? `${justCreated} — saved with auto-generated QR. Print the label from Inventory → ${justCreated} when ready.`
                    : 'Ready for intake scan. Scan next item.'}
              </Text>
            </View>
          )}

          {/* ── Shared: editable candidate card + save ── */}
          {editable && (
            <>
              <EditableCandidateCard
                value={editable}
                onChange={(patch) => setEditable((prev) => prev ? { ...prev, ...patch } : prev)}
                onClearPhoto={(i) => {
                  if (!editable) return;
                  const updated = editable.stockPhotos.filter((_, idx) => idx !== i);
                  setEditable({ ...editable, stockPhotos: updated });
                }}
              />

              <Pressable
                onPress={handleSave}
                disabled={creating || !editable.title.trim()}
                style={[
                  s.createBtn,
                  (creating || !editable.title.trim()) && { opacity: 0.5 },
                ]}
              >
                {creating ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text style={s.createBtnText}>Save lot</Text>
                )}
              </Pressable>

              <Pressable onPress={resetCandidate} style={s.ghostBtn}>
                <Text style={s.ghostBtnText}>Discard — scan again</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {pendingSticker && (
        <PreStickeredScanner
          lotId={pendingSticker.lotId}
          lotCode={pendingSticker.lotCode}
          // C2: manager-only sticker skip. `role` from useOperatorRole();
          // narrow to 'staff' before reading role.role.
          canSkip={role.kind === 'staff' && hasOperatorRole(role.role, 'manager')}
          onAssigned={() => setPendingSticker(null)}
          onCancel={() => setPendingSticker(null)}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  closeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabBar: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  tabBtnActive: {
    borderColor: `${colors.primary}55`,
    backgroundColor: colors.primaryDim,
  },
  // Keyword tab: slightly faded when inactive to signal it's a last resort
  tabBtnDimmed: {
    borderColor: 'transparent',
    backgroundColor: 'transparent',
    opacity: 0.65,
  },
  tabText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  tabTextActive: {
    color: colors.primary,
  },
  tabTextDimmed: {
    color: colors.textDim,
    fontSize: 11,
  },
  primaryBtn: {
    padding: 18,
    backgroundColor: colors.primary,
    borderRadius: 14,
    alignItems: 'center',
    minHeight: 60,
    justifyContent: 'center',
  },
  primaryBtnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '900',
  },
  createBtn: {
    padding: 20,
    backgroundColor: '#22c55e',
    borderRadius: 14,
    alignItems: 'center',
    minHeight: 64,
    justifyContent: 'center',
  },
  createBtnText: {
    color: '#000',
    fontSize: 17,
    fontWeight: '900',
  },
  ghostBtn: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  ghostBtnText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '700',
  },
  textInput: {
    padding: 14,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    fontSize: 15,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: colors.primaryDim,
    borderWidth: 1,
    borderColor: `${colors.primary}33`,
  },
  errorBox: {
    padding: 14,
    borderRadius: 10,
    backgroundColor: colors.dangerDim,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  successToast: {
    padding: 14,
    borderRadius: 10,
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.4)',
  },
  keywordHintBox: {
    padding: 12,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
  },
  keywordSearchBtn: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: `${colors.primary}55`,
    backgroundColor: colors.primaryDim,
    alignItems: 'center',
  },
  keywordSearchBtnText: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: '800',
  },
});
