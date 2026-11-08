// AI Photo Scan — non-blocking, multi-photo flow.
//
// Operator behaviour the screen supports:
//   1. Open the screen → live camera viewfinder.
//   2. Tap shutter → first frame becomes the "hero" photo. AI scan
//      fires off in the BACKGROUND (no spinner overlay blocking the
//      camera); operator stays on the live viewfinder.
//   3. While AI is working, keep tapping shutter → those frames are
//      "condition photos" — accumulate as a thumbnail strip at the
//      bottom of the camera. No upload happens yet; URIs live in state.
//   4. When AI resolves:
//        • Success → auto-advance to the review screen. The AI's stock
//          photos (from retailer CDNs) and the operator's hero +
//          condition photos all appear in one thumbnail strip. Each
//          condition shot has a tap-to-remove ×. Operator edits the
//          AI-filled fields, taps Save.
//        • Failure → red banner on the camera with retry / discard
//          actions. Photos taken so far are preserved.
//   5. Save → mints the lot via create_draft_lot (with AI's
//      stockPhotos as the initial photo_urls), then uploads every
//      condition photo in parallel and PATCHes lots.photo_urls to
//      merge them in front of the stock images.
//
// Why CameraView instead of ImagePicker.launchCameraAsync:
//   ImagePicker bounces to the system camera UI, which fully suspends
//   the app every time. That makes "take another picture while it's
//   looking" impossible. CameraView keeps the JS thread live, lets us
//   await scanPhoto in the background, and lets the operator queue up
//   condition shots in 1-2s each. Same camera component Quick Lot
//   already uses.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Alert,
  ScrollView,
  SafeAreaView,
  StyleSheet,
  Dimensions,
  BackHandler,
  AppState,
  type AppStateStatus,
} from 'react-native';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import { Image } from 'expo-image';
import { useRouter, useNavigation, useFocusEffect, type Href } from 'expo-router';
import { enrichReturnRef } from '@/features/lotting/enrichReturnRef';
import { Camera, useCameraFormat, useCameraPermission } from 'react-native-vision-camera';
import { useCameraGate } from '@/features/camera/useCameraGate';
import { TAKE_PHOTO_OPTIONS, safeFlash, translateCaptureError } from '@/lib/vision-camera';
import { useDraftPersistence } from '@/features/lotting/useDraftPersistence';
import { useBackCamera } from '@/features/camera/useBackCamera';
import * as FileSystem from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { createDraftLotFromCandidate, type LotCandidate } from '@auction-platform/domain-lotting';
import { supabase, useOperatorRole, hasOperatorRole } from '@auction-platform/supabase-client';
// scanPhoto MUST come from the lottr-client proxy, NOT direct
// @auction-platform/domain-lotting. The direct import hits the legacy
// Anthropic web_search path which doesn't honor our cost-gate logic
// (and uses an entirely separate API key). The proxy version POSTs to
// /api/lottr/scan-photo, where the server runs scanPhoto with supabase
// (cheap two-step pipeline + my new low-confidence early-exit).
import { scanPhoto, shelfScan, enrichCandidate } from '@/lib/lottr-client';
import { PhotoViewer, usePhotoViewer } from '@/features/lotting/PhotoViewer';
import { LotCandidateCard } from '@/features/lotting/LotCandidateCard';
import { CameraFlashButton, type FlashMode } from '@/features/lotting/CameraFlashButton';
import { colors, type as typeTokens } from '@auction-platform/design-system';
import { useLottingSession, activeLotSource } from '@/features/lotting/SessionContext';
import { uploadLotPhotoPublic } from '@/features/lotting/useLotCreation';
import { isLocalPhotoUri } from '@/features/lotting/uploadPendingPhotos';
import { queueAndDrainLotPhotos, type LotPhotoInput } from '@/lib/lot-photo-save';
import { decideDraftRecovery } from '@/lib/draft-recovery';
import {
  BLOCKED_SKIP_TITLE,
  blockedSkipFlowFor,
  blockedSkipMessage,
  createBlockedSkipScreen,
  type BlockedSkipFlow,
  type BlockedSkipReason,
} from '@/lib/photo-blocked-skip';
import {
  gateAfterDraftLoad,
  mayStartNewItem,
  mayWriteDraft,
  type BlockedDraftSource,
  type DraftWriteGate,
} from '@/lib/photo-draft-gate';
import { photoQueueCountSafe, subscribePhotoQueue } from '@/lib/photo-upload-queue';
import { photoRecovery } from '@/lib/photo-recovery';
import { persistPhoto } from '@/lib/persist-photo';
import { useLottingMode } from '@/features/lotting/LottingModeContext';
import { lotCreateFailureReport, lotCreateUserMessage } from '@/lib/lot-create-failure';
import { reportNonFatal } from '@/lib/session-watchdog';
import {
  planStickerBeforeSave,
  NO_STICKER_SCANNED_TITLE,
  NO_STICKER_SCANNED_MESSAGE,
} from '@/lib/sticker-first';
import { bindStickerAfterSave, stickerRefusalCopy } from '@/features/lotting/stickerBindRunner';
import { LottingModeToggle } from '@/features/lotting/LottingModeToggle';
import { PreStickeredScanner } from '@/features/lotting/PreStickeredScanner';
import {
  EditableCandidateCard,
  candidateToEditable,
  editableToCandidate,
  type EditableCandidate,
} from '@/features/lotting/EditableCandidateCard';
import { compressForVision } from '@/lib/image-compress';
import {
  CAMERA_PHOTO_FORMAT_FILTERS,
  CAPTURE_MAX_PHOTO_PX,
  compressForVisionSequential,
  logPhotoCapture,
  photoFormatFitsCap,
  selectLargestPhotoFormatAtOrUnderCap,
} from '@/lib/photo-capture-config';
import { bumpAutoRetryCount, canAutoRetryAi, resetAutoRetryCount } from '@/lib/ai-auto-retry';

const { width: SCREEN_W } = Dimensions.get('window');

/**
 * A draft that already points at a created lot is a recovery record: the lot
 * exists on the server and the draft may be the only pointer to photos that
 * never reached the durable queue. It must not expire with the ordinary
 * in-progress window (RED TEAM #683 HIGH).
 */
function isCreatedLotDraft(draft: { created?: unknown } | null | undefined): boolean {
  return Boolean(draft?.created);
}

type PhotoDraft = {
  hero: LocalPhoto | null;
  conditionPhotos: LocalPhoto[];
  editable: EditableCandidate;
  created?: { lotId: string; lotCode: string } | null;
  operatorId?: string;
};

// ── State machine ────────────────────────────────────────────────────────────
//
// phase transitions:
//   camera ─(shutter)→ camera (with hero set + AI in flight; can keep tapping)
//          ─(AI ok)──→ review
//          ─(AI fail)→ camera (banner stays until retry/discard)
//   review ─(save ok)→ done
//          ─(save fail)→ review (banner)
//   done   ─(scan another)→ camera (fresh)
//
// We deliberately don't have a "scanning" phase distinct from "camera"
// because the operator should keep using the camera while the AI runs.

type Phase = 'camera' | 'review' | 'creating' | 'done' | 'pallet-review' | 'pallet-done';

type LocalPhoto = {
  uri: string;
  width?: number;
  height?: number;
  fileSizeBytes?: number;
  formatPhoto?: { width: number; height: number };
};

// Pallet mode (P1/P5): one shelfScan candidate plus the operator's
// review state. `selected` drives whether we batch-create it; low-confidence
// candidates default to UNSELECTED so the operator must explicitly opt in
// (confidence gating, P5). `result` is filled after batch create.
type PalletRow = {
  candidate: LotCandidate;
  selected: boolean;
  result: { status: 'pending' | 'creating' | 'ok' | 'error'; lotCode?: string; error?: string };
};

export default function AiPhotoScanScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const role = useOperatorRole();
  const { session } = useLottingSession();
  const { mode: lottingMode } = useLottingMode();
  // Pre-stickered Flow B: once the lot row exists (post createDraftLot),
  // open a sub-modal scanner to capture the sticker UUID. Driven by
  // setPendingSticker — the underlying camera pauses (isActive=false)
  // while the modal is up to avoid double-camera flicker.
  const [pendingSticker, setPendingSticker] = useState<{ lotId: string; lotCode: string } | null>(
    null,
  );
  // Sticker before save (2026-10-05): capture first, bind right after the save.
  const [captureSticker, setCaptureSticker] = useState(false);
  const capturedStickerRef = useRef<string | null>(null);
  // The lot whose done screen is up, for a background bind answering late.
  const createdLotIdRef = useRef<string | null>(null);

  // Black-screen fix (staff report 2026-07-29) — same defect quick.tsx fixed on
  // 07-17, which was never carried across to this screen. Pausing via isActive
  // is not enough on its own: clearing pendingSticker re-activates this camera
  // in the SAME commit the modal's AVCaptureSession is still tearing down, and
  // iOS cannot run two sessions at once, so the preview comes up BLACK and only
  // a force-close clears it. Hold re-activation for a short settle window so
  // the outgoing session fully releases first.
  //
  // This is the highest-traffic lotting path (AI photo identify), which is why
  // staff kept hitting it after the quick.tsx fix appeared to resolve things.
  const CAMERA_SETTLE_MS = 500;
  const [cameraSettling, setCameraSettling] = useState(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beginCameraSettle = useCallback(() => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    setCameraSettling(true);
    settleTimerRef.current = setTimeout(() => {
      setCameraSettling(false);
      settleTimerRef.current = null;
    }, CAMERA_SETTLE_MS);
  }, []);
  useEffect(
    () => () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    },
    [],
  );

  const { hasPermission, requestPermission } = useCameraPermission();
  // Battery (recap 2026-07-08): stop the camera when this screen is
  // behind another route or the app is backgrounded.
  const cameraGate = useCameraGate();
  const cameraRef = useRef<Camera>(null);
  // useCameraDevice returns null until the lens enumerates; the Camera
  // render below renders a spinner while device is null.
  const device = useBackCamera();
  const formatFromHook = useCameraFormat(device, CAMERA_PHOTO_FORMAT_FILTERS);
  const cameraFormat = useMemo(() => {
    const formats = device?.formats ?? [];
    const strict = selectLargestPhotoFormatAtOrUnderCap(formats, CAPTURE_MAX_PHOTO_PX);
    if (strict) return strict;
    if (formatFromHook && photoFormatFitsCap(formatFromHook, CAPTURE_MAX_PHOTO_PX)) {
      return formatFromHook;
    }
    return undefined;
  }, [device?.formats, formatFromHook]);
  // Tap-to-focus: yellow square fades in at the tap point + AE/AF/AWB
  // metering re-converges there. Apple-Camera-style affordance.
  const focus = useTapToFocus(cameraRef);

  const [phase, setPhase] = useState<Phase>('camera');

  // Hero photo: the one we send to AI. First shutter tap on a fresh
  // screen becomes the hero; subsequent taps become conditionPhotos.
  const [hero, setHero] = useState<LocalPhoto | null>(null);
  const [conditionPhotos, setConditionPhotos] = useState<LocalPhoto[]>([]);

  // AI state. We track the in-flight scan by ref so we can ignore
  // results from a previous attempt if the operator discards & restarts.
  const aiRunIdRef = useRef(0);
  const aiAutoRetryRef = useRef(0);
  const heroUriForAutoRetryRef = useRef<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<LotCandidate | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  // Editable mirror of aiResult — every field on the review screen is
  // editable so the operator can correct AI errors (e.g. "Idumor"→"DuMOR"
  // on a stylized brand misread) BEFORE the lot saves. The save handler
  // uses `editable` (not aiResult) so corrections persist.
  const [editable, setEditable] = useState<EditableCandidate | null>(null);

  // 2026-08-15/17 (staff reports): AI mode loses the whole item when the app
  // is backgrounded — going to Amazon for a stock photo, or just tapping the
  // BinGo button top-left to come back. Staff report: "it took me 6 times to list a
  // steam cleaner."
  //
  // This screen is the heaviest in the app — live camera, captured bitmaps and
  // AI results all resident — so it is the first thing Android reclaims. #271
  // added draft persistence to Quick Lot; this is the same hook on the screen
  // the pickers are actually using.
  //
  // Only the REVIEW state is persisted, deliberately. Restoring a half-finished
  // camera phase would drop someone into a UI that does not match what they
  // remember doing; restoring the filled-in form is unambiguous and is the part
  // that represents typing they would otherwise redo. Photo URIs are local
  // files that outlive the process, so they restore by reference.
  // Outcome of the photo upload step on save. Surfaced on the done
  // screen so the operator knows whether their hero/conditions
  // actually landed on the lot (vs being silently dropped on upload
  // failure). Also tracks stock count so we can say "AI found 0 stock
  // images" explicitly instead of just rendering an empty section.
  type PhotoOutcome = {
    heroOk: boolean;
    conditionsAttempted: number;
    conditionsOk: number;
    stockCount: number;
    // Supplementary photos (edited stock + card-added shots) that failed to
    // upload — e.g. an RLS-rejected lot-photos path. Surfaced so a silent
    // drop never reads as a clean success.
    stockDropped: number;
    remaining: number;
  };
  const [photoOutcome, setPhotoOutcome] = useState<PhotoOutcome | null>(null);
  const [created, setCreated] = useState<{ lotId: string; lotCode: string } | null>(null);

  // Photos that never entered the durable queue (admission failed). Counted
  // apart from the queue so an empty queue cannot be mistaken for completion.
  const [unresolvedPhotos, setUnresolvedPhotos] = useState(0);
  const unresolvedPhotosRef = useRef(0);
  // The never-queued entries themselves, so the done screen can offer a retry
  // instead of hiding them behind the queue count (RED TEAM #683 MEDIUM).
  const unresolvedItemsRef = useRef<LotPhotoInput[]>([]);
  const [retryingPhotos, setRetryingPhotos] = useState(false);
  // True once every photo has been offered to the queue. Before that, a queue
  // count of zero says nothing about this save.
  const queueSettledRef = useRef(false);
  // The operator who captured the photos in the draft. Recovery refuses to
  // upload under anyone else's namespace (RED TEAM #683 HIGH).
  const draftOperatorIdRef = useRef<string | null>(null);

  const setUnresolved = useCallback((count: number) => {
    unresolvedPhotosRef.current = count;
    setUnresolvedPhotos(count);
  }, []);

  const setUnresolvedPhotoList = useCallback((photos: LotPhotoInput[]) => {
    unresolvedItemsRef.current = photos;
  }, []);

  const draftStore = useDraftPersistence<PhotoDraft>('photo', {
    retainStale: isCreatedLotDraft,
  });
  const draftOffered = useRef(false);
  // Retry counter for a transient storage read failure. The write gate stays
  // closed until a read actually succeeds, so the saved lot cannot be erased
  // while storage is briefly unavailable (RED TEAM #683 HIGH).
  const [draftReadAttempt, setDraftReadAttempt] = useState(0);
  const draftRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The persisted-draft writer starts closed. On mount the screen is empty
  // (phase 'camera'), so the keep-effect below would write null and, after
  // the 800ms debounce, delete a saved draft before this screen has even read
  // it. That erased a created lot's recovery record whenever sign-in was slow,
  // and it also defeated the owner-mismatch promise by deleting the draft the
  // screen had just refused to touch (RED TEAM #683 HIGH). Stay closed until
  // the load decision says it is safe, and stay closed while a draft is
  // deliberately preserved.
  const [draftGate, setDraftGate] = useState<DraftWriteGate>('loading');
  // A blocked foreign/legacy archive can be dismissed with "Not now"; the
  // choice then stays available in a persistent banner for the rest of the
  // mount instead of trapping the operator with capture disabled (#752).
  const [blockedSkip, setBlockedSkip] = useState<BlockedSkipFlow>({ kind: 'none' });
  const roleRef = useRef(role);
  const mountedRef = useRef(true);

  // The archive itself is never resolved, rewritten or deleted; only the
  // screen's own writer opens for independent work. This is the exact
  // production composition the blocked-skip tests drive (RED TEAM #762).
  const blockedSkipScreen = useMemo(
    () =>
      createBlockedSkipScreen({
        setFlow: setBlockedSkip,
        setGate: setDraftGate,
        present: (alert) => {
          Alert.alert(alert.title, alert.message, alert.buttons, alert.options);
        },
      }),
    [],
  );

  const showBlockedSkipAlert = useCallback(
    (reason: BlockedSkipReason) => {
      blockedSkipScreen.alertFor(reason);
    },
    [blockedSkipScreen],
  );

  const blockedSkipBanner = blockedSkipScreen.bannerFor(blockedSkip);

  /**
   * Clear the draft only when every photo was offered to the queue, none was
   * rejected, and the durable queue for this lot is empty. A zero count on its
   * own is not proof: it can be read before enqueue writes, and rejected
   * photos are not in the queue at all (RED TEAM #683 HIGH).
   */
  const completeIfAttached = useCallback(
    (lotId: string | null | undefined) => {
      if (!lotId || !queueSettledRef.current || unresolvedPhotosRef.current > 0) return;
      void photoQueueCountSafe(lotId).then((count) => {
        if (count === 0 && unresolvedPhotosRef.current === 0) {
          draftStore.clear();
          // The lot is fully attached; there is nothing left to recover.
          void photoRecovery.discard(lotId);
        }
      });
    },
    [draftStore],
  );

  /**
   * Offer the photos that never reached the queue again. Without this the done
   * screen only counted the durable queue, so a rejected photo disappeared from
   * the "still waiting" line even though its file is still only on the device
   * (RED TEAM #683 MEDIUM).
   */
  const retryUnresolvedPhotos = useCallback(async () => {
    const lot = created;
    const operatorId = draftOperatorIdRef.current;
    const photos = unresolvedItemsRef.current;
    if (!lot || !operatorId || photos.length === 0 || retryingPhotos) return;
    setRetryingPhotos(true);
    try {
      const outcome = await queueAndDrainLotPhotos({
        lotId: lot.lotId,
        lotCode: lot.lotCode,
        operatorId,
        photos,
        remoteStockCount: photoOutcome?.stockCount ?? 0,
      });
      if (!mountedRef.current) return;
      // The retry only covers the never-queued photos, so its outcome is
      // additive: keep the hero/conditions that already attached on the first
      // pass instead of resetting the "N of M attached" line.
      setPhotoOutcome((prev) =>
        prev
          ? {
              heroOk: prev.heroOk || outcome.heroOk,
              conditionsAttempted: prev.conditionsAttempted,
              conditionsOk: prev.conditionsOk + outcome.conditionsOk,
              stockCount: outcome.stockCount,
              stockDropped: outcome.stockDropped,
              remaining: outcome.remaining,
            }
          : outcome,
      );
      setPhotosWaiting(outcome.remaining);
      photosWaitingRef.current = outcome.remaining;
      setUnresolved(outcome.unresolved);
      setUnresolvedPhotoList(outcome.unresolvedPhotos);
      queueSettledRef.current = true;
      completeIfAttached(lot.lotId);
    } catch (err) {
      if (mountedRef.current) {
        Alert.alert(
          'Retry failed',
          (err as Error).message ||
            'Those photos still could not be queued. Use “Add more photos to this lot” to take them again.',
        );
      }
    } finally {
      if (mountedRef.current) setRetryingPhotos(false);
    }
  }, [
    created,
    photoOutcome,
    retryingPhotos,
    setUnresolved,
    setUnresolvedPhotoList,
    completeIfAttached,
  ]);

  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (draftRetryTimer.current) clearTimeout(draftRetryTimer.current);
    },
    [],
  );

  useEffect(() => {
    // Only touch storage once the saved draft has been read and the screen is
    // allowed to write. Before that, a save(null) would delete the very draft
    // we are about to recover.
    if (!mayWriteDraft(draftGate)) return;
    // Keep the draft while the lot is being created AND while photos upload.
    // Clearing at 'creating' was the bug: a kill during the upload left no
    // draft, so the picker had to start over. A done lot stays in the draft
    // only while its photo queue still has entries or a photo was never
    // accepted by the queue.
    const keep =
      (phase === 'review' ||
        phase === 'creating' ||
        (phase === 'done' && (photosWaitingRef.current > 0 || unresolvedPhotosRef.current > 0))) &&
      editable;
    draftStore.save(
      keep
        ? {
            hero,
            conditionPhotos,
            editable,
            created,
            operatorId: draftOperatorIdRef.current ?? undefined,
          }
        : null,
    );
  }, [phase, hero, conditionPhotos, editable, created, draftStore, unresolvedPhotos, draftGate]);

  // While a saved lot's photos are draining, keep the pending count and the
  // draft in sync with the queue itself. Clearing only when the enqueue step
  // settled AND every photo was accepted AND the queue is empty: a zero count
  // read before enqueue finishes (or after admission failed) used to clear the
  // draft and delete its local files (RED TEAM #683 HIGH).
  useEffect(() => {
    const lotId = created?.lotId;
    if (!lotId) return;
    let cancelled = false;
    const finishIfComplete = () => {
      if (!queueSettledRef.current) return;
      if (unresolvedPhotosRef.current > 0) return;
      void photoQueueCountSafe(lotId).then((count) => {
        if (cancelled || count !== 0) return;
        if (unresolvedPhotosRef.current > 0) return;
        draftStore.clear();
        void photoRecovery.discard(lotId);
      });
    };
    const sync = () => {
      void photoQueueCountSafe(lotId).then((count) => {
        if (cancelled || count === null) return;
        setPhotosWaiting(count);
        photosWaitingRef.current = count;
        if (count === 0) finishIfComplete();
      });
    };
    sync();
    const unsubscribe = subscribePhotoQueue(sync);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [created?.lotId, draftStore]);

  useEffect(() => {
    if (draftOffered.current) return;
    let cancelled = false;
    let started = false;
    (async () => {
      const result = await draftStore.loadDraft();
      if (cancelled) return;
      if (result.status === 'unavailable') {
        // Storage is transiently unreadable. Do NOT open the writer: its
        // mount-time save(null) would delete the saved lot. Retry shortly.
        if (draftRetryTimer.current) clearTimeout(draftRetryTimer.current);
        draftRetryTimer.current = setTimeout(() => {
          draftRetryTimer.current = null;
          if (mountedRef.current) setDraftReadAttempt((n) => n + 1);
        }, 1000);
        return;
      }
      if (draftRetryTimer.current) {
        clearTimeout(draftRetryTimer.current);
        draftRetryTimer.current = null;
      }
      let saved: PhotoDraft | null = result.status === 'draft' ? result.draft : null;
      // Where the blocked record came from decides whether it can be skipped
      // without deleting it (RED TEAM #747).
      let savedSource: BlockedDraftSource = 'main';
      if (!saved) {
        // "Scan another item" archives a created lot whose photos were still
        // unresolved. Offer that record when the ordinary draft is empty so
        // the next item cannot bury the previous one (RED TEAM #683 HIGH).
        // Prefer this operator's records: a newer foreign record must not hide
        // an older one they can still recover (RED TEAM #683 MEDIUM).
        //
        // A transient archive-read failure is not "no recovery". Retry with
        // capped backoff while this mount is alive; otherwise a single bad
        // read would latch recovery off until a remount (RED TEAM #683 MEDIUM
        // follow-up, #743).
        const currentRole = roleRef.current;
        const recoveryRead = await photoRecovery.readLatestFor<PhotoDraft>(
          currentRole.kind === 'staff' ? currentRole.operatorId : undefined,
          () => !cancelled && mountedRef.current,
        );
        if (cancelled || !recoveryRead) return;
        if (recoveryRead.status === 'ok' && recoveryRead.record) {
          saved = recoveryRead.record.draft;
          savedSource = 'recovery';
        }
      }
      if (saved) {
        // A scan that started before the stored draft was read must not land
        // on top of the restored item (RED TEAM #744 HIGH). Bumping the run
        // id discards any in-flight result, and clearing the busy flag keeps
        // the screen usable after we take ownership of its state.
        aiRunIdRef.current += 1;
        setAiBusy(false);
      }
      const decision = decideDraftRecovery(saved, roleRef.current);
      if (decision.action === 'none') {
        draftOffered.current = true;
        setDraftGate(gateAfterDraftLoad(decision));
        return;
      }
      // Role is still loading (or refreshing): leave the draft untouched so
      // this effect runs again once the role resolves.
      if (decision.action === 'wait') return;

      // A persisted draft can be reopened on a tablet now signed in as a
      // different operator. Uploading then would put the previous operator's
      // photos in this operator's namespace, so do not touch the draft at all
      // (RED TEAM #683 HIGH).
      if (decision.action === 'blocked') {
        draftOffered.current = true;
        setDraftGate(gateAfterDraftLoad(decision));
        // A blocked archive must not disable capture forever. Offer an explicit
        // skip that opens the writer for independent work without resolving,
        // rewriting or deleting the foreign/ownerless record (RED TEAM #747).
        // "Not now" moves the choice to a persistent banner so it stays
        // reachable in this mount (RED TEAM #752).
        // A blocked main draft cannot be skipped: opening the writer would
        // clear the record we just refused to touch.
        const skipFlow = blockedSkipFlowFor(decision, savedSource);
        if (skipFlow.kind === 'prompt') {
          setBlockedSkip(skipFlow);
          showBlockedSkipAlert(skipFlow.reason);
        } else {
          Alert.alert('Saved lot belongs to another sign-in', blockedSkipMessage(decision.reason));
        }
        return;
      }

      // A draft with `created` means the lot row already exists. Do NOT
      // create it again: reopen the done screen and finish the queued photos.
      if (decision.action === 'finish') {
        if (!saved || !saved.created) {
          draftOffered.current = true;
          return;
        }
        const operatorId = decision.operatorId;
        started = true;
        draftOffered.current = true;
        setDraftGate(gateAfterDraftLoad(decision));
        draftOperatorIdRef.current = operatorId;
        queueSettledRef.current = false;
        setUnresolved(0);
        setUnresolvedPhotoList([]);
        setHero(saved.hero);
        setConditionPhotos(saved.conditionPhotos ?? []);
        setEditable(saved.editable);
        setCreated(saved.created);
        createdLotIdRef.current = saved.created.lotId;
        setPhase('creating');
        Alert.alert(
          'Finishing your saved lot',
          `Lot ${saved.created.lotCode} was saved. I’m finishing the photos now.`,
        );
        try {
          const photos: LotPhotoInput[] = [];
          // Stock first so the clean product shot stays the primary image.
          for (const uri of saved.editable.stockPhotos)
            if (isLocalPhotoUri(uri)) photos.push({ kind: 'stock', uri });
          if (saved.hero) photos.push({ kind: 'hero', uri: saved.hero.uri });
          for (const photo of saved.conditionPhotos ?? [])
            photos.push({ kind: 'condition', uri: photo.uri });
          const outcome = await queueAndDrainLotPhotos({
            lotId: saved.created.lotId,
            lotCode: saved.created.lotCode,
            operatorId,
            photos,
            remoteStockCount: saved.editable.stockPhotos.filter((uri) => !isLocalPhotoUri(uri))
              .length,
          });
          // A role refresh reruns this effect; it must not cancel a recovery
          // that already started. Only an unmount should stop it.
          if (!mountedRef.current) return;
          setPhotoOutcome(outcome);
          setPhotosWaiting(outcome.remaining);
          photosWaitingRef.current = outcome.remaining;
          setUnresolved(outcome.unresolved);
          setUnresolvedPhotoList(outcome.unresolvedPhotos);
          queueSettledRef.current = true;
          setPhase('done');
          completeIfAttached(saved.created.lotId);
          void Haptics.notificationAsync(
            outcome.remaining === 0
              ? Haptics.NotificationFeedbackType.Success
              : Haptics.NotificationFeedbackType.Warning,
          );
        } catch (err) {
          if (!mountedRef.current) return;
          setCreateError((err as Error).message);
          setPhase('review');
        }
        return;
      }

      draftOffered.current = true;
      started = true;
      setDraftGate(gateAfterDraftLoad(decision));
      if (!saved) return;
      Alert.alert(
        'Unfinished item restored',
        `Picked up where you left off on "${saved.editable.title || 'this item'}". Your photos and details are still here.`,
        [
          {
            text: 'Start fresh',
            style: 'destructive',
            onPress: () => {
              setDraftGate('open');
              draftStore.clear();
              setPhase('camera');
              setHero(null);
              setConditionPhotos([]);
              setEditable(null);
            },
          },
          // Offered right here because this alert only appears after the app
          // died mid-item — the exact moment someone knows what they were
          // doing when it happened, and the moment they are most willing to
          // say so. Asking later gets a text message instead of a report.
          {
            text: 'Report it',
            onPress: () => {
              setDraftGate('open');
              setHero(saved.hero);
              setConditionPhotos(saved.conditionPhotos ?? []);
              setEditable(saved.editable);
              setPhase('review');
              router.push('/feedback?from=/lotting/photo' as Href);
            },
          },
          {
            text: 'Keep',
            onPress: () => {
              setDraftGate('open');
              setHero(saved.hero);
              setConditionPhotos(saved.conditionPhotos ?? []);
              setEditable(saved.editable);
              setPhase('review');
            },
          },
        ],
      );
    })();
    return () => {
      // Only cancel before the recovery has been claimed. A role refresh
      // reruns this effect; once started, the in-flight completion must still
      // apply its result.
      if (!started) cancelled = true;
    };
  }, [
    draftStore,
    router,
    role,
    completeIfAttached,
    setUnresolved,
    setUnresolvedPhotoList,
    draftReadAttempt,
    showBlockedSkipAlert,
  ]);

  // Staff report 2026-07-10 (PNK-485-969-5 "lot never saved"): this screen's
  // "Try web lookup" used to open web.tsx in its legacy CREATE mode — which
  // minted a SEPARATE stray lot with its own sticker prompt, while the AI
  // candidate here sat unsaved. Now the card opens web.tsx in mode=enrich
  // (see onWebLookupEnrich below) and this focus hook merges the returned
  // fields into the in-progress candidate — one item, one lot. Mirrors
  // quick.tsx's consumption; read-and-clear so a stale payload never
  // re-applies.
  useFocusEffect(
    useCallback(() => {
      const payload = enrichReturnRef.current;
      if (!payload) return;
      enrichReturnRef.current = null;
      setEditable((prev) => {
        if (!prev) return prev;
        const scraped = [...(payload.photoUrl ? [payload.photoUrl] : []), ...payload.extraPhotoUrls]
          .map((u) => u.trim())
          .filter(Boolean);
        const existing = prev.stockPhotos.filter((u) => !scraped.includes(u));
        return {
          ...prev,
          title: payload.title || prev.title,
          msrpDollars: payload.msrpDollars || prev.msrpDollars,
          description: payload.description || prev.description,
          condition: payload.condition || prev.condition,
          stockPhotos: [...scraped, ...existing],
        };
      });
    }, []),
  );

  // Multi-candidate scan (Jared recap 2026-07-07): when the AI is unsure
  // (lookalike retail boxes) it returns up to 4 alternates alongside the
  // best guess. scanChoices = [primary, ...alternates]; the review screen
  // shows a picker when there's more than one, and choosing an entry
  // re-seeds aiResult + editable. Overwritten by every new scan.
  const [scanChoices, setScanChoices] = useState<LotCandidate[]>([]);
  const [choiceIndex, setChoiceIndex] = useState(0);
  // Lazy-enrich (2026-07-13): alternates come back vision-only (no prices /
  // photos / MSRP). Rather than eagerly enriching all Top-3 at scan time
  // (~3x cost + slower scan), we enrich the one the reviewer taps, on demand.
  // enrichingIdx drives a small "Fetching details…" spinner on the card;
  // selectedChoiceRef guards against a stale enrich landing after the reviewer
  // has moved on to a different candidate.
  const [enrichingIdx, setEnrichingIdx] = useState<number | null>(null);
  // Surfaced enrichment outcome for the CURRENTLY-selected choice. Before
  // 2026-07-14 the background enrich swallowed every failure and the "no
  // catalog match" 404 silently, so a scan that came back vision-only showed
  // an empty card forever with no price/photo, no error, no retry (field
  // report: "said to wait 5-8s but nothing happens"). We now track the outcome
  // so the review card can show a live "finding…" state and a retry / manual
  // path on failure. 'nomatch' = catalog genuinely had nothing; 'error' =
  // request failed (network / 5xx) and retrying may work.
  const [enrichStatus, setEnrichStatus] = useState<'idle' | 'nomatch' | 'error'>('idle');
  const selectedChoiceRef = useRef(0);

  // Fetch a candidate's price/photo/MSRP detail on demand and merge it in.
  // Used both when the reviewer taps an alternate AND right after a fast scan
  // to fill the primary (the scan defers the slow web passes — 2026-07-13).
  // No-ops if the candidate is already enriched. Guarded against a stale
  // response landing after the reviewer moved to a different candidate.
  const enrichChoiceInBackground = useCallback(
    (candidate: LotCandidate, index: number) => {
      const needsEnrich =
        candidate.prices.length === 0 &&
        candidate.stockPhotos.length === 0 &&
        candidate.msrp == null;
      if (!needsEnrich) return;

      setEnrichingIdx(index);
      if (selectedChoiceRef.current === index) setEnrichStatus('idle');
      void (async () => {
        try {
          const enriched = await enrichCandidate(candidate);
          if (selectedChoiceRef.current !== index) return;
          if (!enriched) {
            // 404 no_match — the catalog genuinely had nothing and no stock
            // image could be gap-filled. Not an error to retry; tell the
            // reviewer so they enter price/photo manually (or Web lookup).
            setEnrichStatus('nomatch');
            return;
          }
          setEnrichStatus('idle');
          // Cache back into scanChoices so re-selecting doesn't re-enrich.
          setScanChoices((prev) => {
            if (prev[index] !== candidate) return prev; // replaced by a new scan
            const next = [...prev];
            next[index] = enriched;
            return next;
          });
          setAiResult(enriched);
          setEditable(
            candidateToEditable(enriched, {
              defaultCondition: session.defaultCondition,
              defaultStartBid: session.defaultStartBid,
            }),
          );
        } catch {
          // Network / 5xx — retrying may work. Surface it instead of leaving a
          // silent empty card (field report 2026-07-14).
          if (selectedChoiceRef.current === index) setEnrichStatus('error');
        } finally {
          if (selectedChoiceRef.current === index) setEnrichingIdx(null);
        }
      })();
    },
    [session.defaultCondition, session.defaultStartBid],
  );

  // Retry enrichment for the currently-selected choice (from the review-card
  // banner). Re-runs the same on-demand fill; no-ops if it already succeeded.
  const retryEnrich = useCallback(() => {
    const idx = selectedChoiceRef.current;
    const candidate = scanChoices[idx];
    if (candidate) enrichChoiceInBackground(candidate, idx);
  }, [scanChoices, enrichChoiceInBackground]);

  const pickScanChoice = useCallback(
    (i: number) => {
      const chosen = scanChoices[i];
      if (!chosen || i === choiceIndex) return;
      selectedChoiceRef.current = i;
      setChoiceIndex(i);
      setEnrichStatus('idle');
      setAiResult(chosen);
      setEditable(
        candidateToEditable(chosen, {
          defaultCondition: session.defaultCondition,
          defaultStartBid: session.defaultStartBid,
        }),
      );
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      enrichChoiceInBackground(chosen, i);
    },
    [
      scanChoices,
      choiceIndex,
      session.defaultCondition,
      session.defaultStartBid,
      enrichChoiceInBackground,
    ],
  );

  // ── Pallet / multi-item mode (P1 + P5) ──────────────────────────────────────
  // Default OFF → the screen behaves exactly as before (single-product
  // scanPhoto). When ON, the hero capture routes to shelfScan, which returns
  // 1-20 LotCandidates; the operator reviews + batch-creates a lot per
  // selected candidate. Disabled while a scan/create is in flight so the
  // operator can't flip the mode mid-run and desync the result UI.
  const [palletMode, setPalletMode] = useState(false);
  const [palletRows, setPalletRows] = useState<PalletRow[]>([]);
  const [palletBusy, setPalletBusy] = useState(false);
  const [palletError, setPalletError] = useState<string | null>(null);
  const [palletCreating, setPalletCreating] = useState(false);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [photosWaiting, setPhotosWaiting] = useState(0);
  const photosWaitingRef = useRef(0);

  // Photo viewer overlay. Tapping any thumbnail (confirm phase or review
  // phase) opens this with the full combined photo list, so swipe-through
  // works between hero / condition / stock photos.
  const photoViewer = usePhotoViewer();

  // Camera flash mode. Default 'auto' so the camera does the right thing
  // in mixed lighting (warehouse fluorescents + box shadows). Operator
  // can tap to cycle off → on → auto from the viewfinder.
  const [flashMode, setFlashMode] = useState<FlashMode>('auto');

  // Mutex on the shutter button so a frantic-tapper can't enqueue 5
  // simultaneous takePictureAsync calls.
  const shutterLockRef = useRef(false);

  // When AI completes successfully, auto-advance the operator from
  // the camera to the review screen. We only do this once per run so
  // a user who deliberately stayed on the camera after the AI returned
  // doesn't get yanked away when they come back.
  const advancedOnAiRef = useRef(false);

  // Forward ref to startPalletScan (declared below). onShutter is defined
  // before startPalletScan, so it invokes it through this ref to avoid a
  // use-before-declaration cycle. Kept current by the effect after the
  // startPalletScan definition.
  const startPalletScanRef = useRef<(photo: LocalPhoto) => void>(() => {});

  // ── Shutter handler ────────────────────────────────────────────────────────

  const onShutter = useCallback(async () => {
    if (shutterLockRef.current) return;
    // While the stored draft is still being read (or a recovery is being
    // offered), a capture could not be persisted and could be overwritten by
    // the older record when storage recovers (RED TEAM #744 HIGH).
    if (!mayStartNewItem(draftGate)) return;
    if (!cameraRef.current) return;
    shutterLockRef.current = true;
    try {
      // vision-camera v4: takePhoto returns { path } (no scheme) — we
      // prefix file:// to match every other URI in the app. flash and
      // quality opts merged from TAKE_PHOTO_OPTIONS (speed-prioritized).
      const photo = await cameraRef.current.takePhoto({
        flash: safeFlash(device, flashMode),
        ...TAKE_PHOTO_OPTIONS,
      });
      const uri = `file://${photo.path}`;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      let fileSizeBytes: number | undefined;
      try {
        const info = await FileSystem.getInfoAsync(uri);
        if (info.exists && 'size' in info && typeof info.size === 'number') {
          fileSizeBytes = info.size;
        }
      } catch {
        // Best-effort — logging still works without byte count.
      }

      const formatPhoto = cameraFormat
        ? { width: cameraFormat.photoWidth, height: cameraFormat.photoHeight }
        : undefined;
      const persisted = await persistPhoto(uri);
      const captured: LocalPhoto = {
        uri: persisted,
        width: photo.width,
        height: photo.height,
        fileSizeBytes,
        formatPhoto,
      };

      if (palletMode) {
        // Multi-item path: this single frame IS the pallet shot. Set it as
        // the hero (so the thumbnail strip + cleanup logic still work) and
        // run a multi-SKU shelf scan. We don't accumulate condition photos
        // in pallet mode — each detected SKU becomes its own lot.
        setHero(captured);
        setConditionPhotos([]);
        setPalletError(null);
        setPalletRows([]);
        startPalletScanRef.current(captured);
        return;
      }

      if (!hero) {
        // First photo of the run becomes hero + kicks off AI with that
        // single image.
        setHero(captured);
        setAiError(null);
        setAiResult(null);
        setEditable(null);
        startAiScan([captured]);
      } else {
        // Subsequent photos accumulate as condition shots AND re-trigger
        // the AI scan with up to 3 most-recent photos (hero + 2 latest
        // condition shots). The existing runId pattern in startAiScan
        // supersedes any in-flight scan, so we don't waste tokens — the
        // operator just gets the richest available multi-angle pass.
        // Beyond 3, additional condition photos go into the lot but
        // don't participate in scan (server caps anyway).
        setConditionPhotos((prev) => {
          const next = [...prev, captured];
          const aiBatch = [hero, ...next.slice(-2)].slice(0, 3);
          startAiScan(aiBatch);
          return next;
        });
      }
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Photo capture failed', translateCaptureError(err));
    } finally {
      shutterLockRef.current = false;
    }
    // `hero` is in closure but setHero updates synchronously enough
    // that double-tap-into-different-states is acceptable for v1.
  }, [hero, flashMode, device, palletMode, cameraFormat, draftGate]);

  // ── Background AI scan ────────────────────────────────────────────────────

  const startAiScan = useCallback(
    (photos: LocalPhoto[]) => {
      // AI key validation happens server-side at /api/lottr/scan-photo;
      // the proxy returns 503 if OPENROUTER_API_KEY isn't set. The
      // catch-block below surfaces that to the operator.
      // Stamp a run id; if a later run starts, this one ignores its
      // own result. Prevents stale results from clobbering a fresh hero
      // — also lets onShutter re-trigger scans with newer multi-image
      // batches without racing.
      aiRunIdRef.current += 1;
      const runId = aiRunIdRef.current;
      setAiBusy(true);
      advancedOnAiRef.current = false;

      // Cap to 3 (defense in depth — server also caps, but bailing here
      // avoids compressing photos we're about to throw away).
      const cappedPhotos = photos.slice(0, 3);

      (async () => {
        try {
          const images = await compressForVisionSequential(
            cappedPhotos.map((p) => ({
              uri: p.uri,
              width: p.width,
              height: p.height,
              captureLog: {
                formatPhoto: p.formatPhoto,
                fileSizeBytes: p.fileSizeBytes,
                takenPhoto: { width: p.width ?? 0, height: p.height ?? 0 },
              },
            })),
            compressForVision,
          );
          const candidate = await scanPhoto(images);
          if (aiRunIdRef.current !== runId) return; // superseded
          if (!candidate) {
            setAiError("AI couldn't identify the item. Try a clearer angle, then tap Retry.");
            setAiResult(null);
            setEditable(null);
          } else {
            setAiError(null);
            setAiResult(candidate);
            // Multi-candidate picker source: best guess first, then any
            // alternates the vision step flagged for an ambiguous photo.
            setScanChoices([candidate, ...(candidate.alternates ?? [])]);
            setChoiceIndex(0);
            selectedChoiceRef.current = 0;
            setEnrichingIdx(null);
            setEnrichStatus('idle');
            // Seed the editable mirror so the operator can correct AI
            // errors before saving (brand misreads on stylized logos,
            // wrong category guesses, etc.). Session defaults handle
            // condition fallback when AI returns an invalid enum value.
            setEditable(
              candidateToEditable(candidate, {
                defaultCondition: session.defaultCondition,
                defaultStartBid: session.defaultStartBid,
              }),
            );
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            // The scan now returns fast, deferring the slow price/photo web
            // passes (2026-07-13). Fill the primary's detail in the background
            // so the reviewer sees the card immediately, then prices/photos
            // populate a moment later. No-ops when the scan already cache-hit.
            enrichChoiceInBackground(candidate, 0);
          }
        } catch (err) {
          if (aiRunIdRef.current !== runId) return;
          // iOS suspends fetches when the app backgrounds, which surfaces
          // here as "Network request failed". Translate the common cases
          // to a friendlier message so the operator knows what to do.
          const raw = (err as Error).message;
          const friendly = /network request failed|fetch failed|abort/i.test(raw)
            ? 'Lookup interrupted (was the app in the background?). Tap Retry.'
            : raw;
          setAiError(friendly);
          setAiResult(null);
          setEditable(null);
        } finally {
          if (aiRunIdRef.current === runId) setAiBusy(false);
        }
      })();
    },
    [enrichChoiceInBackground],
  );

  // ── Pallet / multi-item scan (P1) ──────────────────────────────────────────
  // Runs shelfScan (Sonnet, multi-SKU) on a SINGLE captured frame and lands
  // the operator on the pallet-review screen with one selectable row per
  // detected SKU. shelfScan takes one base64 (not the multi-image batch the
  // single-product path builds) — a pallet shot is one wide frame, and the
  // server route only accepts { base64, mediaType }.
  //
  // Confidence gating (P5): low-confidence candidates start UNSELECTED so the
  // operator must explicitly opt in before they're created; high/medium start
  // selected. Reuses the aiRunIdRef stamp so a superseding scan (operator
  // re-shoots) discards the stale result.
  const startPalletScan = useCallback((photo: LocalPhoto) => {
    aiRunIdRef.current += 1;
    const runId = aiRunIdRef.current;
    setPalletBusy(true);
    setPalletError(null);
    setPalletRows([]);

    (async () => {
      try {
        const compressT0 = Date.now();
        const palletDims =
          photo.width != null &&
          photo.height != null &&
          Number.isFinite(photo.width) &&
          Number.isFinite(photo.height)
            ? { width: photo.width, height: photo.height }
            : undefined;
        const b64 = await compressForVision(photo.uri, palletDims);
        logPhotoCapture({
          formatPhoto: photo.formatPhoto,
          takenPhoto: {
            width: photo.width ?? 0,
            height: photo.height ?? 0,
          },
          fileSizeBytes: photo.fileSizeBytes,
          compressDurationMs: Date.now() - compressT0,
        });
        if (!b64) throw new Error('Photo compression returned empty data');
        const candidates = await shelfScan(b64, 'image/jpeg');
        if (aiRunIdRef.current !== runId) return; // superseded
        if (!candidates || candidates.length === 0) {
          setPalletError(
            "AI didn't detect any items on this pallet. Try a wider, well-lit shot, then tap Retry.",
          );
          setPalletRows([]);
        } else {
          setPalletError(null);
          setPalletRows(
            candidates.map((candidate) => ({
              candidate,
              // P5: low confidence requires explicit confirmation → off by default.
              selected: candidate.confidence !== 'low',
              result: { status: 'pending' as const },
            })),
          );
          setPhase('pallet-review');
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      } catch (err) {
        if (aiRunIdRef.current !== runId) return;
        const raw = (err as Error).message;
        const friendly = /network request failed|fetch failed|abort/i.test(raw)
          ? 'Lookup interrupted (was the app in the background?). Tap Retry.'
          : raw;
        setPalletError(friendly);
        setPalletRows([]);
      } finally {
        if (aiRunIdRef.current === runId) setPalletBusy(false);
      }
    })();
  }, []);

  // Light haptic when AI returns so the operator notices without
  // being yanked off the camera. DO NOT auto-advance — the whole point
  // of the redesign was "take more photos while the AI is working."
  // Auto-advance defeated that: by the time the operator looked back
  // at the screen, they were already on the review and their only
  // captured photo was the hero (which until this commit didn't even
  // get uploaded). The "Review →" button next to the shutter is the
  // explicit hand-off — the operator decides when they're done
  // shooting and ready to confirm.
  useEffect(() => {
    if (aiResult && phase === 'camera' && !advancedOnAiRef.current) {
      advancedOnAiRef.current = true;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, [aiResult, phase]);

  // ── Back-nav guard while reviewing an AI scan ────────────────────────────
  // Reported (2026-05-11): operator was reviewing an AI scan, tapped
  // the back/LotTR header button thinking it would go back to the edit
  // screen, and lost the entire scan — re-shooting from scratch is
  // ~30s + $0.005-0.01 wasted. Guard: in the 'review' phase, prompt
  // before leaving. Operator can dismiss (keep editing) or confirm
  // (discard).
  //
  // Two listeners cover all back paths:
  //   - navigation.beforeRemove → fires on header back, gesture, route
  //     pop, deep-link replace, etc.
  //   - BackHandler.addEventListener('hardwareBackPress') → fires on
  //     the Android system back button, which beforeRemove sometimes
  //     misses on older expo-router versions.
  useEffect(() => {
    const isDirty = phase === 'review' && aiResult !== null;
    if (!isDirty) return;

    const confirmDiscard = (onConfirm: () => void): void => {
      Alert.alert(
        'Discard scan?',
        'Your AI scan and edits will be lost. The next scan will run a fresh AI call.',
        [
          { text: 'Keep editing', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: onConfirm },
        ],
      );
    };

    // expo-router exposes the underlying React Navigation object via
    // useNavigation. addListener returns an unsubscribe fn.
    const unsubRemove = (
      navigation as unknown as {
        addListener: (
          evt: 'beforeRemove',
          cb: (e: { preventDefault: () => void; data: { action: unknown } }) => void,
        ) => () => void;
        dispatch: (action: unknown) => void;
      }
    ).addListener('beforeRemove', (e) => {
      e.preventDefault();
      confirmDiscard(() => {
        (navigation as unknown as { dispatch: (a: unknown) => void }).dispatch(e.data.action);
      });
    });

    const onBack = (): boolean => {
      confirmDiscard(() => {
        // Defer back nav until after the Alert closes so it dismisses cleanly.
        setTimeout(() => router.back(), 0);
      });
      return true; // we've handled the back press
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);

    return () => {
      unsubRemove();
      sub.remove();
    };
  }, [phase, aiResult, navigation, router]);

  // ── Photo manipulation ─────────────────────────────────────────────────────

  const removeConditionPhoto = useCallback((index: number) => {
    setConditionPhotos((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const retakeHero = useCallback(() => {
    // Operator wants to redo the AI scan from a different angle.
    setHero(null);
    setAiResult(null);
    setEditable(null);
    setAiError(null);
    setAiBusy(false);
    aiRunIdRef.current += 1; // invalidate any in-flight scan
    advancedOnAiRef.current = false;
    setPhase('camera');
  }, []);

  const retryAi = useCallback(() => {
    if (!hero) return;
    setAiError(null);
    setAiResult(null);
    setEditable(null);
    // Replay with whatever the operator's actually shot — hero plus up
    // to two most-recent condition photos. Matches the batch shape the
    // shutter handler builds, so a retry uses the same multi-angle
    // context as the original scan.
    const batch = [hero, ...conditionPhotos.slice(-2)].slice(0, 3);
    startAiScan(batch);
  }, [hero, conditionPhotos, startAiScan]);

  const retryAiManual = useCallback(() => {
    aiAutoRetryRef.current = resetAutoRetryCount();
    retryAi();
  }, [retryAi]);

  useEffect(() => {
    if (!hero?.uri) return;
    if (heroUriForAutoRetryRef.current !== hero.uri) {
      heroUriForAutoRetryRef.current = hero.uri;
      aiAutoRetryRef.current = resetAutoRetryCount();
    }
  }, [hero?.uri]);

  // iOS suspends in-flight fetches when the app backgrounds, so a scan
  // started before the operator switched apps comes back as a "Network
  // request failed" error when they return. User reported (2026-05-13):
  // "I switched to another app mid AI lookup on iOS and it failed when
  // I went back, pressed retry and it worked."
  //
  // Listen for active-on-resume transitions; if we have a hero + error
  // + no in-flight scan, auto-retry. The hero photo is what makes the
  // retry actionable — without one there's nothing to scan.
  //
  // Tracks prev state in a ref so we only fire on background→active,
  // not on the initial mount's first 'active' event.
  const prevAppStateRef = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    function onChange(next: AppStateStatus): void {
      const prev = prevAppStateRef.current;
      prevAppStateRef.current = next;
      if (next === 'active' && prev !== 'active' && hero && aiError && !aiBusy) {
        if (canAutoRetryAi(aiAutoRetryRef.current)) {
          aiAutoRetryRef.current = bumpAutoRetryCount(aiAutoRetryRef.current);
          retryAi();
        }
      }
    }
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [hero, aiError, aiBusy, retryAi]);

  const discardAll = useCallback(async () => {
    // The lot exists and some photos never reached the queue. Its draft is the
    // only pointer to those files, so copy it aside before the screen resets.
    // Otherwise "Scan another item" deleted lot A's recovery record and the
    // operator could never get those photos back (RED TEAM #683 HIGH).
    //
    // Wait for the archive to be accepted before resetting: a fire-and-forget
    // write that failed, or a kill while it was pending, would let the reset
    // (and its draft cleanup) erase the only copy. On failure leave the item
    // open so the main draft still holds it.
    if (
      created?.lotId &&
      editable &&
      (unresolvedPhotosRef.current > 0 || photosWaitingRef.current > 0)
    ) {
      const archived = await photoRecovery.preserve(created.lotId, {
        hero,
        conditionPhotos,
        editable,
        created,
        operatorId: draftOperatorIdRef.current ?? undefined,
      });
      if (!archived) {
        Alert.alert(
          'Could not save this item for later',
          'Storage did not accept the recovery copy, so I left this item open instead of losing its photos. Free some space and try "Scan another item" again.',
        );
        return;
      }
    }
    setHero(null);
    setConditionPhotos([]);
    setAiResult(null);
    setEditable(null);
    setAiError(null);
    setAiBusy(false);
    aiRunIdRef.current += 1;
    advancedOnAiRef.current = false;
    setCreated(null);
    createdLotIdRef.current = null;
    setCreateError(null);
    // Reset pallet-mode state too (keep the palletMode toggle itself so a
    // "Scan another pallet" loop stays in pallet mode).
    setPalletRows([]);
    setPalletError(null);
    setPalletBusy(false);
    setPalletCreating(false);
    setPhase('camera');
  }, [created, editable, hero, conditionPhotos]);

  // Keep the forward ref pointed at the latest startPalletScan so onShutter
  // (declared above startPalletScan) can invoke it safely.
  useEffect(() => {
    startPalletScanRef.current = startPalletScan;
  }, [startPalletScan]);

  // Retry a failed pallet scan from the current hero frame.
  const retryPalletScan = useCallback(() => {
    if (!hero) return;
    startPalletScan(hero);
  }, [hero, startPalletScan]);

  // Toggle a single pallet row's selection (P5 operator confirmation).
  const togglePalletRow = useCallback((index: number) => {
    setPalletRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, selected: !row.selected } : row)),
    );
  }, []);

  // ── Save ───────────────────────────────────────────────────────────────────

  const saveLot = useCallback(async () => {
    if (!aiResult || !editable || creating) return;
    // Effective operator id for this save. saveLot genuinely needs an
    // operatorId, so on a transient role downgrade (token refresh / network
    // blip) we silently re-resolve it instead of blocking with the modal.
    let operatorId = role.kind === 'staff' ? role.operatorId : null;
    if (operatorId === null) {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user?.id;
      if (!userId) {
        Alert.alert(
          'Not signed in as staff',
          'Sign out and back in to refresh your operator role.',
        );
        return;
      }
      const { data: staffRow } = await supabase
        .from('operator_users')
        .select('operator_id')
        .eq('user_id', userId)
        .maybeSingle();
      const resolvedOperatorId =
        staffRow && typeof staffRow.operator_id === 'string' ? staffRow.operator_id : null;
      if (resolvedOperatorId === null) {
        Alert.alert(
          'Not signed in as staff',
          'Sign out and back in to refresh your operator role.',
        );
        return;
      }
      operatorId = resolvedOperatorId;
    }
    // Sticker before save: Pre-stickered mode scans first, then saves.
    const stickerPlan = planStickerBeforeSave({
      mode: lottingMode,
      capturedSticker: capturedStickerRef.current,
    });
    if (stickerPlan.action === 'scan_first') {
      setCaptureSticker(true);
      return;
    }
    const stickerToBind = stickerPlan.sticker ?? '';
    capturedStickerRef.current = null;
    draftOperatorIdRef.current = operatorId;
    queueSettledRef.current = false;
    setUnresolved(0);
    setUnresolvedPhotoList([]);
    setCreating(true);
    setCreateError(null);
    setPhase('creating');
    try {
      // Convert the operator-edited card back into a LotCandidate so
      // any in-place corrections (e.g. brand misread "Idumor" → "DuMOR"
      // on a stylized logo, wrong category, MSRP override) land on the
      // saved lot. Structured ID fields not exposed in the card flow back
      // via aiResult.
      //
      // D4: stockPhotos come from editableToCandidate(editable) — the
      // operator's EDITED list (stock images they kept + any card-added
      // shots) — NOT the raw aiResult.stockPhotos, so removals stick. Any
      // file:// in there is dropped by filterSafeImageUrls at this initial
      // write and then uploaded + re-attached by the Step-3 patch below.
      const candidateForSave: LotCandidate = {
        ...editableToCandidate(editable),
        prices: aiResult.prices,
        avg: aiResult.avg,
        fullTitle: editable.title.trim() || aiResult.fullTitle,
        // Preserve the AI-extracted identifiers operators don't typically
        // re-type. EditableCandidate exposes UPC only; ASIN / FNSKU / LPN
        // come from the original scan.
        asin: aiResult.asin,
        fnsku: aiResult.fnsku,
        lpn: aiResult.lpn,
      };
      const out = await createDraftLotFromCandidate(supabase, {
        candidate: candidateForSave,
        operatorId,
        source: activeLotSource(session) || null,
        vendor: session.defaultVendor || null,
      });
      if (!out.ok) {
        // Plain cause + server text; the failure is also recorded server-side.
        reportNonFatal(lotCreateFailureReport(out, { screen: '/lotting/photo', lottingMode }));
        throw new Error(lotCreateUserMessage(out).message);
      }

      // The lot now exists. Persist its identity BEFORE the first photo
      // starts uploading. If the app dies from here on, the draft says
      // "this item already has a lot" and reopens into resume mode instead
      // of creating a second lot.
      const savedLot = { lotId: out.lotId, lotCode: out.lotCode };
      setCreated(savedLot);
      createdLotIdRef.current = savedLot.lotId;
      draftStore.save({
        hero,
        conditionPhotos,
        editable,
        created: savedLot,
        operatorId,
      });
      draftStore.flush();

      // Step 2: queue every local photo (hero, conditions, local stock) and
      // drain once. The queue copies nothing here — capture already persisted
      // the files into Documents — but it does persist the lot id/code and
      // the upload/patch state in AsyncStorage. A kill during upload resumes
      // on the next launch instead of losing the item.
      const remoteStockCount = editable.stockPhotos.filter((uri) => !isLocalPhotoUri(uri)).length;
      const photos: LotPhotoInput[] = [];
      // Stock first so the clean product shot stays the primary image.
      for (const uri of editable.stockPhotos) {
        if (isLocalPhotoUri(uri)) photos.push({ kind: 'stock', uri });
      }
      if (hero) photos.push({ kind: 'hero', uri: hero.uri });
      for (const p of conditionPhotos) photos.push({ kind: 'condition', uri: p.uri });
      const outcome = await queueAndDrainLotPhotos({
        lotId: out.lotId,
        lotCode: out.lotCode,
        operatorId,
        photos,
        remoteStockCount,
      });
      setPhotoOutcome(outcome);
      setPhotosWaiting(outcome.remaining);
      photosWaitingRef.current = outcome.remaining;
      setUnresolved(outcome.unresolved);
      setUnresolvedPhotoList(outcome.unresolvedPhotos);
      queueSettledRef.current = true;
      completeIfAttached(out.lotId);

      // Save-now + enrich (2026-07-15 owner update): staff should no longer
      // wait at the review card for the slow price lookup (Google Shopping
      // stalls/blocks). If the lot was saved before the background price enrich
      // landed — no prices AND no MSRP on the saved candidate — fill the MSRP
      // in AFTER the lot is committed. Fully guarded + best-effort: a failure
      // never touches the already-saved lot, and the `.is('msrp_cents', null)`
      // write-guard means an operator-typed MSRP is never clobbered. Photos are
      // intentionally left to the existing enrichment drain (which vision-
      // verifies the hero, #192/#195) so this can't reintroduce a wrong hero.
      if (aiResult.prices.length === 0 && aiResult.msrp == null) {
        void (async () => {
          try {
            const enriched = await enrichCandidate(candidateForSave);
            if (!enriched || enriched.msrp == null) return;
            await supabase
              .from('lots')
              .update({ msrp_cents: Math.round(enriched.msrp * 100) })
              .eq('id', out.lotId)
              .eq('operator_id', operatorId)
              .is('msrp_cents', null);
          } catch {
            /* best-effort — the lot is already committed */
          }
        })();
      }

      setPhase('done');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Flow B: open the sticker scanner overlay on top of the done
      // screen for any non-"generate" mode. The lot is committed with its
      // auto-generated qr_token already; PreStickeredScanner routes the
      // scanned value (UUID → claim_prestickered_qr; any other code →
      // claim_sticker_code). If they cancel, no harm — the lot keeps its
      // auto-gen token and they can use /api/lots/qr-sheet later.
      if (lottingMode !== 'generate') {
        // Sticker before save: bind the one scanned first. If that bind is
        // refused (already on another lot, etc.) or a manager saved without
        // one, fall back to the scanner over the done screen as before.
        // NOT awaited (2026-10-08): `creating` (and with it the shutter, the
        // mode toggle and the next save) used to wait on this request with no
        // limit. Time-boxed; a network failure is retried in the background.
        if (stickerToBind) {
          const { lotId: boundLotId, lotCode: boundLotCode } = out;
          void bindStickerAfterSave({
            lotId: boundLotId,
            lotCode: boundLotCode,
            sticker: stickerToBind,
          }).then((outcome) => {
            if (outcome.kind !== 'refused') return;
            const stillOnThisLot = createdLotIdRef.current === boundLotId;
            Alert.alert(
              'Sticker not bound',
              `${stickerRefusalCopy(outcome.reason)}\n\nLot ${boundLotCode} was created, but the sticker is NOT attached yet. ${
                stillOnThisLot
                  ? 'Scan a sticker to finish.'
                  : `Open ${boundLotCode} in Inventory and scan a sticker.`
              }`,
            );
            // Only over this lot's done screen: a pendingSticker left set in
            // the camera phase would pause the camera with no modal on top.
            if (stillOnThisLot) setPendingSticker({ lotId: boundLotId, lotCode: boundLotCode });
          });
        } else {
          setPendingSticker({ lotId: out.lotId, lotCode: out.lotCode });
        }
      }
    } catch (err) {
      setCreateError((err as Error).message);
      setPhase('review');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setCreating(false);
    }
  }, [
    aiResult,
    editable,
    conditionPhotos,
    creating,
    role,
    session,
    hero,
    lottingMode,
    completeIfAttached,
    setUnresolved,
    setUnresolvedPhotoList,
    draftStore,
  ]);

  // ── Batch create from a pallet scan (P1 + P5) ───────────────────────────────
  // Creates one draft lot per SELECTED candidate via the SAME
  // createDraftLotFromCandidate helper the single-item save uses — no new
  // persistence path. Low-confidence rows are only created if the operator
  // explicitly checked them (selection defaults off for low). The pallet
  // hero photo is uploaded onto each created lot (first slot) with the
  // candidate's stock images appended, mirroring saveLot's photo ordering.
  const createPalletLots = useCallback(async () => {
    if (palletCreating) return;
    const selectedIdx = palletRows
      .map((r, i) => (r.selected && r.result.status !== 'ok' ? i : -1))
      .filter((i) => i >= 0);
    if (selectedIdx.length === 0) {
      Alert.alert('Nothing selected', 'Select at least one item to create a lot for.');
      return;
    }

    // Resolve the operator id exactly as saveLot does (transient role
    // downgrade re-resolve via operator_users).
    let operatorId = role.kind === 'staff' ? role.operatorId : null;
    if (operatorId === null) {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user?.id;
      if (!userId) {
        Alert.alert(
          'Not signed in as staff',
          'Sign out and back in to refresh your operator role.',
        );
        return;
      }
      const { data: staffRow } = await supabase
        .from('operator_users')
        .select('operator_id')
        .eq('user_id', userId)
        .maybeSingle();
      const resolvedOperatorId =
        staffRow && typeof staffRow.operator_id === 'string' ? staffRow.operator_id : null;
      if (resolvedOperatorId === null) {
        Alert.alert(
          'Not signed in as staff',
          'Sign out and back in to refresh your operator role.',
        );
        return;
      }
      operatorId = resolvedOperatorId;
    }

    setPalletCreating(true);
    setPhase('creating');
    // Mark selected rows as creating.
    setPalletRows((prev) =>
      prev.map((r, i) => (selectedIdx.includes(i) ? { ...r, result: { status: 'creating' } } : r)),
    );

    // Create sequentially so we don't hammer the lot-code reservation RPC
    // with N parallel writes (each takes a code from the same sequence).
    for (const i of selectedIdx) {
      const row = palletRows[i];
      if (!row) continue;
      const { candidate } = row;
      try {
        const out = await createDraftLotFromCandidate(supabase, {
          candidate,
          operatorId,
          source: activeLotSource(session) || null,
          vendor: session.defaultVendor || null,
        });
        if (!out.ok) {
          reportNonFatal(
            lotCreateFailureReport(out, { screen: '/lotting/photo#pallet', lottingMode }),
          );
          const msg = lotCreateUserMessage(out).message;
          setPalletRows((prev) =>
            prev.map((r, idx) =>
              idx === i ? { ...r, result: { status: 'error', error: msg } } : r,
            ),
          );
          continue;
        }

        // Attach the pallet hero photo (best-effort) + candidate stock photos.
        let userPhotoUrls: string[] = [];
        if (hero) {
          const up = await uploadLotPhotoPublic(operatorId, out.lotCode, hero.uri).catch(() => ({
            ok: false as const,
            reason: 'upload_threw',
          }));
          if (up.ok) userPhotoUrls = [up.url];
        }
        const stockUrls = candidate.stockPhotos ?? [];
        // Stock photo first = primary listing image (tester recap 2026-07-08).
        const finalUrls = [...stockUrls, ...userPhotoUrls];
        if (finalUrls.length > 0) {
          const { error: patchErr } = await supabase
            .from('lots')
            .update({ photo_urls: finalUrls })
            .eq('id', out.lotId)
            .eq('operator_id', operatorId);
          if (patchErr) {
            console.warn('[photo.tsx] pallet photo_urls patch failed', patchErr.message);
          }
        }

        setPalletRows((prev) =>
          prev.map((r, idx) =>
            idx === i ? { ...r, result: { status: 'ok', lotCode: out.lotCode } } : r,
          ),
        );
      } catch (err) {
        setPalletRows((prev) =>
          prev.map((r, idx) =>
            idx === i ? { ...r, result: { status: 'error', error: (err as Error).message } } : r,
          ),
        );
      }
    }

    setPalletCreating(false);
    setPhase('pallet-done');
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [palletCreating, palletRows, role, session, hero]);

  // Cleanup of any local temp files when the operator hits Done.
  // Best-effort — failures here don't matter.
  useEffect(() => {
    return () => {
      const uris = [hero?.uri, ...conditionPhotos.map((p) => p.uri)].filter((u): u is string =>
        Boolean(u && u.startsWith('file://')),
      );
      for (const uri of uris) {
        FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally only on unmount

  // ── Permission gate ────────────────────────────────────────────────────────

  if (!hasPermission) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, padding: 24, gap: 16 }}>
        <Text style={{ color: colors.text, fontSize: 16 }}>
          Camera access is required for AI photo scan.
        </Text>
        <Pressable
          onPress={requestPermission}
          style={{ padding: 16, backgroundColor: colors.primary, borderRadius: 12 }}
        >
          <Text style={{ color: '#000', textAlign: 'center', fontWeight: '900' }}>
            Allow camera
          </Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const totalPhotos = (hero ? 1 : 0) + conditionPhotos.length;

  // ── Camera phase ───────────────────────────────────────────────────────────

  if (phase === 'camera') {
    const cameraHeight = Math.round(SCREEN_W * 1.0);
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <LottingModeToggle disabled={aiBusy || creating || palletBusy} />
        <ScrollView contentContainerStyle={{ paddingBottom: 80 }}>
          {/* Multiple items / pallet toggle (P1). OFF = single-product
              scanPhoto (unchanged). ON = shelfScan multi-SKU detection.
              Locked while a scan/create is in flight. */}
          <View style={{ paddingHorizontal: 14, paddingTop: 12 }}>
            <Pressable
              onPress={() => {
                if (aiBusy || palletBusy || creating || palletCreating) return;
                if (!mayStartNewItem(draftGate)) return;
                setPalletMode((m) => !m);
              }}
              accessibilityRole="switch"
              accessibilityState={{
                checked: palletMode,
                disabled: aiBusy || palletBusy || !mayStartNewItem(draftGate),
              }}
              style={[s.palletToggle, palletMode && s.palletToggleOn]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[s.palletToggleTitle, palletMode && { color: colors.primary }]}>
                  {palletMode ? '☑ Multiple items / pallet' : '☐ Multiple items / pallet'}
                </Text>
                <Text style={s.palletToggleHint}>
                  {palletMode
                    ? 'One photo → AI detects every SKU on the pallet, you create a lot for each.'
                    : 'Off: single-product scan (one item per photo).'}
                </Text>
              </View>
            </Pressable>
          </View>
          <View style={{ padding: 14 }}>
            <Text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 18 }}>
              {!mayStartNewItem(draftGate)
                ? draftGate === 'loading'
                  ? 'Checking for a saved item first… capture is paused so nothing gets overwritten.'
                  : 'A saved item is waiting — answer the prompt before capturing a new one.'
                : palletMode
                  ? !hero
                    ? 'Tap the shutter once with the whole pallet/shelf in frame. AI detects every item.'
                    : palletBusy
                      ? 'Detecting items on the pallet…'
                      : palletError
                        ? 'No items detected. Tap Retry, or retake the shot.'
                        : 'Items detected — review them on the next screen.'
                  : !hero
                    ? 'Tap the shutter to capture the main shot. AI starts identifying immediately.'
                    : aiBusy
                      ? "Identifying… take condition photos while you wait — they'll be added to the listing."
                      : aiResult
                        ? 'AI found a match. Review on the next screen, or keep adding photos.'
                        : 'AI returned no match. Tap Retry, or retake the hero shot.'}
            </Text>
          </View>

          {/* Persistent reopen for a dismissed blocked-archive prompt. "Not
              now" must not be a dead end: the choice stays here until the
              operator resolves it or explicitly starts a new item (#752). */}
          {blockedSkip.kind === 'dismissed' && blockedSkipBanner && (
            <View style={s.blockedSkipBanner}>
              <Text style={s.blockedSkipTitle}>{BLOCKED_SKIP_TITLE}</Text>
              <Text style={s.blockedSkipText}>{blockedSkipMessage(blockedSkip.reason)}</Text>
              <View style={s.blockedSkipActions}>
                <Pressable
                  onPress={blockedSkipBanner.review}
                  style={[s.blockedSkipButton, { borderColor: colors.border }]}
                >
                  <Text style={s.blockedSkipButtonLabel}>Review saved item</Text>
                </Pressable>
                <Pressable
                  onPress={blockedSkipBanner.startNew}
                  style={[s.blockedSkipButton, { borderColor: colors.primary }]}
                >
                  <Text style={[s.blockedSkipButtonLabel, { color: colors.primary }]}>
                    Start a new item
                  </Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* Camera viewfinder */}
          <View
            style={{
              height: cameraHeight,
              marginHorizontal: 14,
              borderRadius: 14,
              overflow: 'hidden',
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            {device ? (
              <Camera
                ref={cameraRef}
                style={{ flex: 1 }}
                device={device}
                {...(cameraFormat ? { format: cameraFormat } : {})}
                photoQualityBalance="speed"
                // Pause when the pre-stickered scanner modal is up so its
                // own Camera instance gets the hardware. Two simultaneously
                // active cameras blacks out the foreground modal on iOS.
                // cameraSettling keeps us paused for a beat AFTER the modal
                // closes too — see the settle comment above.
                isActive={cameraGate && phase === 'camera' && !pendingSticker && !cameraSettling}
                photo={true}
              />
            ) : (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator color={colors.primary} />
              </View>
            )}
            {/* Tap-to-focus overlay — fills the camera area, rendered BEFORE
                 the flash button so the button hit-tests first. Taps that
                 miss the button fall through to the focus handler. */}
            <Pressable style={StyleSheet.absoluteFillObject} onPress={focus.onTap} />
            <CameraFlashButton
              type="photo"
              mode={flashMode}
              onChange={setFlashMode}
              device={device}
            />
            {focus.indicator}

            {/* AI status pill. In pallet mode it reflects the shelf-scan
                lifecycle (busy / detected / no-match) rather than the
                single-product scan. */}
            {(palletMode
              ? palletBusy || palletRows.length > 0 || palletError
              : aiBusy || aiResult || aiError) && (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  top: 10,
                  left: 10,
                  right: 10,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: 8,
                  borderRadius: 8,
                  backgroundColor: (palletMode ? palletError : aiError)
                    ? 'rgba(239,68,68,0.92)'
                    : (palletMode ? palletRows.length > 0 : aiResult)
                      ? 'rgba(34,197,94,0.92)'
                      : 'rgba(255,122,0,0.92)',
                }}
              >
                {(palletMode ? palletBusy : aiBusy) && <ActivityIndicator color="#000" />}
                <Text style={{ color: '#000', fontWeight: '900', fontSize: 12 }}>
                  {palletMode
                    ? palletBusy
                      ? 'Detecting items…'
                      : palletRows.length > 0
                        ? `✓ ${palletRows.length} item${palletRows.length === 1 ? '' : 's'} detected`
                        : '✗ No items detected'
                    : aiBusy
                      ? 'AI working…'
                      : aiResult
                        ? '✓ AI found a match'
                        : '✗ AI no match'}
                </Text>
              </View>
            )}
          </View>

          {/* Shutter */}
          <View style={{ flexDirection: 'row', padding: 14, gap: 10 }}>
            <Pressable
              onPress={onShutter}
              disabled={(palletMode && palletBusy) || !mayStartNewItem(draftGate)}
              style={{
                flex: 2,
                padding: 18,
                backgroundColor:
                  (palletMode && palletBusy) || !mayStartNewItem(draftGate)
                    ? colors.surfaceHi
                    : colors.primary,
                borderRadius: 14,
              }}
            >
              <Text style={{ color: '#000', textAlign: 'center', fontWeight: '900', fontSize: 15 }}>
                {!mayStartNewItem(draftGate)
                  ? draftGate === 'loading'
                    ? 'Checking saved item…'
                    : 'Saved item waiting'
                  : palletMode
                    ? hero
                      ? '⊙ Retake pallet photo'
                      : '⊙ Capture pallet photo'
                    : !hero
                      ? '⊙ Capture hero photo'
                      : '⊙ Capture condition photo'}
              </Text>
            </Pressable>
            {palletMode
              ? palletRows.length > 0 && (
                  <Pressable
                    onPress={() => setPhase('pallet-review')}
                    style={{
                      flex: 1,
                      padding: 18,
                      backgroundColor: colors.success,
                      borderRadius: 14,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text
                      style={{
                        color: '#000',
                        textAlign: 'center',
                        fontWeight: '900',
                        fontSize: 13,
                      }}
                    >
                      Review →
                    </Text>
                  </Pressable>
                )
              : (aiResult || aiError) && (
                  <Pressable
                    onPress={() => setPhase('review')}
                    style={{
                      flex: 1,
                      padding: 18,
                      backgroundColor: colors.success,
                      borderRadius: 14,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text
                      style={{
                        color: '#000',
                        textAlign: 'center',
                        fontWeight: '900',
                        fontSize: 13,
                      }}
                    >
                      Review →
                    </Text>
                  </Pressable>
                )}
          </View>

          {/* AI error banner with retry actions (single-product mode) */}
          {!palletMode && aiError && !aiBusy && (
            <View
              style={[
                s.banner,
                { borderColor: colors.danger, backgroundColor: 'rgba(239,68,68,0.1)' },
              ]}
            >
              <Text style={{ color: colors.danger, fontWeight: '800', fontSize: 13 }}>
                {aiError}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <Pressable onPress={retryAiManual} style={s.bannerBtn}>
                  <Text style={s.bannerBtnText}>🔁 Retry AI</Text>
                </Pressable>
                <Pressable onPress={retakeHero} style={s.bannerBtn}>
                  <Text style={s.bannerBtnText}>📷 Retake hero</Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* Pallet scan error banner with retry actions */}
          {palletMode && palletError && !palletBusy && (
            <View
              style={[
                s.banner,
                { borderColor: colors.danger, backgroundColor: 'rgba(239,68,68,0.1)' },
              ]}
            >
              <Text style={{ color: colors.danger, fontWeight: '800', fontSize: 13 }}>
                {palletError}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <Pressable onPress={retryPalletScan} style={s.bannerBtn}>
                  <Text style={s.bannerBtnText}>🔁 Retry scan</Text>
                </Pressable>
                <Pressable onPress={retakeHero} style={s.bannerBtn}>
                  <Text style={s.bannerBtnText}>📷 Retake photo</Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* Thumbnail strip — hero + condition photos */}
          {totalPhotos > 0 && (
            <View style={{ paddingHorizontal: 14, marginTop: 6 }}>
              <Text style={s.stripLabel}>
                {totalPhotos} photo{totalPhotos === 1 ? '' : 's'} captured
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8 }}
              >
                {(() => {
                  const allUrls = [
                    ...(hero ? [hero.uri] : []),
                    ...conditionPhotos.map((p) => p.uri),
                  ];
                  return (
                    <>
                      {hero && (
                        <Pressable onPress={() => photoViewer.open(allUrls, 0)} style={s.thumbWrap}>
                          <Image source={{ uri: hero.uri }} style={s.thumb} contentFit="cover" />
                          <View style={s.thumbBadge}>
                            <Text style={s.thumbBadgeText}>HERO</Text>
                          </View>
                        </Pressable>
                      )}
                      {conditionPhotos.map((p, i) => {
                        const idx = (hero ? 1 : 0) + i;
                        return (
                          <Pressable
                            key={p.uri + i}
                            onPress={() => photoViewer.open(allUrls, idx)}
                            style={s.thumbWrap}
                          >
                            <Image source={{ uri: p.uri }} style={s.thumb} contentFit="cover" />
                            <Pressable
                              onPress={() => removeConditionPhoto(i)}
                              hitSlop={6}
                              style={s.thumbClear}
                            >
                              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>
                                ×
                              </Text>
                            </Pressable>
                          </Pressable>
                        );
                      })}
                    </>
                  );
                })()}
              </ScrollView>
            </View>
          )}

          {hero && (
            <View style={{ padding: 14, gap: 8 }}>
              <Pressable onPress={discardAll} style={s.ghostBtn}>
                <Text style={s.ghostBtnText}>Discard all photos & start over</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
        <PhotoViewer state={photoViewer.state} onClose={photoViewer.close} />
      </SafeAreaView>
    );
  }

  // ── Pallet review phase (P1 + P5) ───────────────────────────────────────────
  // Renders one selectable LotCandidateCard per detected SKU. Low-confidence
  // rows are flagged "Needs review" and start UNSELECTED so the operator
  // must explicitly check them before creation. The "creating" phase reuses
  // this view (with palletCreating true) so per-row spinners/results show
  // live during the batch create.
  if (phase === 'pallet-review' || (phase === 'creating' && palletCreating)) {
    const selectedCount = palletRows.filter((r) => r.selected && r.result.status !== 'ok').length;
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScrollView contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: 100 }}>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text
              style={{
                color: colors.primary,
                fontSize: 11,
                fontWeight: '900',
                letterSpacing: 1.2,
                textTransform: 'uppercase',
              }}
            >
              Pallet · {palletRows.length} item{palletRows.length === 1 ? '' : 's'}
            </Text>
            {!palletCreating && (
              <Pressable onPress={() => setPhase('camera')} style={s.smallGhost}>
                <Text style={s.smallGhostText}>← Camera</Text>
              </Pressable>
            )}
          </View>

          <Text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 18 }}>
            Each selected item becomes its own draft lot. Low-confidence items are unchecked by
            default — tap to confirm before creating.
          </Text>

          {palletRows.map((row, i) => {
            const isLow = row.candidate.confidence === 'low';
            const done = row.result.status === 'ok';
            const failed = row.result.status === 'error';
            const busy = row.result.status === 'creating';
            return (
              <View
                key={`${row.candidate.upc || row.candidate.title || 'item'}-${i}`}
                style={{ gap: 6 }}
              >
                {/* Selection / status header row */}
                <Pressable
                  onPress={() => {
                    if (palletCreating || done) return;
                    togglePalletRow(i);
                  }}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: row.selected, disabled: palletCreating || done }}
                  style={[
                    s.palletRowHeader,
                    row.selected &&
                      !done && {
                        borderColor: `${colors.primary}66`,
                        backgroundColor: colors.primaryDim,
                      },
                    done && { borderColor: colors.success, backgroundColor: colors.successDim },
                    failed && {
                      borderColor: colors.danger,
                      backgroundColor: 'rgba(239,68,68,0.1)',
                    },
                  ]}
                >
                  <Text style={{ fontSize: 16, marginRight: 8 }}>
                    {done ? '✓' : failed ? '✗' : row.selected ? '☑' : '☐'}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{ color: colors.text, fontSize: 14, fontWeight: '800' }}
                      numberOfLines={1}
                    >
                      {row.candidate.title || row.candidate.fullTitle || '(untitled item)'}
                    </Text>
                    <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>
                      {done
                        ? `Created ${row.result.lotCode}`
                        : failed
                          ? row.result.error || 'Create failed'
                          : busy
                            ? 'Creating…'
                            : `${row.candidate.confidence} confidence${isLow ? ' · needs review' : ''}`}
                    </Text>
                  </View>
                  {isLow && !done && !failed && (
                    <View style={s.reviewFlag}>
                      <Text style={s.reviewFlagText}>REVIEW</Text>
                    </View>
                  )}
                  {busy && <ActivityIndicator color={colors.primary} />}
                </Pressable>
                {/* Reuse the existing read-only candidate summary card. */}
                <LotCandidateCard candidate={row.candidate} />
              </View>
            );
          })}
        </ScrollView>

        {/* Bottom action bar */}
        <View style={s.palletBottomBar}>
          <Pressable
            onPress={createPalletLots}
            disabled={palletCreating || selectedCount === 0}
            style={{
              padding: 16,
              backgroundColor:
                palletCreating || selectedCount === 0 ? colors.surfaceHi : colors.success,
              borderRadius: 12,
            }}
          >
            {palletCreating ? (
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'center',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <ActivityIndicator color="#000" />
                <Text style={{ color: '#000', fontWeight: '900' }}>Creating lots…</Text>
              </View>
            ) : (
              <Text style={{ color: '#000', textAlign: 'center', fontWeight: '900', fontSize: 15 }}>
                {selectedCount === 0
                  ? 'Select items to create lots'
                  : `✓ Create ${selectedCount} lot${selectedCount === 1 ? '' : 's'}`}
              </Text>
            )}
          </Pressable>
          {!palletCreating && (
            <Pressable onPress={discardAll} style={s.ghostBtn}>
              <Text style={s.ghostBtnText}>Discard & start over</Text>
            </Pressable>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // ── Pallet done phase ────────────────────────────────────────────────────────
  if (phase === 'pallet-done') {
    const okRows = palletRows.filter((r) => r.result.status === 'ok');
    const failedRows = palletRows.filter((r) => r.result.status === 'error');
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScrollView contentContainerStyle={{ padding: 24, gap: 14 }}>
          <View
            style={{
              padding: 16,
              borderRadius: 12,
              backgroundColor: colors.successDim,
              borderWidth: 1,
              borderColor: colors.success,
            }}
          >
            <Text style={{ color: colors.success, fontWeight: '900', fontSize: 16 }}>
              Created {okRows.length} lot{okRows.length === 1 ? '' : 's'} from this pallet
            </Text>
            <Text style={{ color: colors.text, fontSize: 13, marginTop: 4 }}>
              {lottingMode === 'generate'
                ? 'Saved with auto-generated QR. Print labels from Inventory when ready.'
                : 'Pending intake. Walk them to a bin and run the picker intake scan.'}
            </Text>
          </View>

          {okRows.length > 0 && (
            <View style={{ gap: 6 }}>
              {okRows.map((r, i) => (
                <View
                  key={`${r.result.lotCode}-${i}`}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    padding: 10,
                    borderRadius: 8,
                    backgroundColor: colors.surface,
                    borderWidth: 1,
                    borderColor: colors.border,
                  }}
                >
                  <Text style={{ color: colors.success, fontSize: 14, marginRight: 8 }}>✓</Text>
                  <Text
                    style={{
                      color: colors.primary,
                      fontFamily: 'monospace',
                      fontSize: 13,
                      fontWeight: '900',
                      flex: 1,
                    }}
                  >
                    {r.result.lotCode}
                  </Text>
                  <Text style={{ color: colors.textMuted, fontSize: 12 }} numberOfLines={1}>
                    {r.candidate.title || '—'}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {failedRows.length > 0 && (
            <View
              style={{
                padding: 12,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.danger,
                backgroundColor: 'rgba(239,68,68,0.1)',
                gap: 4,
              }}
            >
              <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '800' }}>
                {failedRows.length} item{failedRows.length === 1 ? '' : 's'} failed to create
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 11 }}>
                Tap “Scan another pallet” to retry, or create them individually with single-item
                scan.
              </Text>
            </View>
          )}

          <Pressable
            onPress={discardAll}
            style={{ padding: 16, backgroundColor: colors.primary, borderRadius: 12 }}
          >
            <Text style={{ color: '#000', textAlign: 'center', fontWeight: '900' }}>
              📷 Scan another pallet
            </Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Review phase ───────────────────────────────────────────────────────────

  if (phase === 'review' || (phase === 'creating' && !palletCreating)) {
    const stockPhotos = (aiResult?.stockPhotos ?? []).filter((u) => u && u.trim().length > 0);
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        {captureSticker && (
          <PreStickeredScanner
            canSkip={role.kind === 'staff' && hasOperatorRole(role.role, 'manager')}
            onAssigned={() => {}}
            onCancel={() => {}}
            capture={{
              onCaptured: (sticker) => {
                capturedStickerRef.current = sticker;
                setCaptureSticker(false);
                setTimeout(() => void saveLot(), 0);
              },
              onAbort: () => {
                setCaptureSticker(false);
                Alert.alert(NO_STICKER_SCANNED_TITLE, NO_STICKER_SCANNED_MESSAGE);
              },
            }}
          />
        )}
        <ScrollView contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: 80 }}>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text
              style={{
                color: colors.primary,
                fontSize: 11,
                fontWeight: '900',
                letterSpacing: 1.2,
                textTransform: 'uppercase',
              }}
            >
              Review
            </Text>
            <Pressable onPress={() => setPhase('camera')} style={s.smallGhost}>
              <Text style={s.smallGhostText}>← Camera</Text>
            </Pressable>
          </View>

          <Text style={{ color: colors.text, fontSize: 20, fontWeight: '900' }}>
            {aiResult?.title || 'Untitled lot'}
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            {[aiResult?.brand, aiResult?.model].filter(Boolean).join(' · ') || ''}
          </Text>

          {/* Enrichment status banner (2026-07-14). The fast scan returns the
              match vision-only on a catalog miss and fills price/photos/MSRP
              afterward via /enrich-candidate. That fill used to be invisible
              on a single match and silent on failure, so staff saw an empty
              card and assumed it was broken. Now: a live "finding…" state
              while it runs, and a clear retry / manual path if it comes back
              empty. Save is never blocked — the drain backfills photos too. */}
          {enrichingIdx === choiceIndex ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                padding: 10,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: 'rgba(255,122,0,0.45)',
                backgroundColor: 'rgba(255,122,0,0.06)',
              }}
            >
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={{ color: colors.text, fontSize: 12, flex: 1 }}>
                Finding price &amp; photos… this can take up to a minute. You can Save now —
                they&apos;ll fill in automatically.
              </Text>
            </View>
          ) : enrichStatus === 'error' ? (
            <View
              style={{
                gap: 8,
                padding: 10,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.danger,
                backgroundColor: 'rgba(239,68,68,0.08)',
              }}
            >
              <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '700' }}>
                Couldn&apos;t fetch price &amp; photos. Check your connection and retry, or enter
                them below and Save.
              </Text>
              <Pressable onPress={retryEnrich} style={s.bannerBtn}>
                <Text style={s.bannerBtnText}>🔁 Retry</Text>
              </Pressable>
            </View>
          ) : enrichStatus === 'nomatch' ? (
            <View
              style={{
                gap: 8,
                padding: 10,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: 'rgba(245,158,11,0.45)',
                backgroundColor: 'rgba(245,158,11,0.06)',
              }}
            >
              <Text style={{ color: '#f59e0b', fontSize: 12, fontWeight: '700' }}>
                No catalog match — enter price &amp; photo below, or tap Web lookup. You can Save
                without them.
              </Text>
              <Pressable onPress={retryEnrich} style={s.bannerBtn}>
                <Text style={s.bannerBtnText}>🔁 Try again</Text>
              </Pressable>
            </View>
          ) : null}

          {/* Multi-candidate picker (2026-07-07): the AI flagged this photo
              as ambiguous and returned other plausible products. Tapping one
              swaps every field below (title, brand, category, …) — staff
              pick the right box variant instead of discarding a wrong single
              answer and rescanning. */}
          {scanChoices.length > 1 && (
            <View
              style={{
                gap: 6,
                padding: 10,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: 'rgba(245,158,11,0.45)',
                backgroundColor: 'rgba(245,158,11,0.06)',
              }}
            >
              <Text
                style={{
                  color: '#f59e0b',
                  fontSize: 11,
                  fontWeight: '900',
                  letterSpacing: 0.6,
                  textTransform: 'uppercase',
                }}
              >
                Not sure — {scanChoices.length} possible matches. Tap the right one:
              </Text>
              {scanChoices.map((c, i) => (
                <Pressable
                  key={`${i}-${c.title}`}
                  onPress={() => pickScanChoice(i)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    padding: 10,
                    borderRadius: 8,
                    borderWidth: 1.5,
                    borderColor: i === choiceIndex ? colors.primary : colors.border,
                    backgroundColor: i === choiceIndex ? 'rgba(255,122,0,0.12)' : colors.surface,
                  }}
                >
                  <Text style={{ fontSize: 14 }}>{i === choiceIndex ? '●' : '○'}</Text>
                  <View style={{ flex: 1 }}>
                    <Text
                      numberOfLines={2}
                      style={{
                        color: colors.text,
                        fontSize: 13,
                        fontWeight: i === choiceIndex ? '800' : '600',
                      }}
                    >
                      {c.title}
                    </Text>
                    <Text style={{ color: colors.textMuted, fontSize: 11 }}>
                      {[
                        i === 0 ? 'best guess' : `alternate ${i}`,
                        c.brand || null,
                        c.confidence || null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  {enrichingIdx === i && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                      <ActivityIndicator size="small" color={colors.primary} />
                      <Text style={{ color: colors.textMuted, fontSize: 10 }}>
                        Fetching details…
                      </Text>
                    </View>
                  )}
                </Pressable>
              ))}
            </View>
          )}

          {/* Thumbnails — condition shots first (operator's real
              photos win prominence), then AI's stock images. Match
              the order they'll be saved in lots.photo_urls. */}
          <View>
            <Text style={s.stripLabel}>Photos</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8 }}
            >
              {(() => {
                const reviewUrls = [
                  ...(hero ? [hero.uri] : []),
                  ...conditionPhotos.map((p) => p.uri),
                  ...stockPhotos,
                ];
                return (
                  <>
                    {hero && (
                      <Pressable
                        onPress={() => photoViewer.open(reviewUrls, 0)}
                        style={s.thumbWrap}
                      >
                        <Image source={{ uri: hero.uri }} style={s.thumb} contentFit="cover" />
                        <View style={[s.thumbBadge, { backgroundColor: colors.primary }]}>
                          <Text style={s.thumbBadgeText}>HERO</Text>
                        </View>
                      </Pressable>
                    )}
                    {conditionPhotos.map((p, i) => {
                      const idx = (hero ? 1 : 0) + i;
                      return (
                        <Pressable
                          key={p.uri + i}
                          onPress={() => photoViewer.open(reviewUrls, idx)}
                          style={s.thumbWrap}
                        >
                          <Image source={{ uri: p.uri }} style={s.thumb} contentFit="cover" />
                          <Pressable
                            onPress={() => removeConditionPhoto(i)}
                            hitSlop={6}
                            style={s.thumbClear}
                          >
                            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '900' }}>
                              ×
                            </Text>
                          </Pressable>
                          <View style={[s.thumbBadge, { backgroundColor: colors.success }]}>
                            <Text style={s.thumbBadgeText}>YOURS</Text>
                          </View>
                        </Pressable>
                      );
                    })}
                    {stockPhotos.map((url, i) => {
                      const idx = (hero ? 1 : 0) + conditionPhotos.length + i;
                      return (
                        <Pressable
                          key={url + i}
                          onPress={() => photoViewer.open(reviewUrls, idx)}
                          style={s.thumbWrap}
                        >
                          <Image source={{ uri: url }} style={s.thumb} contentFit="cover" />
                          <View style={[s.thumbBadge, { backgroundColor: colors.textMuted }]}>
                            <Text style={s.thumbBadgeText}>STOCK</Text>
                          </View>
                        </Pressable>
                      );
                    })}
                  </>
                );
              })()}
            </ScrollView>
            <Text style={{ color: colors.textDim, fontSize: 11, marginTop: 6 }}>
              Your photos save in front of stock images. Stock images come from retailer CDNs
              (Amazon / Walmart / Home Depot etc.) and are kept only with this lot — never reused
              for other lots.
            </Text>
          </View>

          {/* AI-filled fields — operator can edit ANY of them before
              save. User reported (2026-05-14): brand misread "DuMOR" →
              "Idumor" on a stylized logo, wants to correct in-line
              rather than save-then-edit-on-web. EditableCandidateCard
              is the same component QuickLot scan uses, so behavior /
              styling is consistent across flows. Backed by `editable`
              state seeded from aiResult when the AI returns. */}
          {editable && (
            <EditableCandidateCard
              value={editable}
              onChange={(patch) => setEditable((prev) => (prev ? { ...prev, ...patch } : prev))}
              onClearPhoto={(i) => {
                if (!editable) return;
                const updated = editable.stockPhotos.filter((_, idx) => idx !== i);
                setEditable({ ...editable, stockPhotos: updated });
              }}
              // 2026-07-10: enrich-in-place — WITHOUT this the card's web
              // lookup fell into its legacy branch and CREATED a stray lot
              // (own sticker prompt) while this AI candidate stayed unsaved.
              onWebLookupEnrich={() => {}}
            />
          )}
          {/* Identifier fields the editable card doesn't expose
              (ASIN / FNSKU / LPN, MSRP / Avg sold / Start bid summary).
              Still read-only here — operator-web's lot edit page covers
              full edits if any of these are wrong. Box MSRP dropped:
              packagingMsrp removed from prompt 2026-05-14 (Sonar handles
              MSRP). */}
          <View style={s.detailGroup}>
            <Detail label="ASIN" value={aiResult?.asin || '—'} />
            <Detail label="FNSKU" value={aiResult?.fnsku || '—'} />
            <Detail label="LPN" value={aiResult?.lpn || '—'} />
            <Detail
              label="Sonar MSRP"
              value={aiResult?.msrp != null ? `$${aiResult.msrp.toFixed(2)}` : '—'}
            />
            <Detail
              label="Avg sold"
              value={aiResult?.avg != null ? `$${aiResult.avg.toFixed(2)}` : '—'}
            />
          </View>

          {createError && (
            <View
              style={[
                s.banner,
                { borderColor: colors.danger, backgroundColor: 'rgba(239,68,68,0.1)' },
              ]}
            >
              <Text style={{ color: colors.danger, fontWeight: '800', fontSize: 13 }}>
                {createError}
              </Text>
            </View>
          )}

          {/* Explicit "no stock images" callout so the operator knows
              the AI didn't find any and decides whether to keep
              shooting condition photos before saving. Niche brands
              (e.g. Zens, smaller liquidation lots, used items) often
              return zero stock photos. */}
          {(aiResult?.stockPhotos ?? []).length === 0 && (
            <View
              style={{
                padding: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: 'rgba(245,158,11,0.5)',
                backgroundColor: 'rgba(245,158,11,0.12)',
              }}
            >
              <Text style={{ color: '#f59e0b', fontSize: 12, fontWeight: '700' }}>
                AI found no stock images for this product.
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 4 }}>
                {(hero ? 1 : 0) + conditionPhotos.length} of your photos will be the listing&apos;s
                only images. Tap &ldquo;← Camera&rdquo; to add more condition shots before saving.
              </Text>
            </View>
          )}

          <Pressable
            onPress={saveLot}
            disabled={creating}
            style={{
              padding: 16,
              backgroundColor: creating ? colors.surfaceHi : colors.success,
              borderRadius: 12,
            }}
          >
            {creating ? (
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'center',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <ActivityIndicator color="#000" />
                <Text style={{ color: '#000', fontWeight: '900' }}>
                  Saving{' '}
                  {(hero ? 1 : 0) + conditionPhotos.length > 0
                    ? `+ uploading ${(hero ? 1 : 0) + conditionPhotos.length} photo${(hero ? 1 : 0) + conditionPhotos.length === 1 ? '' : 's'}`
                    : ''}
                  …
                </Text>
              </View>
            ) : (
              <Text style={{ color: '#000', textAlign: 'center', fontWeight: '900', fontSize: 15 }}>
                ✓ Save as draft lot
              </Text>
            )}
          </Pressable>

          <Pressable onPress={discardAll} style={s.ghostBtn}>
            <Text style={s.ghostBtnText}>Discard & start over</Text>
          </Pressable>
        </ScrollView>
        <PhotoViewer state={photoViewer.state} onClose={photoViewer.close} />
      </SafeAreaView>
    );
  }

  // ── Done phase ─────────────────────────────────────────────────────────────

  if (phase === 'done' && created) {
    const totalAttempted = (hero ? 1 : 0) + conditionPhotos.length;
    const totalSaved = (photoOutcome?.heroOk ? 1 : 0) + (photoOutcome?.conditionsOk ?? 0);
    const totalDropped = totalAttempted - totalSaved;
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <ScrollView contentContainerStyle={{ padding: 24, gap: 14 }}>
          <View
            style={{
              padding: 16,
              borderRadius: 12,
              backgroundColor: colors.successDim,
              borderWidth: 1,
              borderColor: colors.success,
            }}
          >
            <Text style={{ color: colors.success, fontWeight: '900', fontSize: 16 }}>
              Saved as {created.lotCode}
            </Text>
            <Text style={{ color: colors.text, fontSize: 13, marginTop: 4 }}>
              {lottingMode === 'generate'
                ? `${created.lotCode} — saved with auto-generated QR. Print the label from Inventory → ${created.lotCode} when ready.`
                : 'Pending intake. Walk it to a bin and run the picker intake scan.'}
            </Text>
          </View>

          {photoOutcome && (
            <View
              style={{
                padding: 12,
                borderRadius: 10,
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.border,
                gap: 4,
              }}
            >
              <Text
                style={{
                  color: colors.textMuted,
                  fontSize: 11,
                  fontWeight: '800',
                  letterSpacing: 0.8,
                  textTransform: 'uppercase',
                }}
              >
                Photo outcome
              </Text>
              <Text style={{ color: colors.text, fontSize: 13, marginTop: 4 }}>
                ✓ {totalSaved} of {totalAttempted} of your photo{totalAttempted === 1 ? '' : 's'}{' '}
                attached
                {totalDropped > 0
                  ? ` (${totalDropped} failed to upload — retry from the lot detail)`
                  : ''}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                {photoOutcome.stockCount === 0
                  ? 'AI found 0 stock images. Your photos are the only ones on this lot.'
                  : `+ ${photoOutcome.stockCount} stock image${photoOutcome.stockCount === 1 ? '' : 's'} from AI`}
              </Text>
              {photoOutcome.stockDropped > 0 && (
                <Text style={{ color: colors.winning, fontSize: 12, fontWeight: '700' }}>
                  {photoOutcome.stockDropped} additional photo
                  {photoOutcome.stockDropped === 1 ? '' : 's'} couldn’t be uploaded and{' '}
                  {photoOutcome.stockDropped === 1 ? 'was' : 'were'} left off — retry from the lot
                  detail.
                </Text>
              )}
              {photosWaiting > 0 && (
                <Text style={{ color: colors.winning, fontSize: 12, fontWeight: '700' }}>
                  {photosWaiting} photo{photosWaiting === 1 ? '' : 's'} still waiting to upload.
                  Keep the app open, or reopen it — the saved lot resumes automatically.
                </Text>
              )}
              {unresolvedPhotos > 0 && (
                <>
                  <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '700' }}>
                    {unresolvedPhotos} photo{unresolvedPhotos === 1 ? '' : 's'} never reached the
                    upload queue and {unresolvedPhotos === 1 ? 'is' : 'are'} still only on this
                    device.
                  </Text>
                  <Pressable
                    onPress={() => void retryUnresolvedPhotos()}
                    disabled={retryingPhotos}
                    style={{
                      alignSelf: 'flex-start',
                      paddingVertical: 6,
                      paddingHorizontal: 10,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: colors.border,
                      backgroundColor: colors.surfaceAlt,
                      opacity: retryingPhotos ? 0.6 : 1,
                    }}
                  >
                    <Text style={{ color: colors.text, fontSize: 12, fontWeight: '800' }}>
                      {retryingPhotos ? 'Retrying…' : 'Retry these photos'}
                    </Text>
                  </Pressable>
                </>
              )}
            </View>
          )}

          <Pressable
            onPress={() => router.push(`/worklist/${created.lotId}`)}
            style={{
              padding: 14,
              backgroundColor: colors.surfaceAlt,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text style={{ color: colors.text, textAlign: 'center', fontWeight: '700' }}>
              📷 Add more photos to this lot
            </Text>
          </Pressable>

          <Pressable
            onPress={discardAll}
            style={{ padding: 16, backgroundColor: colors.primary, borderRadius: 12 }}
          >
            <Text style={{ color: '#000', textAlign: 'center', fontWeight: '900' }}>
              📷 Scan another item
            </Text>
          </Pressable>
        </ScrollView>

        {pendingSticker && (
          <PreStickeredScanner
            lotId={pendingSticker.lotId}
            lotCode={pendingSticker.lotCode}
            // C2: manager-only sticker skip. `role` from useOperatorRole();
            // narrow to 'staff' before reading role.role.
            canSkip={role.kind === 'staff' && hasOperatorRole(role.role, 'manager')}
            onAssigned={() => {
              setPendingSticker(null);
              beginCameraSettle();
            }}
            onCancel={() => {
              setPendingSticker(null);
              beginCameraSettle();
            }}
          />
        )}
      </SafeAreaView>
    );
  }

  return null;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}>
      <Text
        style={{ color: colors.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 0.5 }}
      >
        {label.toUpperCase()}
      </Text>
      <Text style={{ color: colors.text, fontSize: 13 }}>{value}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  banner: {
    margin: 14,
    padding: 12,
    borderWidth: 1,
    borderRadius: 10,
  },
  bannerBtn: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bannerBtnText: {
    color: colors.text,
    textAlign: 'center',
    fontWeight: '800',
    fontSize: 12,
  },
  blockedSkipBanner: {
    marginHorizontal: 14,
    marginBottom: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 10,
    backgroundColor: colors.surface,
  },
  blockedSkipTitle: {
    color: colors.text,
    fontWeight: '900',
    fontSize: 13,
    marginBottom: 4,
  },
  blockedSkipText: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  blockedSkipActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  blockedSkipButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  blockedSkipButtonLabel: {
    color: colors.text,
    textAlign: 'center',
    fontWeight: '800',
    fontSize: 12,
  },
  stripLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  thumbWrap: {
    width: 90,
    height: 90,
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
  thumbBadge: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    backgroundColor: colors.primary,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  thumbBadgeText: {
    color: '#000',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  thumbClear: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailGroup: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  ghostBtn: {
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  ghostBtnText: {
    color: colors.textMuted,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '600',
  },
  smallGhost: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  smallGhostText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  // ── Pallet / multi-item mode ──────────────────────────────────────────────
  palletToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  palletToggleOn: {
    borderColor: `${colors.primary}66`,
    backgroundColor: colors.primaryDim,
  },
  palletToggleTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '800',
  },
  palletToggleHint: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 2,
    lineHeight: 15,
  },
  palletRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  reviewFlag: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 5,
    backgroundColor: 'rgba(245,158,11,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.5)',
    marginLeft: 8,
  },
  reviewFlagText: {
    color: '#f59e0b',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  palletBottomBar: {
    padding: 14,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
});
