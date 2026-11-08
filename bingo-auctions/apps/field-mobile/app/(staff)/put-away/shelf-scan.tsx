// Shelf Scan + Put-Away (W3 rewrite) — continuous lot-barcode resolution
// with a single bin-QR commit.
//
// Flow:
//   State A (scanning): camera open continuously. Each scan accepted
//   optimistically as a lot identifier. Dedupe within 30 s. Heuristic
//   detects a UUID scan with ≥1 lot in queue → transitions to State B.
//
//   State B (committing): spinner, calls batch_intake_lot_to_bin RPC.
//
//   State C (results): scrollable per-row outcome list. pending_move rows
//   show an inline Yes/No that calls confirm_move_lot_to_bin.
//
// No AI photo capture. No manifest minting. No cross-screen ?preload= handoff.
// Lives end-to-end in this one file.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
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
} from '@/lib/vision-camera';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { supabase } from '@auction-platform/supabase-client';
import { lotDisplayCode } from '@auction-platform/shared';
import { colors, type } from '@auction-platform/design-system';

// ---------------------------------------------------------------------------
// Debug marker — bump per OTA so staff can verify bundle version.
// ---------------------------------------------------------------------------

export const BUILD_MARKER = 'b11-restructure-shelf-w3';

// ---------------------------------------------------------------------------
// Types — mirrored from batch.tsx (lines 64-90)
// ---------------------------------------------------------------------------

/** One row returned by batch_intake_lot_to_bin (W10 / mig 0143; sticker_code mig 0185). */
type BatchResultRow = {
  identifier: string;
  ok: boolean;
  code: string | null;
  lot_id: string | null;
  lot_code: string | null;
  // mig 0185: pre-stickered label (operator-prefixed) for lotDisplayCode.
  sticker_code?: string | null;
  bin_code: string | null;
  from_bin_code: string | null;
  error: string | null;
};

type VisualState = 'scanning' | 'committing' | 'results';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 2026-05-25: widened — BinGo Auctions native BIN-000047 AND legacy TEA4951695 formats.
const LOT_CODE_RE = /^[A-Z]{2,4}-?\d{4,10}$/;

/** Error/outcome labels mirrored from batch.tsx + W10 additions. */
const ERROR_LABELS: Record<string, string> = {
  lot_not_found: 'Not found',
  not_lotted_yet: 'Not lotted — go to Lotting first',
  lot_other_operator: 'Wrong operator',
  lot_not_in_intake_state: 'Wrong status',
  update_failed: 'DB error',
  ok_intaked: 'Intaked',
  ok_already_here: 'Already here',
  ok_moved: 'Moved',
  pending_move: 'Confirm move?',
  lot_not_found_or_revoked: 'Lot not found',
  bin_not_found_or_revoked: 'Bin not found or revoked',
  bin_retired: 'Bin retired',
  lot_not_won: 'Lot not yet won',
};

/** Dedup window: ignore the same code scanned within this many ms. */
const DEDUP_WINDOW_MS = 30_000;

/** Toast auto-dismiss in ms. */
const TOAST_DURATION_MS = 1800;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Classify a raw scan:
 *   'bin'  — UUID format → treat as bin QR token
 *   'lot'  — everything else → treat as lot identifier
 *
 * Sticker codes (W2-bonus, format "{op}:{raw}") contain ":" so they're
 * not UUIDs and fall through to 'lot'. Any UUID is only interpreted as
 * a bin token when the lot queue is non-empty — see call site.
 */
function classifyScan(raw: string): 'bin' | 'lot' {
  const trimmed = raw.trim();
  if (UUID_RE.test(trimmed)) return 'bin';
  return 'lot';
}

/**
 * Extract the UUID from a raw bin scan (handles payloads with surrounding
 * text). Returns null if no UUID found.
 */
function extractBinToken(raw: string): string | null {
  const m = raw.trim().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

/**
 * Normalize a lot identifier from a raw scan. Uppercases lot-code shaped
 * values; passes UUIDs and arbitrary identifiers through (capped at 120
 * chars — the schema cap on lots.external_code).
 */
function normalizeLotIdentifier(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > 120) return null;
  if (LOT_CODE_RE.test(trimmed.toUpperCase())) return trimmed.toUpperCase();
  return trimmed;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ShelfScanPutAwayScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  // Battery (recap 2026-07-08): stop the camera when this screen is
  // behind another route or the app is backgrounded.
  const cameraGate = useCameraGate();
  const router = useRouter();

  const device = useBackCamera();
  const cameraRef = useRef<Camera | null>(null);
  const focus = useTapToFocus(cameraRef);

  // ── Visual state ──────────────────────────────────────────────────────────
  const [visualState, setVisualState] = useState<VisualState>('scanning');

  // ── Accumulated lot identifiers (optimistic — strategy B) ────────────────
  const [scannedCodes, setScannedCodes] = useState<string[]>([]);
  // Set for O(1) dedup. Keyed on lowercased identifier + timestamp bucket.
  const recentScans = useRef<Map<string, number>>(new Map());

  // ── Commit state ──────────────────────────────────────────────────────────
  const [lastBinToken, setLastBinToken] = useState<string | null>(null);
  const [lastBinCode, setLastBinCode] = useState<string | null>(null);
  const [results, setResults] = useState<BatchResultRow[]>([]);
  const [commitError, setCommitError] = useState<string | null>(null);

  // ── Toast ─────────────────────────────────────────────────────────────────
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Processing gate (prevents double-fire within one camera frame batch) ──
  const processingRef = useRef(false);

  // ── Per-row move confirmation state ──────────────────────────────────────
  // Maps lot_id → 'confirming' | 'confirmed' | 'error'
  const [moveStates, setMoveStates] = useState<Record<string, 'confirming' | 'confirmed' | 'error'>>({});

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_DURATION_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  // ── Code scanner (single scanner — handles both lot codes and bin QRs) ────
  const codeScanner = useCodeScanner({
    codeTypes: ALL_RETAIL_CODE_TYPES,
    onCodeScanned: (codes) => {
      if (visualState !== 'scanning' || processingRef.current) return;
      const c = firstCodeValue(codes);
      if (!c) return;
      void handleScan(c.data);
    },
  });

  // ── Scan handler ──────────────────────────────────────────────────────────
  const handleScan = useCallback(
    async (raw: string) => {
      if (visualState !== 'scanning' || processingRef.current) return;

      const classification = classifyScan(raw);

      // If it looks like a bin QR AND we have ≥1 lot queued → commit path.
      if (classification === 'bin' && scannedCodes.length >= 1) {
        processingRef.current = true;
        const token = extractBinToken(raw);
        if (!token) {
          processingRef.current = false;
          return;
        }
        // 2026-07-08 fix ("tote gave an error"): a lot's pre-printed QR is
        // ALSO a bare UUID, so with a non-empty queue it was misread as the
        // bin and the commit failed "Bin QR not accepted". Verify the UUID is
        // a real bin first; if it's a lot's qr_token, fall through and queue
        // it as a lot (the batch RPC resolves qr_token server-side).
        const { data: binRow } = await supabase
          .from('bins')
          .select('id')
          .eq('qr_token', token)
          .maybeSingle();
        if (!binRow) {
          const { data: lotRow } = await supabase
            .from('lots')
            .select('id')
            .eq('qr_token', token)
            .maybeSingle();
          processingRef.current = false;
          if (!lotRow) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            showToast('QR not recognized — not a bin label or a lot sticker for your operator.');
            return;
          }
          // It's a lot QR — fall through to the lot-queue path below.
        } else {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          await commitBatch(token);
          processingRef.current = false;
          return;
        }
      }

      // Treat as lot identifier.
      const id = normalizeLotIdentifier(raw);
      if (!id) return;

      const key = id.toLowerCase();
      const now = Date.now();

      // Dedup: ignore same code scanned within DEDUP_WINDOW_MS.
      const lastAt = recentScans.current.get(key);
      if (lastAt !== undefined && now - lastAt < DEDUP_WINDOW_MS) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        showToast('Already scanned');
        return;
      }

      recentScans.current.set(key, now);
      setScannedCodes((prev) => [...prev, id]);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
    [visualState, scannedCodes, showToast],
  );

  // ── Batch commit ──────────────────────────────────────────────────────────
  const commitBatch = useCallback(
    async (binToken: string) => {
      setLastBinToken(binToken);
      setVisualState('committing');
      setCommitError(null);
      setMoveStates({});

      try {
        const { data, error } = await supabase.rpc('batch_intake_lot_to_bin', {
          p_lot_identifiers: scannedCodes,
          p_bin_qr_token: binToken,
        });

        if (error) throw error;

        const rows = (data ?? []) as BatchResultRow[];

        // 0 rows = bin not found / revoked / wrong operator.
        if (rows.length === 0) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          setCommitError('Bin QR not accepted — not found, revoked, or wrong operator. Go back and scan the correct bin.');
          setVisualState('scanning');
          return;
        }

        // Derive bin code from first ok row for display.
        const firstOk = rows.find((r) => r.ok);
        setLastBinCode(firstOk?.bin_code ?? null);

        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setResults(rows);
        setVisualState('results');
      } catch (err) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setCommitError((err as Error).message);
        setVisualState('scanning');
      }
    },
    [scannedCodes],
  );

  // ── Confirm move (inline Yes on pending_move rows) ─────────────────────
  const confirmMove = useCallback(
    async (row: BatchResultRow) => {
      if (!row.lot_id || !lastBinToken) return;
      setMoveStates((prev) => ({ ...prev, [row.lot_id!]: 'confirming' }));

      try {
        const { data, error } = await supabase.rpc('confirm_move_lot_to_bin', {
          p_lot_id: row.lot_id,
          p_bin_qr_token: lastBinToken,
        });
        if (error) throw error;
        const result = data as { ok: boolean; reason: string } | null;
        if (!result?.ok) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          setMoveStates((prev) => ({ ...prev, [row.lot_id!]: 'error' }));
          return;
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setMoveStates((prev) => ({ ...prev, [row.lot_id!]: 'confirmed' }));
      } catch {
        setMoveStates((prev) => ({ ...prev, [row.lot_id!]: 'error' }));
      }
    },
    [lastBinToken],
  );

  // ── Reset to scanning state ───────────────────────────────────────────────
  const reset = useCallback(() => {
    setScannedCodes([]);
    recentScans.current.clear();
    setResults([]);
    setLastBinToken(null);
    setLastBinCode(null);
    setCommitError(null);
    setMoveStates({});
    setToast(null);
    processingRef.current = false;
    setVisualState('scanning');
  }, []);

  // ── Camera permission gate ────────────────────────────────────────────────
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

  // ── State C — Results ─────────────────────────────────────────────────────
  if (visualState === 'results') {
    const binDisplay = lastBinCode ?? '—';
    const successRows = results.filter((r) => r.ok);
    const pendingMoveRows = results.filter((r) => !r.ok && r.code === 'pending_move');
    const errorRows = results.filter((r) => !r.ok && r.code !== 'pending_move');

    // Check if there's a bin-level error affecting all rows.
    const binLevelError =
      results.length > 0 &&
      results.every(
        (r) => r.code === 'bin_not_found_or_revoked' || r.code === 'bin_retired',
      )
        ? (ERROR_LABELS[results[0]?.code ?? ''] ?? results[0]?.code ?? null)
        : null;

    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
              shelf scan · results
            </Text>
            <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700', marginTop: 2 }}>
              {successRows.length} of {results.length} placed in{' '}
              <Text style={{ color: colors.primary, fontFamily: 'monospace' }}>
                {binDisplay}
              </Text>
            </Text>
          </View>
        </View>

        {/* Bin-level error banner */}
        {binLevelError && (
          <View style={[styles.bannerRow, { backgroundColor: colors.dangerDim, borderColor: colors.danger }]}>
            <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '700' }}>
              {binLevelError}
            </Text>
          </View>
        )}

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 140, gap: 8 }}>
          {/* Success rows */}
          {successRows.map((r) => (
            <View
              key={r.identifier}
              style={[styles.resultRow, { borderColor: colors.success, backgroundColor: colors.successDim }]}
            >
              <Text style={{ color: colors.success, fontSize: 16, marginRight: 8 }}>✓</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.resultCode}>{lotDisplayCode({ lot_code: r.lot_code, sticker_code: r.sticker_code }) ?? r.lot_code ?? r.identifier}</Text>
                <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>
                  {r.code === 'ok_intaked'
                    ? `Intaked into ${r.bin_code ?? binDisplay}`
                    : r.code === 'ok_already_here'
                      ? `Already in ${r.bin_code ?? binDisplay}`
                      : r.code === 'ok_moved'
                        ? `Moved to ${r.bin_code ?? binDisplay}`
                        : (ERROR_LABELS[r.code ?? ''] ?? r.code ?? 'OK')}
                </Text>
              </View>
            </View>
          ))}

          {/* pending_move rows — inline Yes/No */}
          {pendingMoveRows.map((r) => {
            const moveState = r.lot_id ? moveStates[r.lot_id] : undefined;
            if (moveState === 'confirmed') {
              return (
                <View
                  key={r.identifier}
                  style={[styles.resultRow, { borderColor: colors.success, backgroundColor: colors.successDim }]}
                >
                  <Text style={{ color: colors.success, fontSize: 16, marginRight: 8 }}>✓</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.resultCode}>{lotDisplayCode({ lot_code: r.lot_code, sticker_code: r.sticker_code }) ?? r.lot_code ?? r.identifier}</Text>
                    <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>
                      {`Moved to ${r.bin_code ?? binDisplay} from ${r.from_bin_code ?? '?'}`}
                    </Text>
                  </View>
                </View>
              );
            }

            if (moveState === 'error') {
              return (
                <View
                  key={r.identifier}
                  style={[styles.resultRow, { borderColor: colors.danger, backgroundColor: colors.dangerDim }]}
                >
                  <Text style={{ color: colors.danger, fontSize: 16, marginRight: 8 }}>✗</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.resultCode}>{lotDisplayCode({ lot_code: r.lot_code, sticker_code: r.sticker_code }) ?? r.lot_code ?? r.identifier}</Text>
                    <Text style={{ color: colors.danger, fontSize: 12, marginTop: 2 }}>
                      Move failed — try again or skip
                    </Text>
                  </View>
                </View>
              );
            }

            return (
              <View
                key={r.identifier}
                style={[styles.resultRow, { borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.12)' }]}
              >
                <Text style={{ color: '#f59e0b', fontSize: 15, marginRight: 8 }}>
                  ⚠
                </Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.resultCode}>{lotDisplayCode({ lot_code: r.lot_code, sticker_code: r.sticker_code }) ?? r.lot_code ?? r.identifier}</Text>
                  <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>
                    {`In ${r.from_bin_code ?? '?'}. Move to ${r.bin_code ?? binDisplay}?`}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                    <Pressable
                      onPress={() => void confirmMove(r)}
                      disabled={moveState === 'confirming'}
                      style={[
                        styles.inlineBtn,
                        { backgroundColor: colors.primary, opacity: moveState === 'confirming' ? 0.5 : 1 },
                      ]}
                    >
                      {moveState === 'confirming' ? (
                        <ActivityIndicator color="#000" size="small" />
                      ) : (
                        <Text style={{ color: '#000', fontSize: 12, fontWeight: '700' }}>Yes, move</Text>
                      )}
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        // Mark as skipped by setting a local flag — just remove from pending display.
                        if (r.lot_id) {
                          setMoveStates((prev) => ({ ...prev, [r.lot_id!]: 'error' }));
                        }
                      }}
                      style={[styles.inlineBtn, { borderColor: colors.border, borderWidth: 1 }]}
                    >
                      <Text style={{ color: colors.textMuted, fontSize: 12, fontWeight: '700' }}>Skip</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            );
          })}

          {/* Error rows */}
          {errorRows.map((r) => (
            <View
              key={r.identifier}
              style={[styles.resultRow, { borderColor: colors.danger, backgroundColor: colors.dangerDim }]}
            >
              <Text style={{ color: colors.danger, fontSize: 16, marginRight: 8 }}>✗</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.resultCode}>{lotDisplayCode({ lot_code: r.lot_code, sticker_code: r.sticker_code }) ?? r.lot_code ?? r.identifier}</Text>
                <Text style={{ color: colors.danger, fontSize: 12, marginTop: 2 }}>
                  {ERROR_LABELS[r.code ?? ''] ?? r.code ?? 'Unknown error'}
                </Text>
                {r.code === 'not_lotted_yet' && (
                  <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>
                    Create a draft in Lotting, then scan again.
                  </Text>
                )}
                {r.error != null && r.code !== 'not_lotted_yet' && (
                  <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>
                    {r.error}
                  </Text>
                )}
              </View>
            </View>
          ))}
        </ScrollView>

        {/* Action buttons */}
        <View style={styles.bottomBar}>
          <Pressable onPress={reset} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Scan another batch</Text>
          </Pressable>
          <Pressable
            onPress={() => router.back()}
            style={styles.ghostBtn}
          >
            <Text style={styles.ghostBtnText}>Back to Put-away</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── State B — Committing ──────────────────────────────────────────────────
  if (visualState === 'committing') {
    return (
      <View style={styles.centeredFull}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Text style={{ color: colors.textMuted, fontSize: 14, marginTop: 16, textAlign: 'center' }}>
          {`Putting ${scannedCodes.length} lot${scannedCodes.length !== 1 ? 's' : ''} into bin…`}
        </Text>
      </View>
    );
  }

  // ── State A — Scanning ────────────────────────────────────────────────────
  const count = scannedCodes.length;
  const hasLots = count >= 1;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header */}
      <View style={styles.scanHeader}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
            shelf scan + put-away
          </Text>
          <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 2 }}>
            {hasLots
              ? `Scanned: ${count} — now scan a bin QR to commit`
              : 'Scan lot QRs, then bin QR to commit'}
          </Text>
        </View>
        <Pressable
          onPress={() => {
            reset();
            router.back();
          }}
          style={styles.cancelPill}
        >
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>Cancel</Text>
        </Pressable>
      </View>

      {/* C1: intake-vs-stage clarifier. The bin commit flips every lot to
          IN INVENTORY. Staging a won lot for pickup (assign-only, status
          unchanged) is a separate Check Out flow — say so explicitly so a
          stage isn't mistaken for a put-away. */}
      <Text style={styles.modeHint}>
        Committing moves lots to{' '}
        <Text style={{ color: colors.success, fontWeight: '800' }}>Inventory</Text>. To stage won
        lots for pickup (no inventory change), use Check Out.
      </Text>

      {/* Commit error banner (shown after a failed commit when returning to scanning) */}
      {commitError != null && (
        <View style={[styles.bannerRow, { backgroundColor: colors.dangerDim, borderColor: colors.danger }]}>
          <Text style={{ color: colors.danger, fontSize: 12 }}>{commitError}</Text>
          <Pressable onPress={() => setCommitError(null)} hitSlop={12}>
            <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 4 }}>Dismiss</Text>
          </Pressable>
        </View>
      )}

      {/* Toast */}
      {toast != null && (
        <View style={styles.toast}>
          <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>{toast}</Text>
        </View>
      )}

      {/* Camera preview */}
      {device ? (
        <View style={styles.cameraContainer}>
          <Camera
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            device={device}
            isActive={cameraGate && (visualState === 'scanning')}
            codeScanner={codeScanner}
          />
          <Pressable style={StyleSheet.absoluteFill} onPress={focus.onTap} />
          {focus.indicator}

          {/* Counter pill overlay */}
          {hasLots && (
            <View style={styles.counterPill}>
              <Text style={{ color: '#000', fontSize: 13, fontWeight: '800' }}>
                {count} scanned
              </Text>
            </View>
          )}

          {/* Instruction overlay */}
          <View style={styles.cameraLabel} pointerEvents="none">
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', textAlign: 'center' }}>
              {hasLots
                ? `${count} lot${count !== 1 ? 's' : ''} ready — scan a bin QR to commit`
                : 'Scan lot QR codes one at a time'}
            </Text>
          </View>
        </View>
      ) : (
        <View style={[styles.cameraContainer, { justifyContent: 'center', alignItems: 'center' }]}>
          <ActivityIndicator color={colors.primary} />
        </View>
      )}

      {/* Scanned-code list */}
      <FlatList
        data={scannedCodes}
        keyExtractor={(item, idx) => `${item}-${idx}`}
        style={{ flex: 1, marginHorizontal: 16, marginTop: 8 }}
        contentContainerStyle={{ gap: 6, paddingBottom: 8 }}
        inverted
        ListEmptyComponent={
          <Text style={styles.emptyLabel}>
            No lots scanned yet — point camera at a lot label.
          </Text>
        }
        renderItem={({ item, index }) => (
          <View style={styles.pendingRow}>
            <View style={styles.pendingIcon}>
              <Text style={{ color: colors.textDim, fontSize: 10 }}>LOT</Text>
            </View>
            <Text
              style={styles.pendingCode}
              numberOfLines={1}
            >
              {item}
            </Text>
            {/* Index label so staff can count down */}
            <Text style={{ color: colors.textDim, fontSize: 11 }}>
              #{scannedCodes.length - index}
            </Text>
          </View>
        )}
      />

      {/* Bottom bar */}
      <View style={styles.bottomBar}>
        {hasLots ? (
          <Text style={{ color: colors.textMuted, fontSize: 12, textAlign: 'center', marginBottom: 4 }}>
            Scan a bin QR label to commit all {count} lot{count !== 1 ? 's' : ''}
          </Text>
        ) : null}
        <Pressable
          onPress={() => {
            reset();
            router.back();
          }}
          style={styles.ghostBtn}
        >
          <Text style={styles.ghostBtnText}>
            {hasLots ? 'Cancel & discard' : 'Done'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  scanHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  cancelPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    marginLeft: 10,
  },
  cameraContainer: {
    height: 240,
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  counterPill: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: colors.primary,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  cameraLabel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  toast: {
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
  },
  bannerRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  modeHint: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    backgroundColor: colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 10,
  },
  pendingIcon: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingCode: {
    flex: 1,
    color: colors.primary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    fontWeight: '900',
  },
  emptyLabel: {
    color: colors.textDim,
    fontSize: 13,
    textAlign: 'center',
    marginTop: 12,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  resultCode: {
    color: colors.primary,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    fontWeight: '900',
  },
  inlineBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 70,
  },
  bottomBar: {
    padding: 16,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  primaryBtn: {
    padding: 15,
    backgroundColor: colors.primary,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#000',
    fontSize: 15,
    ...type.label,
  },
  ghostBtn: {
    padding: 14,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: 'center',
  },
  ghostBtnText: {
    color: colors.textMuted,
    fontSize: 14,
  },
  centeredFull: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
});
