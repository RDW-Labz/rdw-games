// Batch Put-Away — scan a cart's worth of lots, then scan ONE bin QR to
// commit them all at once.
//
// Interaction model:
//   Phase 1 (lot scanning): camera is open continuously. Each barcode
//   resolved to a lot appends to the pending list with haptic + audio
//   feedback. Duplicates are rejected with a brief toast.
//
//   Phase 2 (bin scan): triggered by pressing "Scan Bin & Commit". The
//   camera switches to await a single bin QR. On scan → calls
//   batch_intake_lot_to_bin RPC → renders result screen.
//
//   Phase 3 (results): successes shown as a collapsed count; failures
//   expanded per-row with the error reason. "Retry failures" pre-loads
//   only the failed identifiers back into Phase 1.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Camera,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';
import { useCameraGate } from '@/features/camera/useCameraGate';
import { useBackCamera } from '@/features/camera/useBackCamera';
import {
  ALL_RETAIL_CODE_TYPES,
  firstCodeValue,
  type DecodedCode,
} from '@/lib/vision-camera';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { resolveLotScan, type ScanRow } from '@/lib/resolve-lot-scan';
import { supabase } from '@auction-platform/supabase-client';
import { lotDisplayCode } from '@auction-platform/shared';
import { colors, type } from '@auction-platform/design-system';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One lot the picker has scanned and we've resolved client-side. */
type PendingLot = {
  /** Raw scan string (lot_code, UUID, LPN, etc.) — sent verbatim to the RPC. */
  identifier: string;
  /** Display code shown in the list. Falls back to identifier if lookup failed. */
  displayCode: string;
  /** Lot title from the local lookup, null if we couldn't resolve it locally. */
  title: string | null;
  /** First photo URL from the lot, for the thumbnail. */
  thumbnailUrl: string | null;
};

/** One row from batch_intake_lot_to_bin result. */
type BatchResultRow = {
  identifier: string;
  ok: boolean;
  code: string | null;
  lot_id: string | null;
  lot_code: string | null;
  // mig 0185: pre-stickered label (operator-prefixed) so the UI can show
  // the BRN via lotDisplayCode, matching the rest of the app.
  sticker_code?: string | null;
  bin_code: string | null;
  // W10 (mig 0143): source bin on pending_move + ok_already_here.
  // NULL on ok_intaked and any error row.
  from_bin_code: string | null;
  error: string | null;
};

type Phase = 'scan_lots' | 'scan_bin' | 'submitting' | 'results';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 2026-05-25: widened to match both formats (mirrors intake.tsx).
//   * BinGo Auctions native:  BIN-000047 (dashed)
//   * Legacy import:    BRN4366058, TEA4951695, PNK4858781 (no dash)
const LOT_CODE_RE = /^[A-Z]{2,4}-?\d{4,10}$/;

const ERROR_LABELS: Record<string, string> = {
  lot_not_found: 'Not found',
  // W4 (mig 0142): server returns this when the scanned identifier doesn't
  // match an existing lot's qr_token / lot_code / sticker_code. The operator
  // should open Lotting and create a draft before re-scanning for put-away.
  not_lotted_yet: 'Not lotted yet',
  lot_other_operator: 'Wrong operator',
  lot_not_in_intake_state: 'Wrong status',
  update_failed: 'DB error',
  // W10 (mig 0143): success/no-op/move outcomes. Pre-W10 these would have
  // shown as just 'ok'; clients can now branch on the exact code.
  ok_intaked: 'Intaked',
  ok_already_here: 'Already here',
  pending_move: 'Confirm move',  // tap row → confirm_move_lot_to_bin (W10-UI Phase D)
};

// Toast duration in ms.
const TOAST_DURATION = 1800;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractIdentifier(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (LOT_CODE_RE.test(trimmed.toUpperCase())) return trimmed.toUpperCase();
  if (UUID_RE.test(trimmed)) return trimmed;
  const codeMatch = trimmed.match(/[A-Z0-9]{2,8}-\d{4,8}/);
  if (codeMatch) return codeMatch[0];
  const uuidMatch = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuidMatch) return uuidMatch[0];
  // Arbitrary identifier (LPN, FNSKU, ASIN, external_code, UPC). Cap at 120
  // chars — the same limit applied in intake.tsx.
  if (trimmed.length > 120) return null;
  return trimmed;
}

function extractBinToken(raw: string): string | null {
  const trimmed = raw.trim();
  const m = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function BatchPutAwayScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  // Battery (recap 2026-07-08): stop the camera when this screen is
  // behind another route or the app is backgrounded.
  const cameraGate = useCameraGate();
  const [phase, setPhase] = useState<Phase>('scan_lots');

  const device = useBackCamera();
  const cameraRef = useRef<Camera | null>(null);
  const focus = useTapToFocus(cameraRef);
  // PUT-1 fix: ONE persistent code scanner, routed by `phase` in the
  // callback — matching single.tsx / checkout/stage.tsx. vision-camera v4
  // does NOT reliably re-bind the native scanner when you swap to a
  // different scanner object on a running session, so the previous
  // two-scanner-swap approach left the lot-phase scanner running into the
  // bin phase; its onLotScan was phase-gated → the bin QR was silently
  // dropped. A single scanner with the superset codeTypes (ALL_RETAIL_*
  // includes 'qr' for bins) avoids the swap entirely. onBinScan /
  // extractBinToken still validate the payload is a bin UUID, so widening
  // codeTypes can't accept a non-bin in the bin phase.
  const codeScanner = useCodeScanner({
    codeTypes: ALL_RETAIL_CODE_TYPES,
    onCodeScanned: (codes) => {
      const c = firstCodeValue(codes);
      if (!c) return;
      if (phase === 'scan_lots') void onLotScan(c);
      else if (phase === 'scan_bin') void onBinScan(c);
    },
  });
  const [pending, setPending] = useState<PendingLot[]>([]);
  const [results, setResults] = useState<BatchResultRow[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  // C1: persistent bin-level error banner. The scanned bin QR was not
  // accepted (unknown / revoked / wrong operator → the RPC returns 0 rows),
  // so NOTHING was put away. A transient Alert vanished before staff could
  // read it; this banner stays on the scan screen until they rescan or
  // dismiss it. Mirrors shelf-scan.tsx's commitError pattern.
  const [commitError, setCommitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();

  // Optional preload from a sibling flow (e.g. Shelf Scan handing the
  // freshly created lot_codes here so the operator can scan one bin and
  // commit the whole batch). The param is a comma-separated list of
  // identifiers (lot_code, UUID, or external_code).
  const { preload } = useLocalSearchParams<{ preload?: string }>();
  const preloadAppliedRef = useRef(false);

  // Track identifiers already in the list for fast duplicate detection.
  const pendingIds = useRef<Set<string>>(new Set());

  // Gate: prevent the camera firing twice before state settles.
  const processingRef = useRef(false);

  // ── Toast helper ──────────────────────────────────────────────────────────
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_DURATION);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // ── Preload from `?preload=CODE1,CODE2,…` ─────────────────────────────────
  // Used by the Shelf-Scan → Batch-Put-Away bridge: shelf-scan creates N
  // pending_intake lots, then hands their lot_codes here so the operator
  // can scan a single bin QR and commit them all. Resolves each id to a
  // display row in parallel; falls back to identifier-only when a lookup
  // fails so the operator still sees the row (and the RPC still tries).
  useEffect(() => {
    if (preloadAppliedRef.current) return;
    if (!preload) return;
    preloadAppliedRef.current = true;

    const ids = preload
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return;

    let cancelled = false;
    (async () => {
      // Resolve display info concurrently. This was gated on LOT_CODE_RE and
      // probed `lot_code` only, so a legacy sticker label (PNK…) resolved to
      // the retired parent of a relisted item — showing the operator the old
      // title/photo for the box in their hands — and a code that only lives in
      // `sticker_code` showed no detail at all. `resolveLotScan` matches every
      // identifier column and prefers the live incarnation.
      const resolved = await Promise.all(
        ids.map(async (id) => {
          const r = await resolveLotScan<ScanRow & { title: string; photo_urls: string[] }>(
            id,
            'title, photo_urls',
          );
          if (r) {
            const d = r.lot;
            return {
              identifier: id,
              displayCode: lotDisplayCode(d) ?? d.lot_code ?? id,
              title: d.title ?? null,
              thumbnailUrl: d.photo_urls?.[0] ?? null,
            } satisfies PendingLot;
          }
          // Fallback: keep the identifier so the operator can still see/commit it.
          return {
            identifier: id,
            displayCode: id,
            title: null,
            thumbnailUrl: null,
          } satisfies PendingLot;
        }),
      );

      if (cancelled) return;

      // Newest-first to match onLotScan's prepend behaviour.
      const newRows = resolved.slice().reverse();
      newRows.forEach((p) => pendingIds.current.add(p.identifier.toLowerCase()));
      setPending(newRows);
      // Don't auto-advance to scan_bin — operator may want to add more
      // lots from the cart before committing. The "Scan Bin & Commit"
      // button is enabled as soon as pending.length > 0.
    })();

    return () => {
      cancelled = true;
    };
  }, [preload]);

  // ── Lot scan handler (Phase 1) ────────────────────────────────────────────
  const onLotScan = useCallback(
    async (scan: DecodedCode) => {
      if (busy || phase !== 'scan_lots' || processingRef.current) return;
      const id = extractIdentifier(scan.data);
      if (!id) return;

      // Duplicate check.
      if (pendingIds.current.has(id.toLowerCase())) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        showToast('Already scanned');
        return;
      }

      processingRef.current = true;

      // Optimistic add — show something in the list immediately.
      const optimistic: PendingLot = {
        identifier: id,
        displayCode: id,
        title: null,
        thumbnailUrl: null,
      };
      pendingIds.current.add(id.toLowerCase());
      setPending((prev) => [optimistic, ...prev]);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Background lookup to fill in title + thumbnail. Same fix as the preload
      // path above: one resolver over every identifier column, live incarnation
      // preferred, instead of a LOT_CODE_RE-gated lot_code probe that showed
      // the retired parent's detail for a relisted box.
      type ResolvedRow = ScanRow & { title: string; photo_urls: string[] };
      let resolved: ResolvedRow | null = (await resolveLotScan<ResolvedRow>(
        id,
        'title, photo_urls',
      ))?.lot ?? null;

      if (!resolved) {
        // external_code is not an identity column, so it stays a last resort
        // that can never out-rank a lot_code/sticker match. RLS scopes to
        // operator automatically. 0057: skip trashed lots.
        const r = await supabase
          .from('lots')
          .select('id, lot_code, sticker_code, display_code, status, created_at, title, photo_urls')
          .eq('external_code', id)
          .is('deleted_at', null)
          .maybeSingle();
        if (r.data) resolved = r.data as unknown as ResolvedRow;
      }

      if (resolved) {
        setPending((prev) =>
          prev.map((p) =>
            p.identifier === id
              ? {
                  ...p,
                  displayCode: lotDisplayCode(resolved!) ?? resolved!.lot_code ?? id,
                  title: resolved!.title ?? null,
                  thumbnailUrl: resolved!.photo_urls?.[0] ?? null,
                }
              : p,
          ),
        );
      }

      processingRef.current = false;
    },
    [busy, phase, showToast],
  );

  // ── Bin scan handler (Phase 2) ────────────────────────────────────────────
  const onBinScan = useCallback(
    async (scan: DecodedCode) => {
      if (busy || phase !== 'scan_bin' || processingRef.current) return;
      const token = extractBinToken(scan.data);
      if (!token) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        showToast('Not a bin QR — try again');
        return;
      }
      processingRef.current = true;
      setBusy(true);
      setCommitError(null);
      setPhase('submitting');

      try {
        const identifiers = pending.map((p) => p.identifier);
        const { data, error } = await supabase.rpc('batch_intake_lot_to_bin', {
          p_lot_identifiers: identifiers,
          p_bin_qr_token: token,
        });

        if (error) throw error;

        // RPC returns 0 rows when the bin itself is invalid (unknown /
        // revoked / wrong operator). C1: surface this as a persistent
        // banner on the scan screen instead of a vanishing Alert, so the
        // crew knows the bin was rejected and NOTHING was put away.
        const rows = (data ?? []) as BatchResultRow[];
        if (rows.length === 0) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          setCommitError(
            'Bin QR not accepted — unknown, revoked, or a different operator. Nothing was put away. Scan a valid bin label to commit.',
          );
          setPhase('scan_bin');
          setBusy(false);
          processingRef.current = false;
          return;
        }

        setResults(rows);
        setPhase('results');
        setBusy(false);
        processingRef.current = false;
      } catch (err) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setCommitError(`Batch put-away failed: ${(err as Error).message}`);
        setPhase('scan_bin');
        setBusy(false);
        processingRef.current = false;
      }
    },
    [busy, phase, pending, showToast],
  );

  // ── Remove a lot from the pending list ────────────────────────────────────
  const removeLot = useCallback((identifier: string) => {
    pendingIds.current.delete(identifier.toLowerCase());
    setPending((prev) => prev.filter((p) => p.identifier !== identifier));
  }, []);

  // ── Reset everything ──────────────────────────────────────────────────────
  const reset = useCallback(() => {
    pendingIds.current.clear();
    setPending([]);
    setResults([]);
    setCommitError(null);
    setPhase('scan_lots');
    processingRef.current = false;
  }, []);

  // ── Retry: reload only failed identifiers ────────────────────────────────
  const retryFailures = useCallback(() => {
    const failed = results.filter((r) => !r.ok);
    const retryLots: PendingLot[] = failed.map((r) => ({
      identifier: r.identifier,
      displayCode: lotDisplayCode({ lot_code: r.lot_code, sticker_code: r.sticker_code }) ?? r.lot_code ?? r.identifier,
      title: null,
      thumbnailUrl: null,
    }));
    pendingIds.current.clear();
    retryLots.forEach((l) => pendingIds.current.add(l.identifier.toLowerCase()));
    setPending(retryLots);
    setResults([]);
    setCommitError(null);
    setPhase('scan_lots');
    processingRef.current = false;
  }, [results]);

  // ── Permission gate ───────────────────────────────────────────────────────
  if (!hasPermission) {
    return (
      <View style={{ flex: 1, padding: 24, backgroundColor: colors.bg }}>
        <Text style={{ color: colors.text, fontSize: 16, marginBottom: 12 }}>
          Camera access is required to scan barcodes.
        </Text>
        <Pressable
          onPress={requestPermission}
          style={{ padding: 14, backgroundColor: colors.primary, borderRadius: 8 }}
        >
          <Text style={{ color: '#000', textAlign: 'center', ...type.label }}>
            Allow camera
          </Text>
        </Pressable>
      </View>
    );
  }

  // ── Results phase ─────────────────────────────────────────────────────────
  if (phase === 'results') {
    const successes = results.filter((r) => r.ok);
    const failures = results.filter((r) => !r.ok);
    const binCode = successes[0]?.bin_code ?? '—';

    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {/* Header */}
        <View
          style={{
            padding: 16,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
            Batch put-away · results
          </Text>
          <Text
            style={{ color: colors.text, fontSize: 22, fontWeight: '700', marginTop: 4 }}
          >
            {successes.length} of {results.length} placed in bin{' '}
            <Text style={{ color: colors.primary, fontFamily: 'monospace' }}>{binCode}</Text>
          </Text>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 120 }}>
          {/* Success summary */}
          {successes.length > 0 && (
            <View
              style={{
                padding: 14,
                backgroundColor: colors.successDim,
                borderColor: colors.success,
                borderWidth: 1,
                borderRadius: 10,
                marginBottom: 16,
              }}
            >
              <Text style={{ color: colors.success, ...type.label, fontSize: 11 }}>
                {successes.length} lot{successes.length !== 1 ? 's' : ''} moved to inventory
              </Text>
              <Text style={{ color: colors.text, fontSize: 13, marginTop: 4 }}>
                {successes
                  .map(
                    (r) =>
                      lotDisplayCode({ lot_code: r.lot_code, sticker_code: r.sticker_code }) ??
                      r.lot_code ??
                      r.identifier,
                  )
                  .join('  ·  ')}
              </Text>
            </View>
          )}

          {/* Failure list */}
          {failures.length > 0 && (
            <>
              <Text
                style={{
                  color: colors.danger,
                  ...type.label,
                  fontSize: 11,
                  marginBottom: 8,
                }}
              >
                {failures.length} failed — scan these again
              </Text>
              {failures.map((r) => (
                <View
                  key={r.identifier}
                  style={{
                    padding: 14,
                    backgroundColor: colors.surface,
                    borderColor: colors.danger,
                    borderWidth: 1,
                    borderRadius: 10,
                    marginBottom: 8,
                  }}
                >
                  <Text
                    style={{
                      color: colors.primary,
                      fontFamily: 'monospace',
                      fontSize: 13,
                      fontWeight: '900',
                    }}
                  >
                    {lotDisplayCode({ lot_code: r.lot_code, sticker_code: r.sticker_code }) ??
                      r.lot_code ??
                      r.identifier}
                  </Text>
                  <Text style={{ color: colors.danger, fontSize: 12, marginTop: 4 }}>
                    {ERROR_LABELS[r.code ?? ''] ?? r.code ?? 'Unknown error'}
                  </Text>
                  {r.error ? (
                    <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>
                      {r.error}
                    </Text>
                  ) : null}
                </View>
              ))}
            </>
          )}
        </ScrollView>

        {/* Action buttons */}
        <View
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: 16,
            gap: 10,
            backgroundColor: colors.bg,
            borderTopWidth: 1,
            borderTopColor: colors.border,
          }}
        >
          {failures.length > 0 && (
            <Pressable
              onPress={retryFailures}
              style={{
                padding: 14,
                backgroundColor: colors.primary,
                borderRadius: 10,
              }}
            >
              <Text
                style={{ color: '#000', textAlign: 'center', fontSize: 15, ...type.label }}
              >
                Retry {failures.length} failure{failures.length !== 1 ? 's' : ''}
              </Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => router.back()}
            style={{
              padding: 14,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: 10,
            }}
          >
            <Text style={{ color: colors.text, textAlign: 'center', fontSize: 14 }}>
              Done
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Submitting overlay ────────────────────────────────────────────────────
  if (phase === 'submitting') {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
        }}
      >
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={{ color: colors.textMuted, fontSize: 14 }}>
          Placing {pending.length} lot{pending.length !== 1 ? 's' : ''} into bin…
        </Text>
      </View>
    );
  }

  // ── Scan phases (lots + bin) ───────────────────────────────────────────────
  const isBinPhase = phase === 'scan_bin';

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: colors.bg }}
    >
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          padding: 16,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
            {isBinPhase ? 'scan bin QR to commit' : 'batch put-away'}
          </Text>
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 2 }}>
            {isBinPhase
              ? 'Point camera at bin label'
              : `${pending.length} lot${pending.length !== 1 ? 's' : ''} scanned`}
          </Text>
        </View>
        {/* Cancel — always visible, resets to hub */}
        <Pressable
          onPress={() => {
            reset();
            router.back();
          }}
          style={{
            paddingHorizontal: 14,
            paddingVertical: 8,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 8,
          }}
        >
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>Cancel</Text>
        </Pressable>
      </View>

      {/* ── C1: intake-vs-stage clarifier ───────────────────────────────── */}
      {/* Batch put-away flips every committed lot to IN INVENTORY. Staging a
          won lot into a pickup bin (assign-only, status unchanged) is a
          separate Check Out flow — call that out so a stage isn't mistaken
          for a put-away. */}
      <Text
        style={{
          color: colors.textMuted,
          fontSize: 12,
          marginHorizontal: 16,
          marginTop: 8,
          lineHeight: 17,
        }}
      >
        Commits move every lot to{' '}
        <Text style={{ color: colors.success, fontWeight: '800' }}>Inventory</Text>. To stage won
        lots for pickup (no inventory change), use Check Out instead.
      </Text>

      {/* ── C1: persistent bin-level error banner ───────────────────────── */}
      {commitError !== null && (
        <View
          style={{
            marginHorizontal: 16,
            marginTop: 10,
            padding: 12,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: colors.danger,
            backgroundColor: colors.dangerDim,
          }}
        >
          <Text style={{ color: colors.danger, fontSize: 13, lineHeight: 18 }}>{commitError}</Text>
          <Pressable onPress={() => setCommitError(null)} hitSlop={10} style={{ marginTop: 8 }}>
            <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '700' }}>Dismiss</Text>
          </Pressable>
        </View>
      )}

      {/* ── Toast ────────────────────────────────────────────────────────── */}
      {toast !== null && (
        <View
          style={{
            position: 'absolute',
            top: 80,
            left: 40,
            right: 40,
            zIndex: 999,
            backgroundColor: colors.surfaceHi,
            borderRadius: 8,
            padding: 12,
            alignItems: 'center',
            borderWidth: 1,
            borderColor: colors.borderHot,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{toast}</Text>
        </View>
      )}

      {/* ── Camera ───────────────────────────────────────────────────────── */}
      {device && (
        <View style={{ height: isBinPhase ? 300 : 220, margin: 16, borderRadius: 12, overflow: 'hidden' }}>
          <Camera
            ref={cameraRef}
            style={{ flex: 1 }}
            device={device}
            isActive={cameraGate && (!busy)}
            codeScanner={codeScanner}
          />
          <Pressable style={StyleSheet.absoluteFillObject} onPress={focus.onTap} />
          {focus.indicator}
        </View>
      )}

      {/* ── Instruction sub-label ─────────────────────────────────────────── */}
      {!isBinPhase && (
        <Text
          style={{
            color: colors.textMuted,
            fontSize: 12,
            marginHorizontal: 16,
            marginTop: -4,
            marginBottom: 8,
          }}
        >
          Scan lot QR codes one at a time. When the cart is done, tap "Scan Bin & Commit".
        </Text>
      )}
      {isBinPhase && (
        <Text
          style={{
            color: colors.primary,
            fontSize: 12,
            marginHorizontal: 16,
            marginTop: -4,
            marginBottom: 8,
            ...type.label,
          }}
        >
          Waiting for bin QR — scan the bin sticker now
        </Text>
      )}

      {/* ── Pending lot list ─────────────────────────────────────────────── */}
      <FlatList
        data={pending}
        keyExtractor={(item) => item.identifier}
        style={{ flex: 1, marginHorizontal: 16 }}
        contentContainerStyle={{ gap: 6, paddingBottom: 8 }}
        ListEmptyComponent={
          <Text
            style={{
              color: colors.textDim,
              fontSize: 13,
              textAlign: 'center',
              marginTop: 12,
            }}
          >
            No lots scanned yet — point camera at a lot label.
          </Text>
        }
        renderItem={({ item }) => (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              padding: 12,
              backgroundColor: colors.surface,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colors.border,
              gap: 10,
            }}
          >
            {/* Thumbnail placeholder — expo-image would need an import,
                use a simple coloured square since expo-image is in deps */}
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 6,
                backgroundColor: colors.surfaceAlt,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ color: colors.textDim, fontSize: 10 }}>LOT</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={{
                  color: colors.primary,
                  fontFamily: 'monospace',
                  fontSize: 12,
                  fontWeight: '900',
                }}
                numberOfLines={1}
              >
                {item.displayCode}
              </Text>
              {item.title !== null && (
                <Text
                  style={{ color: colors.text, fontSize: 13, marginTop: 2 }}
                  numberOfLines={1}
                >
                  {item.title}
                </Text>
              )}
            </View>
            {/* Remove button — disabled in bin-scan phase so list is read-only */}
            {!isBinPhase && (
              <Pressable
                onPress={() => removeLot(item.identifier)}
                hitSlop={12}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  backgroundColor: colors.surfaceAlt,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ color: colors.textMuted, fontSize: 16, lineHeight: 18 }}>
                  ×
                </Text>
              </Pressable>
            )}
          </View>
        )}
      />

      {/* ── Bottom action bar ─────────────────────────────────────────────── */}
      <View
        style={{
          padding: 16,
          gap: 10,
          borderTopWidth: 1,
          borderTopColor: colors.border,
        }}
      >
        {!isBinPhase ? (
          <>
            <Pressable
              disabled={pending.length === 0 || busy}
              onPress={() => setPhase('scan_bin')}
              style={{
                padding: 16,
                backgroundColor: pending.length === 0 ? colors.surfaceAlt : colors.primary,
                borderRadius: 10,
                opacity: pending.length === 0 || busy ? 0.5 : 1,
              }}
            >
              <Text
                style={{
                  color: pending.length === 0 ? colors.textMuted : '#000',
                  textAlign: 'center',
                  fontSize: 15,
                  ...type.label,
                }}
              >
                Scan Bin & Commit ({pending.length})
              </Text>
            </Pressable>
          </>
        ) : (
          // In bin-scan phase show a "back to lot scanning" escape hatch.
          <Pressable
            onPress={() => setPhase('scan_lots')}
            style={{
              padding: 14,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: 10,
            }}
          >
            <Text style={{ color: colors.textMuted, textAlign: 'center', fontSize: 14 }}>
              Back — keep scanning lots
            </Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
