// CameraCaptureSheet — shared full-screen photo-capture sheet with a REAL
// circular shutter.
//
// The headline fix for Quick Lot's add-photo step: every other lotting
// screen (photo.tsx, manual.tsx, worklist/[id].tsx) gives the operator a
// live viewfinder + a big shutter button. Quick Lot only had a tiny preview
// + a text "Add photo" button, so staff couldn't tell how to actually take
// the shot. This component is the one place that owns the
// "live viewfinder → tap shutter → review thumbnails → use photos" flow so
// every screen stays in lock-step.
//
// Composes the existing camera primitives (do NOT reinvent these):
//   - useBackCamera()        — virtual multi-lens back camera (close focus)
//   - useTapToFocus(ref)     — Apple-style tap-to-focus + fading indicator
//   - CameraFlashButton      — auto-hides on flash-less devices
//   - safeFlash / TAKE_PHOTO_OPTIONS / translateCaptureError (lib/vision-camera)
//
// Capture lifecycle mirrors photo.tsx's proven onShutter handler:
//   - shutterLockRef mutex so a frantic double-tap can't enqueue two
//     simultaneous takePhoto() calls.
//   - takePhoto({ flash: safeFlash(device, flashMode), ...TAKE_PHOTO_OPTIONS })
//     → uri = `file://${photo.path}` → append to local uris (capped at
//     maxPhotos) → light success haptic.
//   - capture failures surface via translateCaptureError in an inline
//     banner with a Retry affordance (never a raw camera error code).
//
// The sheet is uncontrolled w.r.t. its captured-photo list: it seeds from
// `initialUris` when it opens and hands the final list back via
// `onConfirm(uris)`. The parent decides what to do with the URIs (upload +
// create a lot, attach to an existing lot, etc) — this component never
// touches Supabase.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  ScrollView,
  ActivityIndicator,
  SafeAreaView,
  StyleSheet,
} from 'react-native';
import { Image } from 'expo-image';
import {
  Camera,
  useCameraPermission,
} from 'react-native-vision-camera';
import { useCameraGate } from '@/features/camera/useCameraGate';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { useBackCamera } from '@/features/camera/useBackCamera';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import { CameraFlashButton, type FlashMode } from '@/features/lotting/CameraFlashButton';
import { TAKE_PHOTO_OPTIONS, safeFlash, translateCaptureError } from '@/lib/vision-camera';
import { colors } from '@auction-platform/design-system';

export type CameraCaptureSheetProps = {
  /** Render the full-screen capture modal when true; camera is only
   *  `isActive` while this is true so we never hold the AVCaptureSession
   *  open behind a closed sheet. */
  open: boolean;
  /** Operator dismissed without confirming (X / Cancel / hardware back). */
  onClose: () => void;
  /** Operator tapped "Use photo(s)". Receives every captured `file://` URI
   *  in capture order (uris[0] is the hero). May be async — the footer
   *  button shows a spinner while it resolves. */
  onConfirm: (uris: string[]) => void | Promise<void>;
  /** Seed the strip with already-captured URIs (e.g. re-opening the sheet
   *  to add more). Read once when the sheet opens. */
  initialUris?: string[];
  /** Hard cap on captured photos. Default 6. */
  maxPhotos?: number;
  /** Header title. Default "Take photo". */
  title?: string;
};

const DEFAULT_MAX_PHOTOS = 6;

export function CameraCaptureSheet({
  open,
  onClose,
  onConfirm,
  initialUris,
  maxPhotos = DEFAULT_MAX_PHOTOS,
  title = 'Take photo',
}: CameraCaptureSheetProps) {
  const { hasPermission, requestPermission } = useCameraPermission();
  // Battery (recap 2026-07-08): stop the camera when this screen is
  // behind another route or the app is backgrounded.
  const cameraGate = useCameraGate();
  const cameraRef = useRef<Camera>(null);
  const device = useBackCamera();
  const focus = useTapToFocus(cameraRef);

  const [uris, setUris] = useState<string[]>([]);
  const [flashMode, setFlashMode] = useState<FlashMode>('auto');
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Mutex on the shutter — a frantic-tapper otherwise enqueues several
  // takePhoto() calls and double-captures. Same pattern as photo.tsx:200.
  const shutterLockRef = useRef(false);

  // Seed (and reset) the captured-photo list each time the sheet opens so a
  // re-open starts from the caller's initialUris rather than the prior run's
  // leftovers. Also clears transient capture/confirm state.
  useEffect(() => {
    if (open) {
      setUris((initialUris ?? []).slice(0, maxPhotos));
      setCaptureError(null);
      setConfirming(false);
    }
    // initialUris is intentionally read only on open transitions — the parent
    // may pass a fresh array reference on every render and we don't want to
    // clobber the operator's in-progress captures mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const atCap = uris.length >= maxPhotos;

  const onShutter = useCallback(async () => {
    if (shutterLockRef.current) return;
    if (!cameraRef.current) return;
    if (uris.length >= maxPhotos) return;
    shutterLockRef.current = true;
    try {
      // vision-camera v4: takePhoto returns { path } (no scheme) — prefix
      // file:// to match every other URI in the app. flash routed through
      // safeFlash so a flash-less iPad doesn't throw on capture.
      const photo = await cameraRef.current.takePhoto({
        flash: safeFlash(device, flashMode),
        ...TAKE_PHOTO_OPTIONS,
      });
      const uri = `file://${photo.path}`;
      setCaptureError(null);
      setUris((prev) => (prev.length >= maxPhotos ? prev : [...prev, uri]));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setCaptureError(translateCaptureError(err));
    } finally {
      shutterLockRef.current = false;
    }
  }, [uris.length, maxPhotos, device, flashMode]);

  // Gallery picker (owner request 2026-07-15): staff often find the correct
  // product photo in a browser, save it to the device, then want to attach it
  // straight from the gallery — faster and more reliable than re-shooting,
  // especially when a stock lookup came back blank. Picks up to the remaining
  // photo budget and appends them to the same strip captured shots use.
  const pickFromGallery = useCallback(async () => {
    if (uris.length >= maxPhotos) return;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setCaptureError('Photo library access is off — enable it in Settings to add a saved photo.');
        return;
      }
      const remaining = maxPhotos - uris.length;
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        allowsMultipleSelection: remaining > 1,
        selectionLimit: remaining,
      });
      if (result.canceled || !result.assets?.length) return;
      const picked = result.assets.map((a) => a.uri).filter(Boolean);
      if (picked.length === 0) return;
      setCaptureError(null);
      setUris((prev) => [...prev, ...picked].slice(0, maxPhotos));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setCaptureError(translateCaptureError(err));
    }
  }, [uris.length, maxPhotos]);

  const removePhoto = useCallback((index: number) => {
    setUris((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleConfirm = useCallback(async () => {
    if (uris.length === 0 || confirming) return;
    setConfirming(true);
    try {
      await onConfirm(uris);
    } finally {
      // Parent typically closes the sheet on confirm; guard against staying
      // stuck in the spinner if it doesn't.
      setConfirming(false);
    }
  }, [uris, confirming, onConfirm]);

  if (!open) return null;

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaView style={s.container}>
        {/* Header */}
        <View style={s.header}>
          <View style={{ flex: 1 }}>
            <Text style={s.headerTitle}>{title}</Text>
            <Text style={s.headerSub}>
              {uris.length} of {maxPhotos} photo{uris.length === 1 ? '' : 's'}
              {atCap ? ' · max reached' : ''}
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            style={s.closeBtn}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close camera"
          >
            <Text style={s.closeBtnText}>×</Text>
          </Pressable>
        </View>

        {/* Permission gate */}
        {!hasPermission ? (
          <View style={s.permissionBlock}>
            <Text style={s.permissionText}>
              Camera access is required to take a photo.
            </Text>
            <Pressable
              onPress={requestPermission}
              style={s.permissionBtn}
              accessibilityRole="button"
              accessibilityLabel="Allow camera"
            >
              <Text style={s.permissionBtnText}>Allow camera</Text>
            </Pressable>
            {/* Gallery still works without the camera — staff can attach a
                saved product photo even if camera access is off. */}
            <Pressable
              onPress={pickFromGallery}
              style={s.permissionGalleryBtn}
              accessibilityRole="button"
              accessibilityLabel="Choose from gallery"
            >
              <Text style={s.permissionGalleryBtnText}>🖼 Choose from gallery</Text>
            </Pressable>
            {uris.length > 0 && (
              <Pressable
                onPress={handleConfirm}
                disabled={confirming}
                style={s.permissionBtn}
                accessibilityRole="button"
                accessibilityLabel="Use photos"
              >
                <Text style={s.permissionBtnText}>
                  {confirming
                    ? 'Working…'
                    : uris.length <= 1
                      ? 'Use photo'
                      : `Use ${uris.length} photos`}
                </Text>
              </Pressable>
            )}
          </View>
        ) : (
          <>
            {/* Full-bleed viewfinder */}
            <View style={s.cameraWrap}>
              {device ? (
                <Camera
                  ref={cameraRef}
                  style={StyleSheet.absoluteFill}
                  device={device}
                  // Only stream while the sheet is open — releases the
                  // hardware the moment the parent closes it.
                  isActive={cameraGate && (open)}
                  photo={true}
                />
              ) : (
                <View style={s.cameraLoading}>
                  <ActivityIndicator color={colors.primary} size="large" />
                  <Text style={s.cameraLoadingText}>Starting camera…</Text>
                </View>
              )}

              {/* Tap-to-focus overlay — rendered BEFORE the flash button so
                  the button hit-tests first; taps that miss it fall through
                  to the focus handler. */}
              <Pressable style={StyleSheet.absoluteFillObject} onPress={focus.onTap} />
              <CameraFlashButton type="photo" mode={flashMode} onChange={setFlashMode} device={device} />
              {focus.indicator}

              {/* Capture error banner with retry. */}
              {captureError && (
                <View style={s.errorBanner}>
                  <Text style={s.errorBannerText}>{captureError}</Text>
                  <Pressable
                    onPress={() => {
                      setCaptureError(null);
                      void onShutter();
                    }}
                    style={s.errorRetryBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Retry photo"
                  >
                    <Text style={s.errorRetryText}>Retry</Text>
                  </Pressable>
                </View>
              )}

              {/* Large circular shutter — centered near the bottom of the
                  viewfinder. min 64×64, a11y labelled. */}
              <View pointerEvents="box-none" style={s.shutterRow}>
                <Pressable
                  onPress={onShutter}
                  disabled={atCap || !device}
                  accessibilityRole="button"
                  accessibilityLabel="Take photo"
                  accessibilityState={{ disabled: atCap || !device }}
                  hitSlop={12}
                  style={[s.shutterOuter, (atCap || !device) && { opacity: 0.4 }]}
                >
                  <View style={s.shutterInner} />
                </Pressable>
              </View>

              {/* Gallery picker — bottom-left, opposite the shutter. Lets staff
                  attach a photo they saved from the browser instead of shooting. */}
              <View pointerEvents="box-none" style={s.galleryRow}>
                <Pressable
                  onPress={pickFromGallery}
                  disabled={atCap}
                  accessibilityRole="button"
                  accessibilityLabel="Choose from gallery"
                  hitSlop={10}
                  style={[s.galleryBtn, atCap && { opacity: 0.4 }]}
                >
                  <Text style={s.galleryBtnText}>🖼 Gallery</Text>
                </Pressable>
              </View>
            </View>

            {/* Thumbnail strip — captured photos, hero first, each with a
                remove (×) badge. Reuses the photoClearBtn styling from
                EditableCandidateCard. */}
            {uris.length > 0 && (
              <View style={s.stripWrap}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8, paddingHorizontal: 14 }}
                >
                  {uris.map((uri, i) => (
                    <View key={`${uri}-${i}`} style={s.thumbWrap}>
                      <Image source={{ uri }} style={s.thumb} contentFit="cover" />
                      {i === 0 && (
                        <View style={s.heroBadge}>
                          <Text style={s.heroBadgeText}>HERO</Text>
                        </View>
                      )}
                      <Pressable
                        onPress={() => removePhoto(i)}
                        hitSlop={12}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove photo ${i + 1}`}
                        style={s.photoClearBtn}
                      >
                        <Text style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>
                          ×
                        </Text>
                      </Pressable>
                    </View>
                  ))}
                </ScrollView>
              </View>
            )}

            {/* Footer — Use photo(s) (disabled until ≥1) + Cancel. */}
            <View style={s.footer}>
              <Pressable
                onPress={handleConfirm}
                disabled={uris.length === 0 || confirming}
                accessibilityRole="button"
                accessibilityLabel="Use photos"
                style={[
                  s.useBtn,
                  (uris.length === 0 || confirming) && { backgroundColor: colors.surfaceHi },
                ]}
              >
                {confirming ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text
                    style={[
                      s.useBtnText,
                      uris.length === 0 && { color: colors.textMuted },
                    ]}
                  >
                    {uris.length <= 1
                      ? 'Use photo'
                      : `Use ${uris.length} photos`}
                  </Text>
                )}
              </Pressable>
              <Pressable
                onPress={onClose}
                disabled={confirming}
                style={s.cancelBtn}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={s.cancelBtnText}>Cancel</Text>
              </Pressable>
            </View>
          </>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
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
  cameraWrap: {
    flex: 1,
    backgroundColor: '#000',
  },
  cameraLoading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  cameraLoadingText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '700',
  },
  errorBanner: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(255,59,59,0.92)',
  },
  errorBannerText: {
    flex: 1,
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  errorRetryBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  errorRetryText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '900',
  },
  shutterRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Large circular shutter (Apple-Camera style): white ring with a filled
  // inner disc. 76×76 outer comfortably exceeds the 64×64 a11y minimum.
  shutterOuter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: '#ffffff',
    backgroundColor: 'rgba(0,0,0,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#ffffff',
  },
  // Gallery pill — bottom-left of the viewfinder, vertically aligned with the
  // shutter row so the two capture affordances sit on the same line.
  galleryRow: {
    position: 'absolute',
    left: 18,
    bottom: 40,
  },
  galleryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  galleryBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
  },
  permissionGalleryBtn: {
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 180,
  },
  permissionGalleryBtnText: {
    color: colors.text,
    fontWeight: '800',
    textAlign: 'center',
  },
  stripWrap: {
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  thumbWrap: {
    width: 84,
    height: 84,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    position: 'relative',
    borderWidth: 1,
    borderColor: colors.border,
  },
  thumb: {
    flex: 1,
    borderRadius: 10,
  },
  heroBadge: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    backgroundColor: colors.primary,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  heroBadgeText: {
    color: '#000',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  // Mirrors EditableCandidateCard.photoClearBtn so the remove affordance
  // looks identical across the app.
  photoClearBtn: {
    position: 'absolute',
    top: 3,
    right: 3,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  useBtn: {
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: colors.success,
    alignItems: 'center',
  },
  useBtnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '900',
  },
  cancelBtn: {
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  cancelBtnText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '700',
  },
});
