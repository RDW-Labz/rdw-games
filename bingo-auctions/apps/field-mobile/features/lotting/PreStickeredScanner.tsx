// Full-screen modal that captures the sticker UUID for a freshly-created
// lot in Flow B. Mounted by each lotting entry screen (quick, photo,
// scan, web) on the SUCCESS path when mode === 'prestickered'.
//
// Flow:
//   1. Open camera, scan for QR.
//   2. On a decoded code, extract the UUID portion (raw or via the
//      universal-link URL form) and POST it to claim_prestickered_qr.
//   3. On `{ ok: true }` show "Sticker assigned — {lot_code}" for
//      SUCCESS_HOLD_MS, then call onAssigned so the parent can dismiss +
//      show its own toast. (Until 2026-07-29 this step was documented but
//      not implemented — onAssigned fired synchronously and the modal just
//      vanished on a haptic.) Idempotent re-claims of the same UUID against
//      the same lot are accepted as success — they happen when the operator
//      double-taps a sticker before the camera locks.
//   4. On `{ ok: false }` show the failure reason and offer Retry or
//      "Use auto-generated QR" (which just closes the modal as if the
//      operator picked Generate mode — the lot already has its auto-gen
//      qr_token from creation, so this is a no-op skip).
//
// Camera uses the same react-native-vision-camera + useCodeScanner +
// ALL_RETAIL_CODE_TYPES pattern as the picker/intake scan so we stay on
// a single proven scanner stack across the staff app.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  Camera,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';
import { useCameraGate } from '@/features/camera/useCameraGate';
import * as Haptics from 'expo-haptics';
import { useBackCamera } from '@/features/camera/useBackCamera';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import {
  ALL_RETAIL_CODE_TYPES,
  firstCodeValue,
} from '@/lib/vision-camera';
import { colors } from '@auction-platform/design-system';
import {
  bindStickerToLot,
  validateStickerScan,
  STICKER_REASON_COPY,
  type BindStickerResult,
} from './bindStickerToLot';

// How long the "Sticker assigned" confirmation stays up before the modal hands
// control back. Also the window in which this modal's camera session releases
// before the parent screen re-activates its own — see assignedCode below.
const SUCCESS_HOLD_MS = 900;

interface PreStickeredScannerProps {
  /** Lot we're attaching the sticker to. Absent in capture mode. */
  lotId?: string;
  /** Display copy — the lot_code the operator just minted. Absent in capture mode. */
  lotCode?: string;
  /**
   * Capture mode (2026-10-05, sticker before save): the lot does not exist
   * yet. A scan is validated (empty / retail barcode / carrier label refused,
   * the same checks the bind does) and handed back through `onCaptured`
   * without any RPC; the screen then saves the lot and binds this value.
   * The X button means "don't save" (`onAbort`). A manager's skip returns ''
   * so the screen saves without a sticker, as before.
   */
  capture?: {
    onCaptured: (code: string) => void;
    onAbort: () => void;
  };
  /** Fired on a successful claim. Parent typically dismisses + advances. */
  onAssigned: () => void;
  /** Fired when the operator bails out (X button or "Use auto-generated"
   *  fallback). Parent should treat this as "lot saved with auto-gen
   *  qr_token, no sticker assigned." */
  onCancel: () => void;
  /**
   * Discard the lot this modal is asking to sticker.
   *
   * Reported 2026-08-20 (staff member): "when you go to search something up and it
   * doesn't pull any information it will automatically take you to go scan a
   * sticker, even though there's nothing to be scanned. It creates a quick lot
   * and we have to go back into our inventory and delete it."
   *
   * The lot is minted BEFORE this step, so every exit here used to leave one
   * behind: a picker had no exit at all, and a manager's "Skip anyway" left an
   * unstickered lot to hunt down in Inventory later. This is the exit that
   * matches what the operator actually means — the lot should not exist.
   */
  onDiscard?: () => void;
  /** C2 (sticker-skip manager gate): whether this user may skip binding a
   *  sticker. Gated on manager role by callers via
   *  `hasOperatorRole(role, 'manager')`. When false (the default), the skip
   *  affordances (footer "Skip" button + the X/back "Skip anyway" path) are
   *  hidden/disabled, so a picker can't dead-end a lot at put-away by
   *  leaving its pre-printed label unbound. A non-manager must scan the
   *  sticker (or hand the device to a manager) to clear the modal. */
  canSkip?: boolean;
  /** Scan-recovery mode (2026-07-08): allow REPLACING an existing sticker
   *  code (routes through rebind_sticker_code, which audit-logs the change).
   *  Used by the "Fix sticker / code" action on a just-created lot. */
  rebind?: boolean;
}

export function PreStickeredScanner({
  lotId,
  lotCode: lotCodeProp,
  capture,
  onAssigned,
  onCancel,
  onDiscard,
  canSkip = false,
  rebind = false,
}: PreStickeredScannerProps) {
  const lotCode = lotCodeProp ?? 'the new lot';
  const { hasPermission, requestPermission } = useCameraPermission();
  // Battery (recap 2026-07-08): stop the camera when this screen is
  // behind another route or the app is backgrounded.
  const cameraGate = useCameraGate();
  const cameraRef = useRef<Camera>(null);
  const device = useBackCamera();
  const focus = useTapToFocus(cameraRef);
  const [busy, setBusy] = useState(false);
  const [errorCopy, setErrorCopy] = useState<string | null>(null);
  // Success confirmation (staff report 2026-07-29). The header above has always
  // claimed we "show 'Sticker assigned'", but the success path called
  // onAssigned() synchronously, so the modal just vanished on a haptic. With
  // the parent camera also coming back black, staff had no way to tell whether
  // the bind had worked and were force-closing the app to check.
  //
  // Holding this state does double duty: it renders the confirmation AND it
  // deactivates this modal's camera first, so the AVCaptureSession is already
  // releasing while the message is on screen and the parent's camera is not
  // racing a live session when it resumes.
  const [assignedCode, setAssignedCode] = useState<string | null>(null);
  // Ref-based lock so multiple consecutive scans (vision-camera fires
  // on every frame match) collapse to a single claim attempt.
  const inFlightRef = useRef(false);
  // Latches on success so neither a late frame nor the manual-entry field can
  // fire a second claim while the confirmation is showing. The `finally` below
  // clears inFlightRef unconditionally, so that lock alone is not enough.
  const assignedRef = useRef(false);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [manualInput, setManualInput] = useState('');

  const claim = useCallback(
    async (rawCode: string, manualEntry = false) => {
      if (inFlightRef.current || assignedRef.current) return;
      inFlightRef.current = true;
      setBusy(true);
      setErrorCopy(null);
      try {
        // Capture mode: validate only, no lot yet. Same guards as the bind.
        if (capture) {
          const v = validateStickerScan(rawCode, { manualEntry });
          if (v.ok) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            assignedRef.current = true;
            setAssignedCode(v.code);
            setBusy(false);
            successTimerRef.current = setTimeout(() => {
              successTimerRef.current = null;
              capture.onCaptured(v.code);
            }, SUCCESS_HOLD_MS);
            return;
          }
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          setErrorCopy(STICKER_REASON_COPY[v.reason] ?? `Couldn't read sticker: ${v.reason}`);
          return;
        }
        if (!lotId) {
          setErrorCopy('No lot to bind to.');
          return;
        }
        // Single source of truth for the bind dispatch (UUID → qr_token lane;
        // any other code → sticker_code lane). Shared with quick.tsx's Option B
        // auto-bind so the modal and the inline single-scan path behave
        // identically.
        //
        // manualEntry waives the carrier/retail barcode guard (0308). Only the
        // typed field below passes it — a camera scan is what the guard exists
        // for, so handleScan must never set it.
        const result: BindStickerResult = await bindStickerToLot(lotId, rawCode, {
          rebind,
          manualEntry,
        });
        if (result.ok) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          assignedRef.current = true;
          setAssignedCode(lotCode);
          setBusy(false);
          // Long enough to read, short enough not to slow a lotting run.
          successTimerRef.current = setTimeout(() => {
            successTimerRef.current = null;
            onAssigned();
          }, SUCCESS_HOLD_MS);
          return;
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        // Name the existing lot when we're blocking a duplicate twin so staff
        // know exactly which lot to open / Relot instead (mig 0283).
        const dynamic =
          result.reason === 'raw_code_is_live_lot_code' && result.other_lot_code
            ? `That code is already lotted as live lot ${result.other_lot_code}. Open that lot, or use Relot for a returned item — don't create a second lot for it.`
            : null;
        setErrorCopy(
          dynamic ?? STICKER_REASON_COPY[result.reason] ?? `Couldn't assign sticker: ${result.reason}`,
        );
      } catch (err) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setErrorCopy((err as Error).message || 'Unknown server error.');
      } finally {
        setBusy(false);
        inFlightRef.current = false;
      }
    },
    [lotId, lotCode, onAssigned, rebind, capture],
  );

  // Never let the hold timer outlive the modal — a parent that tears this down
  // early (route change, hardware back) would otherwise get an onAssigned after
  // unmount.
  useEffect(
    () => () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    },
    [],
  );

  const handleScan = useCallback(
    (raw: string) => {
      if (busy || inFlightRef.current) return;
      const trimmed = raw.trim();
      if (!trimmed) return;
      // For lpn_sticker mode, any non-empty code is valid — pass raw to claim.
      // For prestickered mode, claim() will extract the UUID internally and
      // surface an error if the code isn't a UUID.
      void claim(trimmed);
    },
    [busy, claim],
  );

  const codeScanner = useCodeScanner({
    codeTypes: ALL_RETAIL_CODE_TYPES,
    onCodeScanned: (codes) => {
      const c = firstCodeValue(codes);
      if (c) handleScan(c.data);
    },
  });

  const submitManual = useCallback(() => {
    const trimmed = manualInput.trim();
    if (!trimmed) return;
    // claim() routes by value (UUID → qr_token lane; else → sticker_code lane).
    // manualEntry=true: someone typed this, so it is not a mis-scan and the
    // carrier-barcode guard steps aside (0308). This is the documented way to
    // bind a numeric label on a box that genuinely has one.
    void claim(trimmed, true);
  }, [manualInput, claim]);

  // Bail-out (X / Android-back / "Skip") used to dismiss SILENTLY, leaving the
  // lot with no sticker bound — the pre-printed label then dead-ends at "Lot
  // not found" when scanned during put-away (the field report behind J4). Gate
  // every skip behind a deliberate, warned confirmation so the binding can't be
  // lost by reflex.
  //
  // C2: skipping is now a manager-only action. For a manager (canSkip), the
  // warned confirmation offers "Skip anyway" → onCancel. For a non-manager
  // (default), there's no skip path at all: the alert explains a manager is
  // required and the only button returns to the scanner WITHOUT calling
  // onCancel, so the lot can't be left unstickered by a picker.
  const confirmSkip = useCallback(() => {
    if (busy) return;
    // Capture mode: nothing exists yet, so backing out just means no save.
    if (capture) {
      Alert.alert(
        'No sticker scanned',
        canSkip
          ? 'Scan the sticker on the box to save this lot. As a manager you can save it without one; the sticker scanner opens again after the save.'
          : 'Scan the sticker on the box to save this lot. Without one the lot is not saved.',
        [
          { text: 'Keep scanning', style: 'cancel' },
          ...(canSkip ? [{ text: 'Save without sticker', style: 'destructive' as const, onPress: () => capture.onCaptured('') }] : []),
          { text: "Don't save", style: 'destructive', onPress: capture.onAbort },
        ],
      );
      return;
    }

    // Discard is offered to EVERYONE, manager or not. Skipping leaves a
    // half-made lot in inventory and is rightly manager-gated; discarding
    // removes a lot that should never have existed, which is a smaller act
    // than the mis-lot it undoes — and refusing it just moves the cleanup to
    // Inventory, by hand, later. That is the round trip being reported.
    const discardButton = onDiscard
      ? [{ text: 'Discard lot', style: 'destructive' as const, onPress: onDiscard }]
      : [];

    if (!canSkip) {
      Alert.alert(
        'This lot still needs a sticker',
        `${lotCode} won't resolve at put-away without one. Scan the pre-printed label (or a BinGo Auctions QR) to bind it. If this item shouldn't have been lotted at all, discard it — only a manager can leave a real lot unstickered.`,
        [...discardButton, { text: 'Keep scanning', style: 'cancel' }],
      );
      return;
    }
    Alert.alert(
      'Skip sticker binding?',
      `${lotCode} will have NO sticker bound. The pre-printed label on the box won't resolve when you scan it during put-away — you'd have to look the lot up by ${lotCode} by hand. Scan the sticker now, skip if this lot truly has no label, or discard it if it shouldn't exist.`,
      [
        { text: 'Scan sticker', style: 'cancel' },
        ...discardButton,
        { text: 'Skip anyway', style: 'destructive', onPress: onCancel },
      ],
    );
  }, [busy, canSkip, lotCode, onCancel, onDiscard, capture]);

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={confirmSkip}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        {/* Header */}
        <View style={s.header}>
          <View style={{ flex: 1 }}>
            <Text style={s.headerTitle}>
              Scan sticker
            </Text>
            <Text style={s.headerSub} numberOfLines={1}>
              {capture ? 'before the lot is saved' : `for ${lotCode}`}
            </Text>
          </View>
          <Pressable onPress={confirmSkip} style={s.closeBtn} hitSlop={12}>
            <Text style={s.closeBtnText}>×</Text>
          </Pressable>
        </View>

        {/* Camera */}
        <View style={s.cameraWrap}>
          {!hasPermission ? (
            <View style={s.permissionBlock}>
              <Text style={s.permissionText}>
                Camera access is required to scan the sticker.
              </Text>
              <Pressable
                onPress={requestPermission}
                style={s.permissionBtn}
              >
                <Text style={s.permissionBtnText}>Allow camera</Text>
              </Pressable>
            </View>
          ) : device ? (
            <>
              <Camera
                ref={cameraRef}
                style={StyleSheet.absoluteFill}
                device={device}
                isActive={cameraGate && !busy && !assignedCode}
                codeScanner={codeScanner}
              />
              <Pressable
                style={StyleSheet.absoluteFillObject}
                onPress={focus.onTap}
              />
              {focus.indicator}
              <View pointerEvents="none" style={s.scanGuideWrap}>
                <View style={s.scanGuide} />
              </View>
              {busy && (
                <View pointerEvents="none" style={s.busyOverlay}>
                  <ActivityIndicator color={colors.primary} size="large" />
                  <Text style={s.busyText}>{capture ? 'Checking sticker…' : 'Assigning sticker…'}</Text>
                </View>
              )}
              {/* Success confirmation. Covers the preview deliberately: the
                  camera is already deactivated here, so without it the
                  operator would be looking at a frozen/blank frame for the
                  hold window — the very thing that reads as "black screen". */}
              {assignedCode && (
                <View pointerEvents="none" style={s.successOverlay}>
                  <Text style={s.successTick}>✓</Text>
                  <Text style={s.successTitle}>{capture ? 'Sticker scanned' : 'Sticker assigned'}</Text>
                  <Text style={s.successCode}>{assignedCode}</Text>
                </View>
              )}
            </>
          ) : (
            <View style={s.busyOverlay}>
              <ActivityIndicator color={colors.primary} size="large" />
            </View>
          )}
        </View>

        {/* Footer instructions + error */}
        <View style={s.footer}>
          <Text style={s.instructions}>
            Scan the lot sticker — a pink/brown/teal BinGo label, a BinGo
            Auctions QR, or an LPN. Not the shipping label: FedEx and UPS
            barcodes are refused, because a tracking number is not a lot.
          </Text>

          {errorCopy && (
            <View style={s.errorBox}>
              <Text style={s.errorText}>{errorCopy}</Text>
            </View>
          )}

          {/* Manual fallback — paste/type the code for testing or when
              a sticker is physically damaged / code is hard to scan. */}
          <Text style={s.fallbackLabel}>
            Can&apos;t scan? Type the code:
          </Text>
          <View style={s.manualRow}>
            <TextInput
              value={manualInput}
              onChangeText={setManualInput}
              placeholder="Sticker code or UUID"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={s.manualInput}
              editable={!busy}
            />
            <Pressable
              onPress={submitManual}
              disabled={busy || !manualInput.trim()}
              style={[
                s.manualBtn,
                (busy || !manualInput.trim()) && { opacity: 0.5 },
              ]}
            >
              <Text style={s.manualBtnText}>{capture ? 'Use' : 'Assign'}</Text>
            </Pressable>
          </View>

          {/* C2: the explicit skip affordance is manager-only. Non-managers
              don't see a skip button — they must bind a sticker. */}
          {/* Rendered whenever there is ANY way out — not just for managers.
              A picker with no skip right and no discard had no exit at all
              here: no button, and the only alert offered "Keep scanning".
              Force-quitting the app was the way out, which is how a lot ends
              up abandoned mid-flow. */}
          {(canSkip || onDiscard || capture) && (
            <Pressable onPress={confirmSkip} style={s.escapeBtn} disabled={busy}>
              <Text style={s.escapeBtnText}>
                {capture
                  ? "No sticker? Don't save this lot"
                  : canSkip
                    ? "Skip — this lot won't have a sticker"
                    : "No sticker for this item?"}
              </Text>
            </Pressable>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: '900',
  },
  headerSub: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  closeBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
  },
  closeBtnText: {
    color: colors.textMuted,
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 22,
  },
  cameraWrap: {
    flex: 1,
    backgroundColor: '#000',
  },
  permissionBlock: {
    flex: 1,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  permissionText: {
    color: colors.text,
    fontSize: 15,
    textAlign: 'center',
  },
  permissionBtn: {
    padding: 14,
    backgroundColor: colors.primary,
    borderRadius: 10,
    minWidth: 180,
  },
  permissionBtnText: {
    color: '#000',
    fontWeight: '900',
    textAlign: 'center',
  },
  scanGuideWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanGuide: {
    width: '70%',
    aspectRatio: 1,
    maxHeight: 260,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: 'transparent',
  },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  busyText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '800',
    marginTop: 10,
  },
  successOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.82)',
    gap: 6,
  },
  successTick: {
    color: colors.success,
    fontSize: 56,
    fontWeight: '900',
    lineHeight: 62,
  },
  successTitle: {
    color: colors.success,
    fontSize: 18,
    fontWeight: '800',
  },
  successCode: {
    color: '#e8eaf0',
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  instructions: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
  errorBox: {
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.5)',
    backgroundColor: 'rgba(245,158,11,0.12)',
  },
  errorText: {
    color: '#f59e0b',
    fontSize: 12,
    fontWeight: '700',
  },
  fallbackLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 2,
  },
  manualRow: {
    flexDirection: 'row',
    gap: 8,
  },
  manualInput: {
    flex: 1,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    color: colors.text,
    backgroundColor: colors.surface,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  manualBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.primary,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  manualBtnText: {
    color: '#000',
    fontWeight: '900',
    fontSize: 13,
  },
  escapeBtn: {
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 4,
  },
  escapeBtnText: {
    color: colors.textMuted,
    fontWeight: '700',
    fontSize: 13,
  },
});
