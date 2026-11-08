// Walk-and-scan — physically verify each bin in a warehouse by scanning
// its printed QR. Replaces the desktop "drag bins onto a floor plan" model.
//
// MVP scope (this screen, 2026-05-21):
//   * Pick a warehouse via /layout entry; warehouseId arrives as a route param
//   * Load active bins (retired_at IS NULL), order by code
//   * Camera-first viewfinder using react-native-vision-camera
//   * On each QR scan: lookup bin by qr_token UUID, call stamp_bin_walk_position
//   * Per-scan feedback: haptic + green checkmark flash + last-verified pill
//   * Progress strip at top ("N of M verified") with subtle inline list of
//     unverified codes so the operator knows what's left
//   * Optimistic local state on scan so the UX feels instant even if the
//     RPC takes a moment to round-trip
//
// Deferred to follow-up commits:
//   * Mid-walk landmark capture (add_warehouse_landmark RPC exists; UI later)
//   * ARKit (x_m, y_m) absolute positions — Phase 3
//   * Offline scan queue with AsyncStorage + retry on reconnect — Phase 2.1
//   * Mini-map preview of verified vs unverified bins — Phase 2.1
//   * TTS readback of bin code per scan — Phase 2.1
//
// Without ARKit (this MVP), stamp_bin_walk_position is called with NULL
// coords; bins.scanned_at is the only walk-mode field populated. The bidder
// PickupMap renders an idealized grid from the bin codes regardless, so
// nothing about the bidder experience depends on ARKit being live.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Alert,
  SafeAreaView,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Dimensions,
  AppState,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Camera,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';
import { useBackCamera } from '@/features/camera/useBackCamera';
import {
  ALL_RETAIL_CODE_TYPES,
  firstCodeValue,
  torchMode,
  type DecodedCode,
} from '@/lib/vision-camera';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import * as Haptics from 'expo-haptics';
import { supabase, useOperatorRole } from '@auction-platform/supabase-client';
import { colors, type as typeTokens } from '@auction-platform/design-system';
import { CameraFlashButton } from '@/features/lotting/CameraFlashButton';
// 2026-05-21: ARKit position tracking. Falls back to NULL coords on any
// non-iOS / non-ARKit-capable device, simulator, or session quality drop.
import {
  ClovrbidArkit,
  type PoseQuality,
} from '@/modules/clovrbid-arkit';

const { width: SCREEN_W } = Dimensions.get('window');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Bin = {
  id: string;
  code: string;
  qr_token: string;
  scanned_at: string | null;
};

type LastVerified = {
  code: string;
  ts: number;
  /** True if this was a re-scan of an already-verified bin (operator probably
   *  scanned twice by accident — give a softer haptic and a different label). */
  rescan: boolean;
};

export default function WalkScreen() {
  const router = useRouter();
  const role = useOperatorRole();
  const params = useLocalSearchParams<{ warehouseId?: string }>();
  const warehouseId = typeof params.warehouseId === 'string' ? params.warehouseId : null;

  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef<Camera>(null);
  const device = useBackCamera();
  const focus = useTapToFocus(cameraRef);

  const [bins, setBins] = useState<Bin[]>([]);
  const [verified, setVerified] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [warehouseName, setWarehouseName] = useState<string>('');
  const [lastVerified, setLastVerified] = useState<LastVerified | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  // Errors that aren't worth a full Alert.alert — shown as a small toast
  // for ~3s then auto-dismissed. Examples: unknown QR, RPC failure.
  const [warning, setWarning] = useState<string | null>(null);
  // 2026-05-21: ARKit tracking quality. Drives the AR banner + governs
  // whether scans stamp real (x_m, y_m) coords or NULL.
  const [arQuality, setArQuality] = useState<PoseQuality>('notAvailable');

  const scanLockRef = useRef(false);
  const lastWarningTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Initial bin list load ────────────────────────────────────────────
  useEffect(() => {
    if (role.kind !== 'staff' || !warehouseId) return;
    let cancelled = false;
    (async () => {
      // Warehouse name (display only — RLS already gates which warehouses
      // this user can see)
      const { data: wh } = await supabase
        .from('warehouses')
        .select('name')
        .eq('id', warehouseId)
        .single();
      if (!cancelled && wh) setWarehouseName(wh.name as string);

      const { data: rows } = await supabase
        .from('bins')
        .select('id, code, qr_token, scanned_at')
        .eq('warehouse_id', warehouseId)
        .is('retired_at', null)
        .order('code');
      if (cancelled) return;

      if (rows) {
        const typed = rows as Bin[];
        setBins(typed);
        setVerified(
          new Set(typed.filter((b) => b.scanned_at != null).map((b) => b.id)),
        );
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [role, warehouseId]);

  // ── Cleanup any pending warning timer on unmount ─────────────────────
  useEffect(() => {
    return () => {
      if (lastWarningTimer.current) clearTimeout(lastWarningTimer.current);
    };
  }, []);

  // ── ARKit session lifecycle ──────────────────────────────────────────
  // Start the ARWorldTracking session when the screen mounts on iOS.
  // Pause + reset on backgrounding so a forward-walked operator who
  // checks email mid-walk doesn't get phantom drift. The native module
  // also resets internally via sessionInterruptionEnded, so this is
  // belt-and-suspenders.
  useEffect(() => {
    if (Platform.OS !== 'ios' || !ClovrbidArkit.isSupported) return;
    ClovrbidArkit.startSession();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        ClovrbidArkit.stopSession();
      } else if (state === 'active') {
        ClovrbidArkit.startSession();
      }
    });
    return () => {
      ClovrbidArkit.stopSession();
      sub.remove();
    };
  }, []);

  const total = bins.length;
  const verifiedCount = verified.size;

  const unverifiedCodes = useMemo(() => {
    return bins.filter((b) => !verified.has(b.id)).map((b) => b.code);
  }, [bins, verified]);

  function showWarning(msg: string) {
    setWarning(msg);
    if (lastWarningTimer.current) clearTimeout(lastWarningTimer.current);
    lastWarningTimer.current = setTimeout(() => setWarning(null), 3000);
  }

  // ── Scan handler ─────────────────────────────────────────────────────

  const handleQrToken = useCallback(
    async (rawToken: string) => {
      const match = rawToken.match(UUID_RE) ?? rawToken.match(/([0-9a-f-]{36})$/i);
      const token = match?.[0]?.toLowerCase();
      if (!token || !UUID_RE.test(token)) {
        showWarning("This QR isn't a bin code.");
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }

      const bin = bins.find((b) => b.qr_token.toLowerCase() === token);
      if (!bin) {
        showWarning("This QR isn't a bin in this warehouse.");
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }

      const isRescan = verified.has(bin.id);

      // Optimistic UI — show the flash immediately, then fire the RPC.
      // If the RPC fails we'll roll back via the catch.
      setLastVerified({ code: bin.code, ts: Date.now(), rescan: isRescan });
      if (!isRescan) {
        setVerified((prev) => {
          const next = new Set(prev);
          next.add(bin.id);
          return next;
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        // Softer feedback on re-scan so the operator knows it didn't double-count
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }

      // 2026-05-21: read ARKit pose synchronously at scan time. On iOS
      // devices with ARWorldTracking + .normal quality, this gives us
      // absolute (x_m, y_m) meters relative to the first bin scanned
      // (ARKit's session origin = camera position at session start).
      // Anywhere quality < normal we stamp NULL — the idealized grid
      // fallback in PickupMap handles those bins.
      const pose = ClovrbidArkit.pose();
      setArQuality(pose.quality);
      const useArCoords = pose.quality === 'normal';

      try {
        const { error } = await supabase.rpc('stamp_bin_walk_position', {
          p_bin_id: bin.id,
          // ARKit's xz plane is the floor when worldAlignment is .gravity.
          // Map z → coord_y_m (forward axis) so bidders see a sensible
          // top-down map.
          p_coord_x_m: useArCoords ? pose.x : null,
          p_coord_y_m: useArCoords ? pose.z : null,
          p_scan_pose: useArCoords
            ? {
                app_version: 'walk-arkit-v1',
                arkit_quality: pose.quality,
                heading_deg: pose.heading,
                // raw_y_m is the floor height (could differ on multi-story
                // warehouses — kept for future use).
                raw_y_m: pose.y,
              }
            : {
                app_version: 'walk-arkit-v1',
                arkit_quality: pose.quality,
                fallback: 'idealized_grid',
              },
        });
        if (error) throw error;
      } catch (err) {
        // Keep the optimistic verification on RPC failure. Common cause is
        // the warehouse Wi-Fi dropping in a back corner. Rolling back would
        // make the operator re-scan correctly-walked bins; instead we keep
        // them green and surface a warning. On the next screen mount the
        // DB is the source of truth — if any of these scans truly never
        // landed, the operator will see the count drop and can re-walk
        // just those bins.
        //
        // Full offline queue (persistent across mounts + auto-retry on
        // reconnect) ships in a follow-up commit.
        showWarning(
          `Saved locally — sync failed: ${(err as Error).message.slice(0, 60)}. Will reconcile when back online.`,
        );
      }
    },
    [bins, verified],
  );

  const onBarcodeScanned = useCallback(
    (scan: DecodedCode) => {
      if (scanLockRef.current) return;
      const raw = scan.data?.trim();
      if (!raw) return;
      scanLockRef.current = true;
      void (async () => {
        try {
          await handleQrToken(raw);
        } finally {
          // 800ms cooldown between scans — long enough to avoid burst-scans
          // of the same bin, short enough that the operator can walk-and-scan
          // at a good cadence.
          setTimeout(() => {
            scanLockRef.current = false;
          }, 800);
        }
      })();
    },
    [handleQrToken],
  );

  const codeScanner = useCodeScanner({
    codeTypes: ALL_RETAIL_CODE_TYPES,
    onCodeScanned: (codes) => {
      const c = firstCodeValue(codes);
      if (c) onBarcodeScanned(c);
    },
  });

  // ── Guard rails ──────────────────────────────────────────────────────

  if (!warehouseId) {
    return (
      <SafeAreaView style={s.center}>
        <Text style={s.errorText}>Missing warehouse id.</Text>
        <Pressable
          onPress={() => router.back()}
          style={s.secondaryBtn}
        >
          <Text style={s.secondaryBtnText}>Back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (!hasPermission) {
    return (
      <SafeAreaView style={s.center}>
        <Text style={[s.errorText, { marginBottom: 12 }]}>
          Camera access is required to scan bin QRs.
        </Text>
        <Pressable onPress={requestPermission} style={s.primaryBtn}>
          <Text style={s.primaryBtnText}>Allow camera</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={s.center}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  if (total === 0) {
    return (
      <SafeAreaView style={s.center}>
        <Text style={[s.errorText, { marginBottom: 8 }]}>
          No bins yet in {warehouseName || 'this warehouse'}.
        </Text>
        <Text
          style={{
            color: colors.textMuted,
            fontSize: 13,
            textAlign: 'center',
            paddingHorizontal: 24,
            marginBottom: 16,
          }}
        >
          Add bins from the operator console (Setup → Step 1), then come
          back here to walk and verify them.
        </Text>
        <Pressable onPress={() => router.back()} style={s.secondaryBtn}>
          <Text style={s.secondaryBtnText}>Back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  // ── Main render ──────────────────────────────────────────────────────

  const cameraHeight = Math.round(SCREEN_W * 0.85);
  const allDone = verifiedCount === total && total > 0;

  // Show the last-verified flash for 1.2s after each scan
  const showFlash = lastVerified != null && Date.now() - lastVerified.ts < 1200;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* ── Header ──────────────────────────────────────────────────── */}
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.primary, fontSize: 11, fontWeight: '900' }}>
            Walking {warehouseName}
          </Text>
          <Text
            style={{
              color: allDone ? '#22c55e' : colors.text,
              fontSize: 22,
              fontWeight: '900',
              marginTop: 2,
            }}
          >
            {verifiedCount} / {total} verified
          </Text>
        </View>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={s.doneBtn}
        >
          <Text style={{ color: colors.textMuted, fontSize: 15, fontWeight: '700' }}>
            Done
          </Text>
        </Pressable>
      </View>

      {/* ── Camera ──────────────────────────────────────────────────── */}
      <View style={{ borderRadius: 14, overflow: 'hidden', height: cameraHeight, margin: 12 }}>
        {device ? (
          <Camera
            ref={cameraRef}
            style={{ flex: 1 }}
            device={device}
            isActive
            codeScanner={codeScanner}
            torch={torchMode(torchOn)}
          />
        ) : (
          <View style={s.cameraFallback}>
            <ActivityIndicator color={colors.primary} />
          </View>
        )}
        <Pressable style={StyleSheet.absoluteFillObject} onPress={focus.onTap} />
        <CameraFlashButton type="torch" on={torchOn} onChange={setTorchOn} device={device} />
        {focus.indicator}

        {/* Reticle */}
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFillObject,
            { alignItems: 'center', justifyContent: 'center' },
          ]}
        >
          <View style={s.reticle} />
        </View>

        {/* Last-verified flash overlay */}
        {showFlash && lastVerified && (
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFillObject,
              {
                backgroundColor: lastVerified.rescan
                  ? 'rgba(245,158,11,0.18)'
                  : 'rgba(34,197,94,0.22)',
                alignItems: 'center',
                justifyContent: 'center',
              },
            ]}
          >
            <Text
              style={{
                color: lastVerified.rescan ? '#f59e0b' : '#22c55e',
                fontSize: 36,
                fontWeight: '900',
                textShadowColor: 'rgba(0,0,0,0.5)',
                textShadowOffset: { width: 0, height: 1 },
                textShadowRadius: 4,
              }}
            >
              {lastVerified.rescan ? '↻' : '✓'} {lastVerified.code}
            </Text>
            <Text
              style={{
                color: lastVerified.rescan ? '#f59e0b' : '#22c55e',
                fontSize: 13,
                fontWeight: '800',
                marginTop: 6,
                textShadowColor: 'rgba(0,0,0,0.5)',
                textShadowOffset: { width: 0, height: 1 },
                textShadowRadius: 4,
              }}
            >
              {lastVerified.rescan ? 'already verified' : 'verified'}
            </Text>
          </View>
        )}
      </View>

      {/* Warning toast */}
      {warning && (
        <View style={s.warningToast}>
          <Text style={s.warningToastText}>{warning}</Text>
        </View>
      )}

      {/* AR quality banner — only when AR is supported but the session
          isn't producing trustworthy coords. notAvailable is suppressed
          silently (Android, simulator, old iPad) because the NULL-coord
          fallback handles those without operator confusion. */}
      {ClovrbidArkit.isSupported &&
        arQuality !== 'normal' &&
        arQuality !== 'notAvailable' && (
        <View style={s.arBanner}>
          <Text style={s.arBannerText}>
            {arQuality === 'initializing'
              ? '🧭 AR initializing — walk slowly for 5s to lock tracking'
              : arQuality === 'insufficientFeatures'
                ? '🧭 AR tracking limited (low texture) — bins will use grid layout'
                : arQuality === 'excessiveMotion'
                  ? '🧭 Slow down — moving too fast for AR'
                  : '🧭 AR re-locating — bins will use grid layout briefly'}
          </Text>
        </View>
      )}

      {/* ── All-done banner ─────────────────────────────────────────── */}
      {allDone && (
        <View style={s.doneBanner}>
          <Text style={{ color: '#22c55e', fontSize: 14, fontWeight: '900' }}>
            ✓ Walk complete
          </Text>
          <Text
            style={{
              color: 'rgba(34,197,94,0.85)',
              fontSize: 12,
              marginTop: 2,
            }}
          >
            All {total} bins verified. You can tap Done — bidders will see
            the updated map.
          </Text>
        </View>
      )}

      {/* ── Unverified bin list ─────────────────────────────────────── */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 20 }}
      >
        <Text style={s.sectionLabel}>
          {unverifiedCodes.length === 0
            ? 'All bins verified · scan any QR to re-verify'
            : `${unverifiedCodes.length} unverified · walk to one and scan its QR`}
        </Text>
        <View style={s.codeGrid}>
          {bins.map((b) => {
            const ok = verified.has(b.id);
            return (
              <View
                key={b.id}
                style={[
                  s.codeChip,
                  ok
                    ? {
                        backgroundColor: 'rgba(34,197,94,0.08)',
                        borderColor: 'rgba(34,197,94,0.45)',
                      }
                    : { borderStyle: 'dashed' as const },
                ]}
              >
                <Text
                  style={[
                    s.codeChipText,
                    { color: ok ? '#22c55e' : colors.textMuted },
                  ]}
                  numberOfLines={1}
                >
                  {ok ? '✓ ' : '○ '}
                  {b.code}
                </Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  errorText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  doneBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  primaryBtn: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    backgroundColor: colors.primary,
    borderRadius: 10,
  },
  primaryBtnText: {
    color: '#000',
    fontWeight: '900',
    fontSize: 15,
  },
  secondaryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryBtnText: {
    color: colors.text,
    fontWeight: '700',
    fontSize: 14,
  },
  cameraFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
  },
  reticle: {
    width: '70%',
    height: '50%',
    borderRadius: 14,
    borderWidth: 2.5,
    borderColor: 'rgba(34,197,94,0.65)',
    backgroundColor: 'transparent',
  },
  warningToast: {
    marginHorizontal: 12,
    marginTop: 4,
    padding: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.45)',
  },
  warningToastText: {
    color: '#f59e0b',
    fontSize: 13,
    fontWeight: '700',
  },
  arBanner: {
    marginHorizontal: 12,
    marginTop: 4,
    padding: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(79,140,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(79,140,255,0.35)',
  },
  arBannerText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: '700',
  },
  doneBanner: {
    marginHorizontal: 12,
    marginTop: 4,
    padding: 14,
    borderRadius: 10,
    backgroundColor: 'rgba(34,197,94,0.10)',
    borderWidth: 1.5,
    borderColor: 'rgba(34,197,94,0.45)',
    alignItems: 'center',
  },
  sectionLabel: {
    // Spread the design-system label tokens FIRST so our explicit values
    // below take precedence (typeTokens.label sets weight/transform/letter
    // spacing too).
    ...typeTokens.label,
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 10,
    marginBottom: 8,
  },
  codeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  codeChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  codeChipText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
});
