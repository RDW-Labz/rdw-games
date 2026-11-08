// LotTR — Quick Lot screen.
//
// Scan-first, no preset grid, no multiples, no AI.
// Target: <2 seconds per lot.
//
// Workflow:
//   1. Camera-first screen with continuous barcode scanning.
//      Auto-scans product + tracking barcodes (SCAN-1): UPC-A/E, EAN-13/8,
//      ITF-14, Code-128 (Code-128 = carrier tracking for the Wayfair manifest
//      flow). The barcode must be CENTERED in the reticle (region-of-interest)
//      and held steady for a few frames before it's accepted — this stops the
//      scanner grabbing off-center shipping-label QRs / manufacturer 2D codes.
//      Other codes (FNSKU/LPN/QR/etc.) go through manual entry or the no-match
//      "Create Custom Listing" path, which accept any string.
//   2. After each scan, a 2-second confirmation card shows what the lookup found:
//      - Matched:    title + brand + MSRP + green "catalog match" badge
//      - No match:   raw code + muted "no match" badge
//      Tap the card to skip the wait and create immediately.
//   3. If session.takePhotoAfterScan is ON, the confirmation card instead shows
//      "Add photo / Skip" buttons. User can capture one photo before lot creation.
//   4. Lot is created either way after the 2-second hold or immediate action.
//   5. Bottom sheet: session default condition + bid override (sticky-per-scan).
//   6. History list: last 5 lots created this run, with lot_codes.
//
// All JS-only — OTA updatable. No new native modules.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
  ScrollView,
  SafeAreaView,
  StyleSheet,
  Dimensions,
  Keyboard,
  Platform,
} from 'react-native';
import { useRouter, useFocusEffect, type Href } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { Camera, useCameraPermission, useCodeScanner } from 'react-native-vision-camera';
import { useDraftPersistence } from '@/features/lotting/useDraftPersistence';
import { useCameraGate } from '@/features/camera/useCameraGate';
import { useBackCamera } from '@/features/camera/useBackCamera';
import {
  TAKE_PHOTO_OPTIONS,
  ALL_RETAIL_CODE_TYPES,
  centerMostCode,
  makeHoldConfirmState,
  pushHoldConfirm,
  resetHoldConfirm,
  RETICLE_TOLERANCE,
  safeFlash,
  torchMode,
  translateCaptureError,
  type DecodedCode,
  type RankedCode,
} from '@/lib/vision-camera';
import { useTapToFocus } from '@/features/camera/useTapToFocus';
import { CameraCaptureSheet } from '@/features/camera/CameraCaptureSheet';
import { persistPhoto } from '@/lib/persist-photo';
import * as Haptics from 'expo-haptics';
import { createDraftLotFromCandidate, type LotCandidate } from '@auction-platform/domain-lotting';
import {
  supabase,
  useOperatorRole,
  hasOperatorRole,
  resolveOperatorIdForUpload,
} from '@auction-platform/supabase-client';
import { colors, type as typeTokens } from '@auction-platform/design-system';
import { CameraFlashButton } from '@/features/lotting/CameraFlashButton';
import {
  useLottingSession,
  ALL_CONDITIONS,
  CONDITION_LABELS,
  CONDITION_COLORS,
  ALL_SCAN_FIELD_KINDS,
  SCAN_FIELD_LABELS,
  SCAN_FIELD_PLACEHOLDERS,
  type DefaultCondition,
  type ScanFieldKind,
  activeLotSource,
} from '@/features/lotting/SessionContext';
import { useLottingMode } from '@/features/lotting/LottingModeContext';
import { lotCreateFailureReport, lotCreateUserMessage } from '@/lib/lot-create-failure';
import { reportNonFatal } from '@/lib/session-watchdog';
import {
  planStickerBeforeSave,
  NO_STICKER_SCANNED_TITLE,
  NO_STICKER_SCANNED_MESSAGE,
} from '@/lib/sticker-first';
import { LottingModeToggle } from '@/features/lotting/LottingModeToggle';
import { PhotoToggleRow } from '@/features/lotting/PhotoToggleRow';
import { ReviewToggleRow } from '@/features/lotting/ReviewToggleRow';
import {
  EditableCandidateCard,
  candidateToEditable,
  editableToCandidate,
  type EditableCandidate,
} from '@/features/lotting/EditableCandidateCard';
import { enrichReturnRef } from '@/features/lotting/enrichReturnRef';
import { PreStickeredScanner } from '@/features/lotting/PreStickeredScanner';
import { uploadPendingPhotos, isLocalPhotoUri } from '@/features/lotting/uploadPendingPhotos';
import { enqueuePendingLot, resolvePendingLot } from '@/lib/pending-lot-queue';
import { relocatePendingLotPhotos } from '@/features/lotting/relocatePendingLotPhotos';
import { extractTokenFromScan } from '@/features/lotting/bindStickerToLot';
import { bindStickerAfterSave, stickerRefusalCopy } from '@/features/lotting/stickerBindRunner';
import { SAVE_LOOKUP_TIMEOUT_MS, withTimeout } from '@/lib/sticker-bind-queue';
import { lotDisplayCode } from '@auction-platform/shared';
import { lookupCodeWithMeta, resolveStockImages, scanPhoto } from '@/lib/lottr-client';
import {
  extractScanCandidates,
  isNonUpcCode,
  type Symbology,
} from '@auction-platform/scan-extract';
import { compressForVision } from '@/lib/image-compress';
import { uploadImageFromUri } from '@/lib/upload-image';

const { width: SCREEN_W } = Dimensions.get('window');

// Accept a broad range of codes. Minimum 3 chars to avoid misfires on
// short Codabar/Code39 starts; trim spaces and dashes first.
const VALID_CODE_RE = /^[A-Za-z0-9\-_.]{3,}$/;

// C2/C3: isNonUpcCode (from @auction-platform/scan-extract) decides whether a
// manifest miss may go to the catalog/web lookup. See product-code.ts there.

// ── Barcode types (SCAN-1) ─────────────────────────────────────────────────────
//
// Quick Lot scans ALL_RETAIL_CODE_TYPES — every symbology (UPC-A/E, EAN-13/8,
// ITF-14, Code-128 AND Code-39/93, Codabar, QR, PDF417, Aztec, Data-Matrix),
// imported from '@/lib/vision-camera'. Operators must be able to scan anything,
// including Amazon LPN / FNSKU labels (Code-39), which the older, narrower
// PRODUCT_CODE_TYPES set excluded.
//
// The floor team's original "grabs any barcode" complaint was the OLD
// grab-the-first-decoded-code behavior, NOT the symbology list — so the fix is
// at the ACCEPTANCE layer, not by dropping formats. A code is auto-accepted only
// when it sits inside the reticle region-of-interest (centerMostCode) AND holds
// steady for QUICK_HOLD_CONFIRM_FRAMES consecutive frames; when 2+ codes are
// centered we require an explicit tap instead of auto-picking. Per operator
// request ("scan any code, just not as sensitive / fast / stacking as before"),
// the hold-to-confirm streak is set a notch longer here than the shared default
// so drive-by codes aren't grabbed even with the wider symbology set.
const QUICK_HOLD_CONFIRM_FRAMES = 5;

// Carrier-tracking labels (Code-128) get a SHORTER hold. These are the
// Wayfair/liquidation manifest-scan target — wide, glossy, fine-pitch bars
// that make the decoder flicker on/off frame-to-frame, which kept resetting
// the 5-frame streak so the scan "never took" even though typing the same
// number worked (build-13 staff report, 2026-07-11). Unlike a product UPC, a
// mis-grabbed Code-128 is low-risk: it just runs the manifest lookup and
// harmlessly returns no-match. 2 frames is enough to reject a true drive-by
// while tolerating the dropout flicker on a real tracking label.
const QUICK_HOLD_CONFIRM_TRACKING_FRAMES = 2;

// ── Types ─────────────────────────────────────────────────────────────────────

type ConfirmState = {
  code: string;
  candidate: LotCandidate | null;
  /** Countdown ms remaining before auto-create fires. */
  remainingMs: number;
  /** True while the confirmation is waiting for photo action. */
  awaitingPhoto: boolean;
  /** True when the candidate was seeded from a Wayfair manifest row (scanned
   *  FedEx tracking → find_import_row_by_tracking) rather than the catalog.
   *  Drives the "manifest match" badge + the import_row flip on save. */
  isManifest?: boolean;
  /** C2/C3: true when the scanned code is NOT a resolvable retail barcode
   *  (FNSKU/ASIN/LPN/roll-label — see isNonUpcCode). On a no-match this
   *  promotes the AI photo-identify path to the primary action, since a photo
   *  is the only way to identify such an item. Ignored on a match. */
  nonUpc?: boolean;
  /** True only when startConfirmation actually armed the 2-second auto-create
   *  timer. Two confirmations deliberately arm no timer — a no-match, and a
   *  hand-typed match — and `remainingMs` alone cannot tell them apart from a
   *  paused countdown, because nothing ever decrements it. resumeAutoCreate
   *  read only remainingMs and so re-armed both, which is how a blur of the
   *  manual code field minted a lot the operator had not approved. */
  autoCreateArmed?: boolean;
};

// ── Build a minimal lot candidate from a scanned code ────────────────────────
//
// persistence.ts maps candidate.upc → lots.external_code. For numeric UPCs we
// populate upc; for other code types (FNSKU, LPN, internal codes) we store the
// raw code in upc so the intake scanner can resolve it via external_code lookup.
function makeQuickCandidate(
  code: string,
  resolvedCandidate: LotCandidate | null,
  condition: DefaultCondition,
  startBid: number,
): LotCandidate {
  if (resolvedCandidate) {
    // Use the catalog-resolved candidate but preserve the scanned code as
    // the upc so external_code lookup works at intake.
    return {
      ...resolvedCandidate,
      upc: resolvedCandidate.upc || code,
      condition: condition as LotCandidate['condition'],
      startBid,
    };
  }
  // No catalog match — create a bare lot with the scanned code.
  return {
    title: `Quick lot — ${code}`,
    fullTitle: `Quick lot — ${code}`,
    brand: '',
    model: '',
    upc: code,
    category: 'Other',
    subcategory: '',
    packagingMsrp: null,
    condition: condition as LotCandidate['condition'],
    description: '',
    searchQuery: '',
    confidence: 'low',
    notes: '',
    prices: [],
    stockPhotos: [],
    msrp: null,
    avg: null,
    startBid,
    specs: '',
  };
}

// ── Build a lot candidate from a matched manifest row (Wayfair tracking scan) ──
//
// When the scanned code matched a PENDING import_row by tracking_number, seed
// the draft from the manifest data instead of the catalog. IMPORTANT: the
// candidate's `upc` is the manifest row's upc (usually empty for Wayfair) —
// NEVER the scanned tracking number. createDraftLotFromCandidate maps
// candidate.upc → lots.external_code, and the FedEx tracking must not become
// the lot's identity (that's the pre-printed sticker). It also maps
// candidate.stockPhotos → lots.photo_urls and candidate.msrp (dollars) →
// lots.msrp_cents.
function buildManifestCandidate(row: Record<string, unknown>): LotCandidate {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const msrpCents = num(row.msrp_cents);
  const photo = str(row.photo_url);
  const baseDesc = str(row.description).trim();
  // Surface the manifest's SKUs on the lot so bidders can look the product up.
  // The importer preserves the verbatim source row in raw_data; read the
  // Wayfair SKU columns case/space-insensitively (e.g. "ProductSKU", "Site SKU").
  // Return reason is intentionally NOT shown on the lot.
  const rawData =
    row.raw_data && typeof row.raw_data === 'object' && !Array.isArray(row.raw_data)
      ? (row.raw_data as Record<string, unknown>)
      : {};
  const rawValue = (needle: string): string => {
    for (const [k, v] of Object.entries(rawData)) {
      if (k.replace(/[\s_]/g, '').toLowerCase() === needle) {
        return v == null ? '' : String(v).trim();
      }
    }
    return '';
  };
  // Structured SKUs (mig 0188): read once here for the dedicated candidate
  // fields that round-trip onto lots.product_sku/site_sku/manufacture_sku via
  // the create_draft_lot RPC. Empty → undefined so they behave like the absent
  // asin/fnsku identity fields (the RPC stores NULL).
  const productSku = rawValue('productsku');
  const siteSku = rawValue('sitesku');
  const manufactureSku = rawValue('manufacturesku');
  // The SKUs already persist to their own candidate fields (productSku/siteSku/
  // manufactureSku below) and the title is its own field, so the description
  // carries ONLY the manifest's real description. Leave it empty when the
  // manifest has none rather than padding it with the title or SKU lines, which
  // would just duplicate dedicated fields on the lot.
  const description = baseDesc;
  return {
    title: str(row.title).slice(0, 500) || 'Manifest lot',
    fullTitle: str(row.title),
    brand: str(row.brand),
    // import_rows.model (mig 0032) is populated for ~69% of rows; when blank,
    // fall back to manufacture_sku (Wayfair ManufactureSKU, e.g. "PMGY0016S-1A")
    // so candidate.model still populates the confirmation card's brand·model
    // line AND round-trips to lots.model + lots.mpn via create_draft_lot.
    model: str(row.model) || manufactureSku,
    // Manifest upc only (empty for Wayfair) — NOT the tracking number.
    upc: str(row.upc),
    category: (str(row.category_raw) || 'Other') as LotCandidate['category'],
    subcategory: '',
    packagingMsrp: null,
    condition: 'good' as LotCandidate['condition'],
    description,
    searchQuery: '',
    confidence: 'high',
    notes: '',
    prices: [],
    stockPhotos: /^https?:\/\//.test(photo) ? [photo] : [],
    msrp: msrpCents != null && msrpCents > 0 ? msrpCents / 100 : null,
    avg: null,
    startBid: 0,
    specs: '',
    // 0188: carry the structured SKUs as dedicated candidate fields (not just
    // in the description blob) so createDraftLotFromCandidate can pass them to
    // create_draft_lot → lots.product_sku/site_sku/manufacture_sku. Empty
    // strings become undefined, mirroring the absent asin/fnsku convention.
    productSku: productSku || undefined,
    siteSku: siteSku || undefined,
    manufactureSku: manufactureSku || undefined,
  };
}

// ── PHOTO-2: fill an empty stock photo from the catalog before review ─────────
//
// The web Quick Lot path resolves catalog images inline before attaching a
// photo; mobile had no equivalent, so a candidate whose catalog / manifest row
// carried no image reached the review card photo-less. When the candidate has
// no stockPhotos but a usable identifier, resolve them via the FREE
// /api/lottr/resolve-images endpoint (catalog read-through -> free identifier
// enrichment). Best-effort: the candidate is returned unchanged on any
// miss/error. The common already-has-photo path short-circuits, so this adds no
// perceived latency there; the network call only fires on a photo-less hit and
// runs inside the existing "Looking up…" overlay.
async function withResolvedStockPhotos(
  candidate: LotCandidate | null,
  ids: { upc?: string; asin?: string },
): Promise<LotCandidate | null> {
  if (!candidate) return candidate;
  if (candidate.stockPhotos && candidate.stockPhotos.length > 0) return candidate;
  const urls = await resolveStockImages({ upc: ids.upc, asin: ids.asin });
  if (urls.length === 0) return candidate;
  return { ...candidate, stockPhotos: urls };
}

// ── Main screen ───────────────────────────────────────────────────────────────

// Env-derived and constant for the process — module scope so it is not a
// fresh value on every render (and not a phantom hook dependency).
const API_BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL || 'https://bingoauctions.com').replace(
  /\/$/,
  '',
);

export default function QuickLotScreen() {
  const router = useRouter();
  const role = useOperatorRole();
  const { session, setSession, pushRecentLot } = useLottingSession();
  const { mode: lottingMode } = useLottingMode();
  // Pre-stickered Flow B: the modal scanner takes over after a
  // successful lot creation to capture the sticker UUID. Non-null
  // means the scanner overlay is rendered; the underlying camera
  // is paused via `isActive` because the modal sits on top.
  const [pendingSticker, setPendingSticker] = useState<{
    lotId: string;
    lotCode: string;
    /** Scan-recovery: replace an existing sticker (rebind_sticker_code). */
    rebind?: boolean;
  } | null>(null);
  // Sticker before save (2026-10-05): when the creating scan is not itself the
  // sticker (manifest match, UPC, name search), the capture scanner opens
  // first and createLot is re-run with the same arguments once it returns.
  const [captureSticker, setCaptureSticker] = useState<{
    args: Parameters<typeof createLot>;
  } | null>(null);
  const capturedStickerRef = useRef<string | null>(null);
  // The lot the "Created" toast is about, for a background bind that answers
  // after the next scan has already replaced it.
  const lastCreatedLotIdRef = useRef<string | null>(null);
  // Option B: true once the creation scan auto-bound its sticker, so the
  // success toast says "Sticker bound" instead of "ready for next scan".
  const [justBoundSticker, setJustBoundSticker] = useState(false);
  const { hasPermission, requestPermission } = useCameraPermission();
  // Battery (recap 2026-07-08): stop the camera when this screen is
  // behind another route or the app is backgrounded.
  const cameraGate = useCameraGate();
  // Battery, part 2: Quick Lot is open ALL SHIFT — the camera burning
  // through slow stretches (unboxing, moving totes) is the biggest drain.
  // After IDLE_PAUSE_MS without a decoded frame the camera sleeps behind a
  // "tap to resume" cover; any scan or viewfinder tap resets the clock.
  const IDLE_PAUSE_MS = 3 * 60_000;
  const [cameraIdle, setCameraIdle] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bumpIdle = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setCameraIdle(true), IDLE_PAUSE_MS);
  }, [IDLE_PAUSE_MS]);
  useEffect(() => {
    bumpIdle();
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [bumpIdle]);
  // Black-screen fix (staff report 2026-07-17): after the PreStickeredScanner
  // modal closes on a successful bind, the main camera used to remount and
  // cold-start a fresh AVCaptureSession in the SAME commit the modal's session
  // was still tearing down. iOS can't run two sessions at once, so the preview
  // came up BLACK and only a force-close cleared it. Hold the main camera
  // unmounted for a short settle window after the modal dismisses so the
  // outgoing session fully releases before the new one starts. (Mirrors the
  // deferred-teardown black-screen fix already documented in manual.tsx.)
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
  }, [CAMERA_SETTLE_MS]);
  useEffect(
    () => () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    },
    [],
  );
  // Leaving Quick Lot: stop the camera FIRST, navigate on the next frame.
  //
  // Reported 2026-08-20 (staff member): "The done button takes way too long to work
  // like extremely long."
  //
  // Tapping Done used to call router.back() while an AVCaptureSession was
  // still live, several photo uploads were in flight, and — when a scan was
  // pending — a 100ms countdown interval was re-rendering the screen ten times
  // a second. The navigation had to wait for the camera teardown that the
  // unmount itself triggered, on the busiest JS thread in the app.
  //
  // This flips the order: set the camera inactive and cancel the timers on the
  // tap, then navigate once React has committed that. The teardown still
  // happens, it just is not standing between the operator and the next screen.
  //
  // HONEST LIMIT: nobody has measured this on the actual iPads, so the report
  // says "too long" and not a number. That is what the timing below is for —
  // an exit slower than SLOW_EXIT_MS reports itself through the same telemetry
  // the watchdog uses, so the next conversation about this button starts with
  // a duration instead of an adjective.
  //
  // ── THE FIRST ATTEMPT AT THAT TIMING MEASURED NOTHING ───────────────────────
  // It read the clock inside the same requestAnimationFrame that called
  // router.back(), so `elapsed` covered one frame plus a navigation DISPATCH
  // that returns immediately — always ~16-32ms, never once the 1500ms floor.
  // Six days and zero rows: not evidence the button is fast, evidence the
  // stopwatch stopped before the race started.
  //
  // What the operator actually waits for is the screen going away, so that is
  // what is timed now: the tap stamps a ref, and this component's unmount
  // cleanup — which runs when expo-router finishes tearing Quick Lot down,
  // camera teardown included — reports the span. The ref is only ever set by
  // the Done button, so an unmount from any other cause reports nothing.
  const SLOW_EXIT_MS = 1500;
  const exitStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      const startedAt = exitStartedAtRef.current;
      exitStartedAtRef.current = null;
      if (startedAt == null) return;
      const elapsed = Date.now() - startedAt;
      if (elapsed < SLOW_EXIT_MS) return;
      void fetch(`${API_BASE_URL}/api/telemetry/crash`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          app: 'staff',
          platform: Platform.OS === 'android' ? 'android' : 'ios',
          message: `slow exit: Done on Quick Lot took ${elapsed}ms`,
          screen: '/lotting/quick',
          is_fatal: false,
        }),
      }).catch(() => {});
    };
    // Mount-once: the cleanup must run at unmount, not on every render.
  }, []);

  const exitToLotting = useCallback(() => {
    exitStartedAtRef.current = Date.now();
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (autoCreateTimer.current) clearTimeout(autoCreateTimer.current);
    if (countdownInterval.current) clearInterval(countdownInterval.current);
    setCameraIdle(true);
    setConfirm(null);

    requestAnimationFrame(() => {
      router.back();
    });
  }, [router]);

  const cameraRef = useRef<Camera>(null);
  const device = useBackCamera();
  const focus = useTapToFocus(cameraRef);
  // SCAN-1 hold-to-confirm streak: the same centered value must persist across
  // HOLD_CONFIRM_FRAMES consecutive scan callbacks before we accept it. Lives
  // in a ref so it mutates synchronously per frame without re-rendering.
  const holdConfirmRef = useRef(makeHoldConfirmState());
  // SCAN-1 tap-to-select: when >1 code sits inside the reticle band at once we
  // can't know which the operator means, so we surface tappable overlays. This
  // holds the ranked in-frame codes (nearest-first) driving those overlays.
  // Empty = nothing ambiguous on screen (single-code auto-accept path).
  const [inFrameCodes, setInFrameCodes] = useState<RankedCode[]>([]);
  // Live scan diagnostic (build-14 recap: "camera in QuickLot with Wayfair
  // doesn't work"). A tiny on-screen readout of what the decoder actually sees
  // so a failing scan is a screenshot, not another guess. Updated only when the
  // description changes to avoid per-frame re-renders on the camera hot path.
  const [scanHint, setScanHint] = useState<string>('');
  // v4 codeScanner — composed onto <Camera codeScanner={...}/>.
  //
  // SCAN-1 acceptance pipeline (replaces the old "grab the first decoded
  // code"): accept ALL_RETAIL_CODE_TYPES (any symbology), then for each frame
  //   1. rank decoded codes by distance from the reticle (frame center),
  //   2. require the nearest centered value to be HELD across N frames
  //      (hold-to-confirm) before auto-accepting — kills single-frame
  //      flickers of a barcode sweeping past,
  //   3. if 2+ codes sit inside the reticle band, DON'T auto-pick — publish
  //      them to `inFrameCodes` so the operator taps the right one.
  const codeScanner = useCodeScanner({
    codeTypes: ALL_RETAIL_CODE_TYPES,
    onCodeScanned: (codes, frame) => {
      // Frames are arriving → the operator is actively scanning; push the
      // idle-pause clock back.
      bumpIdle();
      // Don't process / accumulate while a confirmation is up or we're busy —
      // mirrors the gate inside onBarcodeScanned and stops overlay churn.
      if (barcodeLockRef.current || looking || creating || confirm !== null) {
        return;
      }
      const { code, ranked, geometryMissing } = centerMostCode(codes, frame, RETICLE_TOLERANCE);

      // Geometry-unavailable fallback (device reports no frame/corners):
      // behave like the legacy first-code path so scanning never dead-stops.
      if (geometryMissing) {
        setInFrameCodes((prev) => (prev.length ? [] : prev));
        setScanHint((h) => (h === 'no geometry' ? h : 'no geometry'));
        if (code) void onBarcodeScanned(code);
        return;
      }

      // ── Live scan diagnostic ────────────────────────────────────────────
      const centeredNow = ranked.filter(
        (r) =>
          Math.abs(r.cx - 0.5) <= RETICLE_TOLERANCE && Math.abs(r.cy - 0.5) <= RETICLE_TOLERANCE,
      );
      {
        const hint =
          ranked.length === 0
            ? ''
            : `${ranked.length} code${ranked.length > 1 ? 's' : ''} · ${centeredNow.length} centered · ${ranked
                .map((r) => r.type)
                .join(', ')}`;
        setScanHint((h) => (h === hint ? h : hint));
      }

      // ── Carrier-tracking fast path (Wayfair/liquidation manifest flow) ──
      // Shipping labels are barcode-dense: the Code-128 tracking barcode sits
      // beside product UPC/EAN and 2D blocks, which used to trip the multi-code
      // tap gate below so the scan never auto-accepted. When exactly one
      // *centered* code is a Code-128 (the tracking target — a different
      // symbology from a product UPC/EAN), prefer it directly with the short
      // tracking hold. A mis-grab just no-matches the manifest, so it's safe;
      // product-UPC scanning is untouched.
      const centered128 = centeredNow.filter((r) => r.type === 'code-128');
      if (centered128.length === 1) {
        const only = centered128[0]!;
        setInFrameCodes((prev) => (prev.length ? [] : prev));
        const held128 = pushHoldConfirm(
          holdConfirmRef.current,
          only.data,
          QUICK_HOLD_CONFIRM_TRACKING_FRAMES,
        );
        if (held128) {
          resetHoldConfirm(holdConfirmRef.current);
          void onBarcodeScanned({ data: only.data, type: only.type });
        }
        return;
      }

      // Tap-to-select: multiple distinct values centered enough to be
      // plausible. Surface them and require an explicit tap (no auto-accept,
      // and reset the hold streak so a later single code starts fresh).
      const centeredValues = new Set(
        ranked
          .filter(
            (r) =>
              Math.abs(r.cx - 0.5) <= RETICLE_TOLERANCE &&
              Math.abs(r.cy - 0.5) <= RETICLE_TOLERANCE,
          )
          .map((r) => r.data),
      );
      if (centeredValues.size > 1) {
        resetHoldConfirm(holdConfirmRef.current);
        setInFrameCodes(ranked.slice(0, 4));
        return;
      }

      // Single (or zero) centered code → clear any stale overlay.
      setInFrameCodes((prev) => (prev.length ? [] : prev));

      // Hold-to-confirm: `code` is the centered value (or null when nothing is
      // inside the band). Only accept once it's been steady for N frames.
      // Code-128 (carrier tracking) accepts after a shorter hold — see the
      // constant's note. Everything else keeps the full anti-over-scan streak.
      const holdFrames =
        code?.type === 'code-128' ? QUICK_HOLD_CONFIRM_TRACKING_FRAMES : QUICK_HOLD_CONFIRM_FRAMES;
      const held = pushHoldConfirm(holdConfirmRef.current, code?.data ?? null, holdFrames);
      if (held && code) {
        resetHoldConfirm(holdConfirmRef.current);
        void onBarcodeScanned(code);
      }
    },
  });

  // Per-scan state
  const [overrideCondition, setOverrideCondition] = useState<DefaultCondition | null>(null);
  const [overrideStartBid, setOverrideStartBid] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [looking, setLooking] = useState(false);
  // Recent history is now in SessionContext (persisted via AsyncStorage),
  // so we read from there instead of local state. Survives navigation
  // away to Scan / Inventory / hub and back.
  const history = session.recentHistory;
  const [justCreatedCode, setJustCreatedCode] = useState<string | null>(null);
  // What the operator READS for the lot just created: the label physically on
  // the box when one was bound, else the synthetic lot_code. justCreatedCode
  // stays the true lot_code; this is display only. Quick Lot is the pilot for
  // label-first identity (owner call 2026-08-07) — a BIN-###### shows here
  // only when the box genuinely carries no label.
  const [justCreatedDisplayCode, setJustCreatedDisplayCode] = useState<string | null>(null);
  // Scan-recovery (2026-07-08): the just-created lot's id, so the toast can
  // offer "Fix sticker / code" (rebind) and "Discard" without a manager.
  const [justCreatedLotId, setJustCreatedLotId] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  // When a lot was saved but its photo upload failed, this holds a short
  // reason to display in the toast so the user knows to retry from Inventory.
  // null when no photo was attempted or the photo succeeded.
  const [justCreatedPhotoIssue, setJustCreatedPhotoIssue] = useState<string | null>(null);
  const justCreatedToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (justCreatedToastTimerRef.current) clearTimeout(justCreatedToastTimerRef.current);
    },
    [],
  );

  // Torch toggle for the barcode scanner. Binary on/off because the
  // operator is aiming at a label and wants sustained light, not a
  // shutter flash. Defaults off — most warehouses have enough ambient
  // light; operators flip it on for dim corners.
  const [torchOn, setTorchOn] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);
  // Collapsible lotting-settings panel (mode / photo / review). Collapsed by
  // default so the scan screen stays focused; the header shows a live summary
  // and expands to the three toggles on tap.
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Confirmation card state
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  // 2026-08-15 (staff reports): "going to Amazon for a stock photo backs me
  // out and I have to start over". Android reclaims a backgrounded process
  // holding a live camera + decoded bitmaps, silently — the app returns cold
  // and the in-progress lot is gone. We cannot stop the kill; we make it
  // survivable. See features/lotting/useDraftPersistence.ts for why this ships
  // even though the underlying crash is still unidentified.
  const draftStore = useDraftPersistence<ConfirmState>('quick');
  const draftOffered = useRef(false);
  // Do not write/clear until the saved draft has actually been read. A mount
  // save(null) racing the read — or a transient storage failure — used to
  // delete a recoverable draft before it could be offered (RED TEAM #683).
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftReadAttempt, setDraftReadAttempt] = useState(0);
  const draftRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persist on every change. Debounced + fire-and-forget inside the hook, so
  // this adds nothing measurable to the scan hot path.
  useEffect(() => {
    if (!draftLoaded) return;
    draftStore.save(confirm);
  }, [confirm, draftStore, draftLoaded]);

  // Offer a recent draft back, ONCE per mount, and only when the screen is
  // otherwise empty — never clobber a lot the picker has already started.
  useEffect(() => {
    if (draftOffered.current) return;
    let cancelled = false;
    (async () => {
      const result = await draftStore.loadDraft();
      if (cancelled) return;
      if (result.status === 'unavailable') {
        // Leave the draft untouched and retry; opening the writer now would
        // let the mount save delete it.
        if (draftRetryTimer.current) clearTimeout(draftRetryTimer.current);
        draftRetryTimer.current = setTimeout(() => {
          draftRetryTimer.current = null;
          if (!cancelled) setDraftReadAttempt((n) => n + 1);
        }, 1000);
        return;
      }
      if (draftRetryTimer.current) {
        clearTimeout(draftRetryTimer.current);
        draftRetryTimer.current = null;
      }
      draftOffered.current = true;
      setDraftLoaded(true);
      const saved = result.status === 'draft' ? result.draft : null;
      if (!saved || !saved.candidate) return;
      setConfirm((current) => {
        if (current) return current; // already working — leave it alone
        Alert.alert(
          'Unfinished item restored',
          `Picked up where you left off on "${saved.candidate?.title ?? saved.code}".`,
          [
            {
              text: 'Discard',
              style: 'destructive',
              onPress: () => {
                draftStore.clear();
                setConfirm(null);
              },
            },
            { text: 'Keep', style: 'default' },
          ],
        );
        // Restored WITHOUT the auto-create countdown: the picker was
        // interrupted, so the item must not save itself out from under them
        // seconds after the app reopens.
        return { ...saved, remainingMs: 0, awaitingPhoto: false };
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [draftStore, draftReadAttempt]);

  useEffect(
    () => () => {
      if (draftRetryTimer.current) clearTimeout(draftRetryTimer.current);
    },
    [],
  );

  // Review-before-save state (Batch 3). When session.reviewBeforeSave is ON
  // and a MATCHED (catalog / manifest) candidate resolves, startConfirmation
  // populates `reviewEditable` instead of scheduling the 2s auto-create. The
  // EditableCandidateCard binds to this; Save Lot maps it back via
  // editableToCandidate → createLot. Null = no review card open. `confirm`
  // stays set alongside it so the camera + barcode scanner remain paused.
  const [reviewEditable, setReviewEditable] = useState<EditableCandidate | null>(null);

  // Saving from the review card is TWO phases: upload any local photos, then
  // create the lot. Only the second flips `creating`, so between the tap and
  // the RPC the button had no spinner and no guard — it looked untouched for
  // as long as the upload took.
  //
  // 2026-09-22: one lotter tapped it 65 times in about four minutes. Every tap
  // restarted the whole serial compress-and-upload, and uploads were landing a
  // median 51s (max 448s) after the call, so the queue only grew. It produced
  // 105 objects in lot-photos/_pending/ — three distinct images, re-uploaded —
  // and not one lot: nothing ever got past phase one.
  //
  // `savingReview` covers phase one the way `creating` covers phase two. The
  // ref is the same synchronous mutex createLot uses (see creatingLockRef):
  // two taps in one tick both pass a state check, and each costs a re-upload.
  const [savingReview, setSavingReview] = useState(false);
  const reviewSaveLockRef = useRef(false);

  const barcodeLockRef = useRef(false);
  // R4.1: ref-based mutex for createLot. The state-based guard
  // `if (creating) return` reads stale React state when both the auto-create
  // timer and the user's tap-to-skip fire in the same tick — both pass the
  // guard, both call createDraftLotFromCandidate, both consume a lot_code
  // from next_lot_code, and the user gets two lots from one scan. A ref
  // is mutated synchronously and read synchronously, so the second caller
  // sees the first's set immediately.
  const creatingLockRef = useRef(false);
  // 0269: the ref mutex above only catches SAME-TICK re-entry. Prod showed
  // duplicate manifest lots created ~1s apart — the auto-create timer fired and
  // completed (releasing the lock), then a confirm/photo submit fired a second
  // create for the same box. This set records manifest import_row ids already
  // lotted this session so the second create short-circuits before hitting the
  // RPC. (The RPC itself is now idempotent on import_row_id too — mig 0269 — so
  // this is defense-in-depth, and it also spares the wasted round-trip.) Keyed
  // on the manifest row, so two REAL units (two different import_rows) are never
  // blocked.
  const lottedManifestRowsRef = useRef<Set<string>>(new Set());
  // Wayfair: when the scanned code matched a pending import_row by
  // tracking_number, this holds that row id so createLot can flip it to
  // 'lotted' + link the new lot after a successful save. Set in processCode,
  // read + cleared in createLot. Only one confirmation is active at a time
  // (gated by confirm !== null), so a single ref is unambiguous.
  const pendingManifestRowIdRef = useRef<string | null>(null);
  // 0272 dedup: one idempotency token per confirmation (per intended lot).
  // Set in startConfirmation, snapshotted in createLot, passed to
  // create_draft_lot. If the auto-create timer and a manual/photo save both
  // fire for the SAME confirmation, they share this token, so the RPC returns
  // the first lot instead of minting a duplicate twin. Overwritten on the next
  // scan's startConfirmation; a new scan therefore gets a new token.
  const pendingClientTokenRef = useRef<string | null>(null);
  const manualRef = useRef<TextInput>(null);
  const autoCreateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  // Active condition: per-scan override if set, otherwise session default
  const activeCondition: DefaultCondition = overrideCondition ?? session.defaultCondition;
  const activeStartBid: number = (() => {
    if (overrideStartBid !== null) {
      const parsed = parseFloat(overrideStartBid);
      return isNaN(parsed) || parsed <= 0 ? session.defaultStartBid : parsed;
    }
    return session.defaultStartBid;
  })();

  // ── Cleanup timers on unmount ──────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (autoCreateTimer.current) clearTimeout(autoCreateTimer.current);
      if (countdownInterval.current) clearInterval(countdownInterval.current);
    };
  }, []);

  // ── Create lot ─────────────────────────────────────────────────────────────

  // Round-5 fix (2026-07-03): `code` reaches createLot from TWO worlds — a
  // physical scan (sticker label / QR) or FREE TEXT (the Can't-Scan name
  // search, web-lookup keys). The single-scan auto-bind (step 4b) used to
  // treat both as stickers, so searching "recessed flower light" bound
  // sticker_code 'BIN:RECESSEDFLOWERLIGHT' (real prod rows BIN-000236/237)
  // and the sticker scanner never opened. Physical pre-printed labels are
  // always compact letters+digits (TEA4840030, BRN123456) — anything else
  // is not a sticker and must go through the scanner step.
  const looksLikePhysicalSticker = (raw: string): boolean =>
    /^[A-Za-z]{2,8}[0-9]{3,}$/.test(raw.trim());

  const createLot = useCallback(
    async (
      code: string,
      resolvedCandidate: LotCandidate | null,
      // B1: one OR many captured photo URIs. The first uri lands as
      // photo_urls[0] (the listing thumbnail operator-web shows); the rest
      // follow in capture order. A single-element array preserves the old
      // single-photo behavior; undefined/empty means "create without a photo"
      // (the Skip / fast path). Accepts a bare string too for back-compat
      // with the few callers that still pass one uri.
      photoUris?: string | string[],
      // Batch 3 (review-before-save): when provided, this fully-formed
      // candidate (already carrying the operator's edited title / brand /
      // condition / startBid / description from the review card) is used
      // VERBATIM — skipping makeQuickCandidate and the active-condition /
      // active-startBid overrides so the operator's edits aren't clobbered.
      // The OFF path never passes this, so its behavior is unchanged.
      overrideCandidate?: LotCandidate,
      // PHOTO-1: already-remote stock photo URLs (https) to MERGE in front of
      // the freshly-captured `photoUris`. Used by the matched-confirmation
      // "Add BinGo Auctions photo" flow so a real shot is appended to the candidate's
      // stock photos instead of REPLACING them. The RPC already seeds
      // photo_urls from candidate.stockPhotos, but the post-save photo_urls
      // overwrite below would otherwise clobber that with the captures alone —
      // so we re-prepend the stock URLs here. undefined/empty → unchanged
      // legacy behavior (captures become the whole photo_urls).
      existingStockUrls?: readonly string[],
    ) => {
      // Effective operator id for this save. createLot genuinely needs an
      // operatorId AND that id becomes the FIRST folder segment of every
      // lot-photos upload path, which the Storage RLS policy checks against
      // current_operator_id(). useOperatorRole().operatorId is `undefined`
      // during a loading / transient-downgrade window, so we ALWAYS resolve
      // from the same source the server's current_operator_id() uses
      // (operator_users for auth.uid()) rather than trusting the cached role.
      // This is a no-network-modal silent retry: only a genuinely signed-out
      // session (or missing operator_users row) blocks the save.
      // Sticker before save: in Pre-stickered mode the creating scan counts
      // as the sticker only when it looks like a physical label and is not a
      // manifest (shipping-label) match. Otherwise scan the sticker first.
      // Decided BEFORE the operator lookup below (2026-10-08): #416 ran that
      // network call first, so on bad wifi the scanner opened only after it
      // answered, and the lookup then ran a second time after the scan.
      const stickerPlan = planStickerBeforeSave({
        mode: lottingMode,
        scannedCode: code,
        isManifestMatch: Boolean(pendingManifestRowIdRef.current),
        capturedSticker: capturedStickerRef.current,
        looksLikePhysicalSticker,
      });
      if (stickerPlan.action === 'scan_first') {
        // The pending auto-create would otherwise fire createLot again (and
        // re-render the countdown 10x/s) behind the capture scanner.
        if (autoCreateTimer.current) {
          clearTimeout(autoCreateTimer.current);
          autoCreateTimer.current = null;
        }
        if (countdownInterval.current) {
          clearInterval(countdownInterval.current);
          countdownInterval.current = null;
        }
        setCaptureSticker({
          args: [code, resolvedCandidate, photoUris, overrideCandidate, existingStockUrls],
        });
        return;
      }
      // Bounded: on bad wifi this lookup had no limit (2026-10-08).
      const operatorId = await withTimeout<string | null | 'timeout'>(
        resolveOperatorIdForUpload(),
        SAVE_LOOKUP_TIMEOUT_MS,
        () => 'timeout',
      );
      if (operatorId === 'timeout' || operatorId === null) {
        // Nothing saved: drop the captured sticker so a later, different
        // item can never inherit it. The next save scans it again.
        capturedStickerRef.current = null;
        if (operatorId === 'timeout') {
          Alert.alert(
            'Server slow, try again',
            'Could not confirm your staff account in time. Nothing was saved.',
          );
        } else {
          Alert.alert('Not signed in as staff');
        }
        return;
      }
      const stickerFromPlan = stickerPlan.sticker ?? '';
      capturedStickerRef.current = null;
      // R4.1: ref guard runs before state guard so concurrent callers
      // (auto-create timer + tap-to-skip + manual submit) all serialize
      // through this single mutex. setCreating still drives the spinner UI.
      if (creatingLockRef.current) return;
      creatingLockRef.current = true;

      // 0272 duplicate-lot fix: cancel the pending auto-create timer the moment
      // ANY create starts. The ref mutex only blocks CONCURRENT callers; it does
      // not stop the 2s auto-create timer from firing a SECOND create after a
      // manual/photo save has already completed and released the lock (the
      // verified prod double-fire: two consecutive lot_codes ~1s apart, one an
      // orphan twin). Clearing the timer here closes that sequential race; the
      // shared client token (below) is the DB-enforced backstop.
      if (autoCreateTimer.current) {
        clearTimeout(autoCreateTimer.current);
        autoCreateTimer.current = null;
      }
      if (countdownInterval.current) {
        clearInterval(countdownInterval.current);
        countdownInterval.current = null;
      }

      setCreating(true);
      // Wayfair: snapshot whether this save came from a manifest-tracking scan
      // (set in processCode). Captured before any await so the fire-and-forget
      // flip below uses a stable value even after the ref is cleared.
      const manifestRowId = pendingManifestRowIdRef.current;
      // 0269: this manifest box was already lotted this session (a prior
      // create for the same import_row completed). Short-circuit the second
      // create so we don't spend an RPC round-trip re-confirming what the
      // idempotent RPC would just return. The finally block releases the lock.
      if (manifestRowId && lottedManifestRowsRef.current.has(manifestRowId)) {
        return;
      }
      // 0272: idempotency token for this create. Reuse the confirmation's token
      // so a double-fire dedups; fall back to a fresh one if somehow unset (a
      // fresh token just means "no dedup for this call" — safe, matches prior).
      const clientToken = pendingClientTokenRef.current ?? Crypto.randomUUID();
      try {
        // Batch 3: a review-card save passes a fully-edited candidate that we
        // use verbatim. Its upc was seeded from the same resolvedCandidate
        // (manifest upc, or catalog upc || scanned code) so the manifest
        // FedEx-tracking-never-becomes-external_code invariant still holds.
        // Otherwise: manifest hits keep the candidate's upc as-is (the
        // manifest's, usually empty for Wayfair) so the scanned FedEx tracking
        // never becomes lots.external_code. Catalog/bare hits keep existing
        // behavior (scanned code → external_code for intake resolution).
        const candidate = overrideCandidate
          ? overrideCandidate
          : manifestRowId && resolvedCandidate
            ? {
                ...resolvedCandidate,
                condition: activeCondition as LotCandidate['condition'],
                startBid: activeStartBid,
              }
            : makeQuickCandidate(code, resolvedCandidate, activeCondition, activeStartBid);
        // PERF (2026-05-21): the heavy work (photo mirror to stock-images
        // bucket + product_lookups cache write-through) used to run
        // INSIDE this call, adding 1-3s before any UI feedback. It now
        // lives on the returned `enrich` thunk that we fire-and-forget
        // below, so the camera resets for the next scan instantly.
        // Wayfair D2L manifest matches carry their own provenance: they came
        // off the Wayfair returns manifest, not off whatever truck/source the
        // lotter last typed. Stamping the stale session default here is the
        // "Store Assignment shows Relot Sedalia instead of Wayfair-D2L" bug
        // (owner recap 2026-07-15) — a lotter working straight from the manifest
        // saw their leftover freeform source leak onto every Wayfair lot. For a
        // manifest hit, stamp the manifest's own source/vendor and ignore the
        // session default; non-manifest lots (AI scan / catalog / bare) keep it.
        const isManifestMatch = Boolean(manifestRowId);
        const createSource = isManifestMatch ? 'Wayfair-D2L' : activeLotSource(session) || null;
        const createVendor = isManifestMatch ? 'Wayfair' : session.defaultVendor || null;

        // Record the intent BEFORE the RPC. If nothing comes back — the
        // process is reclaimed here, the request is lost — this is the only
        // evidence the item was ever meant to exist; `lots` has no row and the
        // photos are already in the bucket. Replay is safe because the
        // clientToken below is the 0272 dedup token. See lib/pending-lot-queue.
        const pendingId = await enqueuePendingLot({
          clientToken,
          candidate,
          operatorId,
          source: createSource,
          vendor: createVendor,
          importRowId: manifestRowId ?? null,
          title: candidate.title || candidate.fullTitle || 'Lot',
        });

        const out = await createDraftLotFromCandidate(supabase, {
          candidate,
          operatorId,
          // Source/truck label. Manifest hits → the manifest's own label so
          // Wayfair inventory always groups under Wayfair-D2L; otherwise the
          // session default (VRID / load / origin facility).
          source: createSource,
          // Vendor/supplier (mig 0154) — independent axis from source. Manifest
          // hits are Wayfair returns, so stamp the supplier explicitly; other
          // lots use the session default.
          vendor: createVendor,
          // 0272: per-action idempotency token (see createLot header).
          clientToken,
          // 0269: hand the manifest row to the RPC so create is idempotent on
          // it and the pending->lotted flip is atomic. This kills the duplicate
          // "Not Put Away" pairs a double-fired create used to leave behind
          // (the old fire-and-forget mark_import_row_lotted call, removed below).
          importRowId: manifestRowId ?? null,
        });

        if (!out.ok) {
          // A definite answer from the server. Retrying would be refused the
          // same way, so stop tracking it rather than re-asking every launch.
          void resolvePendingLot(pendingId);
          // Plain cause first, then the server's own words. The report goes to
          // client_crash_reports.
          reportNonFatal(
            lotCreateFailureReport(out, {
              screen: '/lotting/quick',
              lottingMode,
              manifestMatch: isManifestMatch,
            }),
          );
          const { title: alertTitle, message: userMessage } = lotCreateUserMessage(out);
          Alert.alert(alertTitle, userMessage);
          // Surface the haptic for the failure but DON'T await it — same
          // perf reason as the success path.
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          return;
        }

        // ── Fast path: RPC committed. Update UI immediately. ────────────
        // Photo upload, stock photo mirroring, and catalog write-through
        // all run as fire-and-forget so the next scan is ready instantly.
        // The lot is already in Postgres with its scanned code; everything
        // after this point is enrichment that can fail silently without
        // affecting the user's primary action (scan → save → next).
        // Committed. The row is the record now; the queue entry is not needed.
        void resolvePendingLot(pendingId);

        const lotIdSnap = out.lotId;
        const lotCodeSnap = out.lotCode;
        const operatorIdSnap = operatorId;

        // 0269: remember this manifest box so a second (sequential) create for
        // the same import_row short-circuits at the guard above.
        if (manifestRowId) lottedManifestRowsRef.current.add(manifestRowId);

        // 0. Wayfair manifest flip (pending → lotted + lot back-link) now happens
        //    ATOMICALLY inside create_draft_lot (mig 0269) via the importRowId we
        //    passed above — no longer a separate fire-and-forget RPC. That race
        //    (create, then a non-atomic flip a beat later) was exactly what let a
        //    double-fired create re-match the still-'pending' row and mint an
        //    orphan twin. Nothing to do here anymore.

        // 1. Background mirror + product_lookups write-through. Hold the promise
        //    (not `void`) so the capture-upload block below can await it and be
        //    the LAST writer of photo_urls — enrich()'s stock-mirror write races
        //    the capture write and, landing last, wiped freshly-captured photos
        //    (staff report 2026-07-21, "the 2nd photo doesn't upload").
        const enrichPromise = out.enrich().catch(() => {});

        // 2. Success haptic — fire-and-forget; the buzz timing doesn't
        //    gate anything and awaiting it added tens of ms before this.
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

        // 3. Persistent clipboard: pushed to AsyncStorage via SessionContext
        //    so the operator can come back to Quick Lot later (or after a
        //    crash) and still see what they've been working on.
        // Option B: in Pre-stickered mode the scanned non-UUID code IS the BRN
        // bound to this lot. Generate mode + UUID-QR lots have no label yet.
        // Shared by the recent strip and the "Created —" banner so the two can
        // never disagree about what this box is called.
        const stickerSnap =
          lottingMode !== 'generate' &&
          !extractTokenFromScan(code) &&
          looksLikePhysicalSticker(code)
            ? code
            : null;

        pushRecentLot({
          lotId: lotIdSnap,
          lotCode: lotCodeSnap,
          externalCode: code,
          title: candidate.title,
          sticker: stickerSnap,
          ...(activeLotSource(session) ? { source: activeLotSource(session) } : {}),
        });

        // 4. UI reset — camera ready for next scan. Toast shows the new
        //    lot code; photo issue starts null and will be set later only
        //    if the background upload fails fast enough to update before
        //    the dismiss timer fires.
        setJustCreatedCode(lotCodeSnap);
        setJustCreatedDisplayCode(
          lotDisplayCode({ lot_code: lotCodeSnap, sticker_code: stickerSnap }) ?? lotCodeSnap,
        );
        setJustCreatedLotId(lotIdSnap);
        lastCreatedLotIdRef.current = lotIdSnap;
        setJustCreatedPhotoIssue(null);
        setJustBoundSticker(false);
        setSessionCount((c) => c + 1);
        setManualCode('');
        setOverrideCondition(null);
        setConfirm(null);
        // Batch 3: clear the review card on a successful save (review-mode path).
        setReviewEditable(null);

        // 4b. Pre-stickered (Option B, single-scan) — the SAME scan that
        //     created this lot IS the sticker, so bind it inline (no second
        //     scan). bindStickerToLot routes by value (UUID → qr_token; any
        //     other code → sticker_code). We do NOT auto-bind a Wayfair
        //     manifest-tracking scan (that's a shipping label, not the lot's
        //     sticker) — and if the inline bind fails for any reason we fall
        //     back to the PreStickeredScanner modal so the operator can scan
        //     or fix the sticker by hand.
        if (lottingMode !== 'generate') {
          // Only a scan that LOOKS like a physical label auto-binds. Free
          // text (name search / web lookup) falls through to the scanner
          // below — the normal pre-sticker step the tester expected.
          // The sticker the plan settled on before the save: the creating scan
          // itself, or the one the capture scanner returned. '' only after a
          // manager chose to save without one.
          const stickerValue = stickerFromPlan;
          if (stickerValue) {
            // NOT awaited (2026-10-08): the save is done once the lot exists.
            // Awaiting this kept `creating` up, the camera off and the next
            // scan locked for as long as bad wifi held the request. The bind
            // is time-boxed; a network failure is kept on the phone and
            // retried (stickerBindRunner), a refusal comes back here.
            void bindStickerAfterSave({
              lotId: lotIdSnap,
              lotCode: lotCodeSnap,
              sticker: stickerValue,
            }).then((outcome) => {
              if (outcome.kind === 'bound') {
                // Only relabel the toast if it still shows this lot.
                if (lastCreatedLotIdRef.current === lotIdSnap) setJustBoundSticker(true);
                return;
              }
              if (outcome.kind !== 'refused') return;
              // QR-2 fix: a bind ATTEMPT failed (e.g. the sticker is already
              // on another lot). Silently opening the scanner here made a
              // failed bind look like success and left sticker_code NULL —
              // the lot then dead-ended at "Lot not found" during put-away.
              // SURFACE the reason so the operator knows the sticker did NOT
              // bind, then open the scanner so they can fix it.
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              Alert.alert(
                'Sticker not bound',
                `${stickerRefusalCopy(outcome.reason)}\n\nLot ${lotCodeSnap} was created, but the sticker is NOT attached yet. Scan a sticker to finish, or skip.`,
                [{ text: 'Scan sticker' }],
              );
              setPendingSticker({ lotId: lotIdSnap, lotCode: lotCodeSnap });
            });
          } else {
            // No sticker was scanned in this single-scan path (e.g. a manifest
            // row, where the scanned value is a manifest key, not the sticker).
            // Open the scanner so the operator can scan the physical sticker.
            setPendingSticker({ lotId: lotIdSnap, lotCode: lotCodeSnap });
          }
        }

        // 5. Background photo upload (if any were captured). Pre-2026-05-21
        //    this awaited before the UI reset, adding 1-3s to perceived
        //    save time. Now it runs after the UI is responsive; failure
        //    is best-effort — operator can retry from Inventory if a
        //    photo upload silently fails (the lot itself is safe).
        //    B1: normalize the arg to an array so the multi-photo
        //    CameraCaptureSheet flow and the legacy single-uri callers share
        //    one upload path. Uploads happen in parallel; the final
        //    photo_urls preserves capture order (hero = index 0) by mapping
        //    settled results back to their original slot.
        const photoUrisArr = Array.isArray(photoUris) ? photoUris : photoUris ? [photoUris] : [];
        // PHOTO-1: the candidate's stock photos to keep when captures are
        // appended. Filter to https (the only scheme that survives
        // filterSafeImageUrls / renders) so a stray file:// can't slip in, and
        // snapshot before the awaits below.
        const stockUrlsSnap = (existingStockUrls ?? []).filter((u) =>
          /^https:\/\//i.test(u.trim()),
        );
        if (photoUrisArr.length > 0) {
          void (async () => {
            try {
              // Match the lot-photos RLS policy (0004 / 0028): first
              // folder segment must equal current_operator_id()::text. A
              // per-index suffix keeps multi-photo paths unique within the
              // same millisecond.
              const baseTs = Date.now();
              const uploads = await Promise.allSettled(
                photoUrisArr.map((uri, i) =>
                  uploadImageFromUri(
                    'lot-photos',
                    `${operatorIdSnap}/${lotCodeSnap}/${baseTs}-${i}.jpg`,
                    uri,
                    { contentType: 'image/jpeg', upsert: false },
                  ),
                ),
              );
              const capturedUrls = uploads
                .map((r) => (r.status === 'fulfilled' && r.value.ok ? r.value.url : null))
                .filter((u): u is string => u !== null);
              if (capturedUrls.length === 0 && stockUrlsSnap.length === 0) {
                // Surface the first failure reason; if the toast already
                // dismissed this is a no-op.
                const firstFail = uploads.find((r) => r.status === 'fulfilled' && !r.value.ok);
                const reason =
                  firstFail && firstFail.status === 'fulfilled' && !firstFail.value.ok
                    ? firstFail.value.reason
                    : 'photo upload failed';
                setJustCreatedPhotoIssue(reason);
                return;
              }
              if (capturedUrls.length < photoUrisArr.length) {
                setJustCreatedPhotoIssue(
                  `${photoUrisArr.length - capturedUrls.length} of ${photoUrisArr.length} photos failed to upload`,
                );
              }
              // PHOTO-1 union, race-safe (2026-07-21). enrich() mirrors the
              // remote stock images over the network and usually lands AFTER this
              // capture upload; the old blind overwrite here raced it and, when
              // enrich won, wiped the freshly-captured shots. Wait for enrich
              // first (bounded, so a hung mirror can't strand the write), then
              // union the captures onto whatever it left (the mirrored stock),
              // making this the deterministic last writer. The 0279 trigger
              // dedups; we also dedup here so the hero isn't doubled. Fall back to
              // the stock snapshot if the re-read fails.
              await Promise.race([
                enrichPromise,
                new Promise((resolve) => setTimeout(resolve, 12_000)),
              ]);
              const { data: cur } = await supabase
                .from('lots')
                .select('photo_urls')
                .eq('id', lotIdSnap)
                .maybeSingle();
              const currentUrls = (cur?.photo_urls as string[] | null) ?? stockUrlsSnap;
              const mergedUrls = [...currentUrls, ...capturedUrls].filter(
                (u, i, arr) => arr.indexOf(u) === i,
              );
              const { error: updateErr } = await supabase
                .from('lots')
                .update({ photo_urls: mergedUrls })
                .eq('id', lotIdSnap);
              if (updateErr) {
                setJustCreatedPhotoIssue(
                  `saved photo, but couldn't link it: ${updateErr.message.slice(0, 60)}`,
                );
              }
            } catch (err) {
              setJustCreatedPhotoIssue((err as Error).message?.slice(0, 80) ?? 'unknown');
            }
          })();
        }

        // 5b. Review-path relocate. The review/create path (overrideCandidate)
        //     runs uploadPendingPhotos BEFORE the lot exists, so its photos
        //     landed under {operatorId}/_pending/. Now that the lot_code
        //     exists, best-effort COPY those _pending objects into the lot's
        //     own {lotCode}/ folder and repoint photo_urls. Fire-and-forget +
        //     COPY (not move) so a failure can never break a working
        //     photo_url. No-ops for non-review paths (their photos already
        //     live under {lotCode}/, so there are no _pending URLs to move).
        if (overrideCandidate) {
          void relocatePendingLotPhotos(
            supabase,
            lotIdSnap,
            operatorIdSnap,
            lotCodeSnap,
            overrideCandidate.stockPhotos,
          );
        }

        // 6. Auto-clear toast at 8s (was 3s). The toast now carries the
        //    scan-recovery actions ("Fix sticker/code", "Discard" —
        //    2026-07-08), so staff need a realistic window to notice a
        //    mis-scan and tap. A new scan replaces the toast immediately,
        //    so the longer dwell never blocks the next item.
        if (justCreatedToastTimerRef.current) clearTimeout(justCreatedToastTimerRef.current);
        justCreatedToastTimerRef.current = setTimeout(() => {
          justCreatedToastTimerRef.current = null;
          setJustCreatedCode(null);
          setJustCreatedDisplayCode(null);
          setJustCreatedLotId(null);
          setJustCreatedPhotoIssue(null);
          setJustBoundSticker(false);
        }, 8000);
      } catch (err) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        // Duplicate-lot fix (staff report 2026-07-10): a "failed" create can
        // have COMMITTED server-side (response lost to a network blip). The
        // confirmation card used to stay up here, so one more tap minted a
        // SECOND lot code for the same physical item — and nothing dedups
        // UPCs by design (mig 0058: identical items are legit). Treat the
        // outcome as unknown: clear the card and make staff re-scan, which
        // surfaces the first lot if it actually saved.
        setConfirm(null);
        Alert.alert(
          "Couldn't create lot",
          `${(err as Error).message}\n\nIf this item may have saved anyway, re-scan it — don't create again blind (that's how one item gets two lot codes).`,
        );
      } finally {
        setCreating(false);
        barcodeLockRef.current = false;
        // Release the mutex AFTER all state has been updated, so the next
        // call sees the cleared state and a fresh lock to acquire.
        creatingLockRef.current = false;
        // Wayfair: clear the manifest pointer so the next (non-manifest) scan
        // doesn't inherit it.
        pendingManifestRowIdRef.current = null;
      }
    },
    // `creating` removed from deps — the guard is now the ref, not state.
    // Including it in deps would re-create createLot on every flip of the
    // spinner, defeating the stable-callback purpose of useCallback.
    [role, activeCondition, activeStartBid, session, pushRecentLot, lottingMode],
  );

  // ── Start confirmation flow ────────────────────────────────────────────────
  //
  // Called after the lookup resolves. If takePhotoAfterScan is ON we
  // show the confirmation with photo buttons (no auto-timer). If OFF we
  // show the confirmation card with a 2-second auto-create countdown.

  const startConfirmation = useCallback(
    (
      code: string,
      candidate: LotCandidate | null,
      isManifest = false,
      nonUpc = false,
      // False for a hand-typed code — see processCode's `source`. Scanning
      // keeps the 2-second auto-create (hands full, eyes on the box); typing
      // does not (the operator is already looking at the screen, and the
      // countdown only takes the decision away from them).
      autoCreate = true,
    ) => {
      // Clear any previous timers
      if (autoCreateTimer.current) clearTimeout(autoCreateTimer.current);
      if (countdownInterval.current) clearInterval(countdownInterval.current);

      // 0272: mint one idempotency token per confirmation (per intended lot).
      // Every createLot path for THIS confirmation (auto-timer, tap-to-skip,
      // manual submit, review-card save) reuses it, so a double-fire converges
      // on one lot server-side.
      pendingClientTokenRef.current = Crypto.randomUUID();

      const awaitingPhoto = session.takePhotoAfterScan;

      // B2: a no-match is now an explicit choice in BOTH modes — never an
      // auto-synthesized bare lot. Previously Pre-stickered mode silently
      // synthesized a "Quick lot — <barcode>" candidate and auto-saved it on
      // the 2s timer, so a mis-scan or an unrecognised code became a junk
      // lot with no operator decision. Now every miss surfaces the
      // "No Match Found" picker (Scan Another Item / Create Custom Listing).
      // The scanned code still binds to the lot as a sticker via the
      // prefilledSticker hand-off into manual.tsx, so put-away never
      // dead-ends.
      const effectiveCandidate = candidate;

      // No-match path: suppress the auto-create countdown so the operator
      // chooses explicitly.
      const noMatch = effectiveCandidate === null;

      // Batch 3 — Review before save (opt-in, default OFF). When ON and the
      // candidate MATCHED (catalog or manifest), skip the 2s auto-create and
      // open a full editable review card instead. The OFF path below is left
      // byte-for-byte unchanged so rapid-fire stays <2s. The no-match path is
      // unaffected (it already suppresses the timer + shows its own picker).
      const reviewMatched = session.reviewBeforeSave && !noMatch;

      setConfirm({
        code,
        candidate: effectiveCandidate,
        remainingMs: 2000,
        // PHOTO-1 fix: a no-match never has a photo step. Otherwise honour the
        // takePhotoAfterScan toggle EVEN when reviewBeforeSave is also ON — the
        // prior `reviewMatched ? false` forced the photo step off, so a matched
        // lot in review-mode jumped straight to the review card and the
        // captured photo was skipped. Now the order is scan → match → photo →
        // review → save: the photo row renders first (reviewEditable stays
        // null below), and the review card opens after the photo step via
        // openReviewFromPhoto.
        awaitingPhoto: noMatch ? false : awaitingPhoto,
        isManifest,
        nonUpc,
      });

      if (reviewMatched && effectiveCandidate) {
        // Seed the editable card from the matched candidate + session
        // defaults (same helper scan.tsx uses). No timer scheduled — the
        // operator saves explicitly via the review card's Save Lot button.
        //
        // upc seeding mirrors the non-review save derivation so the
        // external_code invariant is identical to auto-save:
        //   - manifest match → keep candidate.upc verbatim (the manifest's,
        //     usually empty for Wayfair) so the scanned FedEx tracking never
        //     becomes external_code.
        //   - catalog match → candidate.upc || code, matching
        //     makeQuickCandidate (scanned code resolves at intake).
        //
        // PHOTO-1: when a photo step is also pending (awaitingPhoto), DON'T
        // open the review card yet — leaving reviewEditable null lets the
        // ConfirmationCard's "Take photo / Skip" row render. openReviewFromPhoto
        // (called from onCameraConfirm / the Skip handler) seeds the review
        // card afterwards, merging any captured shot into stockPhotos. Either
        // way no auto-create timer is scheduled (we return before that block).
        if (!awaitingPhoto) {
          const seedUpc = isManifest ? effectiveCandidate.upc : effectiveCandidate.upc || code;
          setReviewEditable(
            candidateToEditable(
              { ...effectiveCandidate, upc: seedUpc },
              {
                defaultCondition: activeCondition,
                defaultStartBid: activeStartBid,
              },
            ),
          );
        }
        return;
      }

      if (!awaitingPhoto && !noMatch && !autoCreate) {
        // Typed by hand: show the match and wait. No countdown, no auto-save,
        // and the same outcome whichever control submitted it.
        return;
      }

      if (!awaitingPhoto && !noMatch) {
        // Auto-create after 2 seconds; countdown updates every 100ms for UX.
        // Note: the timer is paused while the user is interacting with the
        // manual code input below — see pauseAutoCreate / resumeAutoCreate
        // wired to that input's focus/blur. Without that, a user who scanned
        // an item and immediately tapped the manual input to add a second
        // would lose the first to the background timer. The card now stays
        // visible until the user explicitly resolves it (tap to skip or
        // tap Discard).
        //
        // Mark the confirmation as genuinely armed. Only a confirmation that
        // reaches HERE may ever be resumed; see resumeAutoCreate.
        setConfirm((prev) => (prev ? { ...prev, autoCreateArmed: true } : prev));
        countdownInterval.current = setInterval(() => {
          setConfirm((prev) => {
            if (!prev) return prev;
            const next = prev.remainingMs - 100;
            return { ...prev, remainingMs: Math.max(0, next) };
          });
        }, 100);

        autoCreateTimer.current = setTimeout(() => {
          if (countdownInterval.current) clearInterval(countdownInterval.current);
          void createLot(code, effectiveCandidate);
        }, 2000);
      }
    },
    [
      session.takePhotoAfterScan,
      session.reviewBeforeSave,
      activeCondition,
      activeStartBid,
      createLot,
      lottingMode,
    ],
  );

  // Pause / resume the auto-create timer. Used when the manual input gets
  // focus so a typing operator doesn't lose the pending scanned lot to the
  // background countdown. Resume restarts the 2-second clock from where it
  // was paused — operator can keep typing as long as they want; the lot
  // sits patiently.
  const pauseAutoCreate = useCallback(() => {
    if (autoCreateTimer.current) {
      clearTimeout(autoCreateTimer.current);
      autoCreateTimer.current = null;
    }
    if (countdownInterval.current) {
      clearInterval(countdownInterval.current);
      countdownInterval.current = null;
    }
  }, []);
  const resumeAutoCreate = useCallback(() => {
    setConfirm((prev) => {
      if (!prev || prev.awaitingPhoto || prev.remainingMs <= 0) return prev;
      // Reported 2026-08-20 (staff member): "when you go to search something up and
      // it doesn't pull any information it will automatically take you to go
      // scan a sticker... it creates a quick lot and we have to go back into
      // our inventory and delete it."
      //
      // A no-match confirmation is created with remainingMs 2000 and no timer
      // — startConfirmation returns before arming one, on purpose, so the
      // operator has to choose from the No Match Found picker. Nothing ever
      // decrements remainingMs in that state, so the guard above always
      // passed and this function armed a countdown that had never run. Two
      // seconds after the manual code field lost focus, createLot fired with
      // a null candidate and minted "Quick lot — <code>"; because a typed
      // code never looks like a physical sticker, the pre-stickered scanner
      // then opened on a lot nobody asked for. 39 such lots since 2026-08-03,
      // all but two later canceled by hand.
      //
      // The same hole swallowed hand-typed MATCHES (autoCreate false), which
      // are also deliberately timer-less: a blur saved the lookup before the
      // operator had approved it.
      if (!prev.autoCreateArmed) return prev;
      // Restart the countdown + auto-create from current remainingMs.
      const remaining = prev.remainingMs;
      countdownInterval.current = setInterval(() => {
        setConfirm((p) => {
          if (!p) return p;
          const next = p.remainingMs - 100;
          return { ...p, remainingMs: Math.max(0, next) };
        });
      }, 100);
      autoCreateTimer.current = setTimeout(() => {
        if (countdownInterval.current) clearInterval(countdownInterval.current);
        // Re-read the current confirm in case the user discarded mid-pause.
        setConfirm((p) => {
          if (p) void createLot(p.code, p.candidate);
          return p;
        });
      }, remaining);
      return prev;
    });
  }, [createLot]);

  // Discard a pending confirmation without creating. Used by the new
  // "Discard" button on the confirmation card.
  const discardConfirmation = useCallback(() => {
    pauseAutoCreate();
    setConfirm(null);
    // Batch 3: also drop any open review card so the camera resumes cleanly.
    setReviewEditable(null);
    barcodeLockRef.current = false;
    // SCAN-1: a fresh scan after a discard must start from a clean hold streak
    // and no stale tap-to-select overlays.
    resetHoldConfirm(holdConfirmRef.current);
    setInFrameCodes([]);
  }, [pauseAutoCreate]);

  // QuickLot inline enrichment: when the operator returns from the web-lookup
  // screen opened in mode=enrich, pull the scraped/edited fields it stashed and
  // merge them into the review candidate so the item saves as ONE lot (no
  // duplicate, no extra sticker). Read-and-clear so a stale payload is never
  // applied twice; the scraped photo goes first, existing photos follow.
  useFocusEffect(
    useCallback(() => {
      const payload = enrichReturnRef.current;
      if (!payload) return;
      enrichReturnRef.current = null;
      setReviewEditable((prev) => {
        const base =
          prev ??
          candidateToEditable(confirm?.candidate ?? {}, {
            defaultCondition: session.defaultCondition,
            defaultStartBid: session.defaultStartBid,
          });
        const scraped = [...(payload.photoUrl ? [payload.photoUrl] : []), ...payload.extraPhotoUrls]
          .map((u) => u.trim())
          .filter(Boolean);
        // #6 (2026-07-21 "saving a pic from Amazon backs all the way out"):
        // dedup + CAP the scraped set. When Amazon blocks the direct read the
        // AI web-search fallback returns remote image URLs, and additional_*
        // is unbounded and repeats the hero. The review card decodes each and
        // the on-device mirror fetches each full image into memory (~10MB), so
        // an uncapped merge OOM-crashes the app on a warehouse tablet and drops
        // the whole in-progress lot. Bound the (remote, memory-heavy) scraped
        // images; staff captures in `existing` are local and kept in full.
        const MAX_SCRAPED_PHOTOS = 6;
        const scrapedCapped = Array.from(new Set(scraped)).slice(0, MAX_SCRAPED_PHOTOS);
        const existing = base.stockPhotos.filter((u) => !scrapedCapped.includes(u));
        return {
          ...base,
          title: payload.title || base.title,
          msrpDollars: payload.msrpDollars || base.msrpDollars,
          description: payload.description || base.description,
          condition: payload.condition || base.condition,
          stockPhotos: [...scrapedCapped, ...existing],
        };
      });
    }, [confirm, session.defaultCondition, session.defaultStartBid]),
  );

  // ── Lookup code → confirmation ─────────────────────────────────────────────

  const processCode = useCallback(
    async (
      rawCode: string,
      symbology: Symbology = 'unknown',
      // 'manual' = the operator typed it, by either control below. Reported
      // 2026-08-20 (staff member): "if you click lot it then it makes you lot it. But
      // if you click the check mark then it searches for it." Both controls
      // always ran the same code; what differed was whether the text field
      // still held focus, because focus pauses the 2-second auto-create. Same
      // tap, two outcomes, depending on something invisible.
      //
      // A typed code is deliberate and the operator is already looking at the
      // screen, so the countdown buys nothing there — it only takes the
      // decision away. Scanning keeps it: that is the hands-full case the
      // timer was built for.
      source: 'scan' | 'manual' = 'scan',
    ) => {
      const code = rawCode.trim().replace(/[\s]/g, '');
      if (!code || !VALID_CODE_RE.test(code)) return;
      if (role.kind !== 'staff') {
        // Fail open on a transient role downgrade (token refresh / network
        // blip). processCode only does catalog/manifest lookups — no
        // operatorId needed — so with a live local session we proceed and
        // let createLot do the authoritative staff check at save time.
        const { data: sessionData } = await supabase.auth.getSession();
        if (!sessionData.session) {
          Alert.alert('Not signed in as staff');
          return;
        }
      }
      if (looking || creating) return;
      // R3: while a confirmation card is up (camera scan in flight, 2-second
      // countdown), refuse to start a new lookup. Otherwise the user could
      // type a different code in the manual field, hit "Lot it", and the
      // pending lot would be silently overwritten — startConfirmation clears
      // the timer that was about to create it. Camera scan is already gated
      // via the `confirm !== null` check on onBarcodeScanned, but the
      // manual input hadn't been gated. This closes that gap.
      if (confirm !== null) return;

      // Reset any stale manifest pointer from a prior (discarded) scan.
      pendingManifestRowIdRef.current = null;

      setLooking(true);
      try {
        // Manifest lookup FIRST: expand the raw scan into format-specific
        // candidates (e.g. SSCC-22 last-12, EAN-13→UPC-12, FNSKU shape),
        // then probe all pending import_rows in one RPC call. Misses fast
        // for non-manifest codes (operator-scoped, indexed) and falls
        // through to the catalog below.
        try {
          let { candidates } = extractScanCandidates(code, symbology);
          // 2026-07-10 (staff: "same 5 FedEx labels won't scan"): a FedEx
          // label carries a big 2D block (PDF417/DataMatrix) ABOVE the 1D
          // barcode, and the camera often decodes that one — its ANSI payload
          // embeds the 12-digit tracking as an interior field, so neither the
          // suffix expansion here nor the server's right-N covers it. Harvest
          // every long digit run (+ its right-12) as extra candidates. Safe:
          // digit-suffix variants only ever probe tracking_number server-side.
          for (const run of code.match(/\d{12,}/g) ?? []) {
            for (const c of [run, run.slice(-12)]) {
              if (!candidates.includes(c)) candidates = [...candidates, c];
            }
          }
          // D.1: scope the manifest probe to the operator's chosen field type
          // (mig 0190). ScanFieldKind values are identical to the RPC's p_kind
          // strings, so the session pref passes straight through. 'auto' (the
          // default) preserves the original multi-column probe behaviour.
          // supabase-js RESOLVES on a Postgres error — it does not throw — so
          // discarding `error` here meant the 8s statement_timeout on
          // find_import_row_by_scan (it seq-scans 242k import_rows) reached
          // staff as a plain "no manifest match" after an 8s stall. The catch
          // below never fired. Log it so the failure is visible.
          const { data: mres, error: mErr } = await supabase.rpc('find_import_row_by_scan', {
            p_candidates: candidates,
            p_kind: session.scanFieldKind,
          });
          if (mErr) console.warn('[quick] manifest probe failed:', mErr.message);
          let m = mres as { ok?: boolean; manifest_row?: Record<string, unknown> } | null;
          // Staff report 2026-07-10: FedEx labels verified IN the pool came
          // back "no match" — the scan-field chip was pinned to a specific
          // column (it persists across screens/reloads), so a tracking scan
          // probed e.g. `upc` only. A scoped probe stays first (it exists to
          // beat cross-column collisions), but on a MISS we retry wide-open
          // so a stale chip can never hide a real manifest row.
          if (!(m?.ok && m.manifest_row?.id) && session.scanFieldKind !== 'auto') {
            const { data: retry, error: retryErr } = await supabase.rpc('find_import_row_by_scan', {
              p_candidates: candidates,
              p_kind: 'auto',
            });
            if (retryErr) console.warn('[quick] manifest retry failed:', retryErr.message);
            m = retry as typeof m;
          }
          if (m?.ok && m.manifest_row && m.manifest_row.id) {
            pendingManifestRowIdRef.current = String(m.manifest_row.id);
            const manifestCand = buildManifestCandidate(m.manifest_row);
            // PHOTO-2 (manifest): Wayfair rows whose ImageURL is "NA"/missing
            // reach the review card photo-less. When the row carries a real UPC,
            // resolve a stock image from the catalog (free). NEVER pass `code` —
            // that's the scanned tracking number, not a product identifier.
            const withPhoto = await withResolvedStockPhotos(manifestCand, {
              upc: manifestCand.upc,
            });
            startConfirmation(code, withPhoto, true, false, source !== 'manual');
            return;
          }
        } catch {
          // Manifest lookup failed (network/etc.) — fall through to the catalog.
        }

        // A non-UPC code (FNSKU / ASIN / LPN / roll-label) that missed the
        // manifest is a REAL no-match — it must not reach the catalog/web
        // lookup. That path treats the scanned code as a product identifier and
        // a web search returns confident WRONG data: on 2026-09-21 the FNSKU
        // X004Z9D5K5 (a handheld fan) came back "New Balance 574, $99.99" and
        // was auto-creating in 2s. X004Z9D5K5 is in neither the manifest nor
        // product_lookups — the match was invented. These codes have no meaning
        // outside our own manifest, so a manifest miss stops here: no web
        // lookup, no auto-create, an explicit No-Match picker for the operator.
        // (Numeric UPC/EAN misses still fall through — the catalog is the right
        // answer for a real product barcode not on this manifest.)
        if (isNonUpcCode(code, symbology)) {
          startConfirmation(code, null, false, true, source !== 'manual');
          return;
        }

        // lookupCodeWithMeta also pushes a CostEvent to the ring buffer.
        // fast: cache-only. Until 2026-08-07 this blocked on the Sonar web
        // search (p50 2.6s / p95 6.1s) plus the Bright Data escalation before
        // the confirmation card could render, so the operator sat on
        // "Looking up…". scan-photo has deferred that since 2026-07-13 via
        // fastScan; the barcode path never opted in. The card now comes up on
        // cache data and the web rungs run BEHIND it (background pass below).
        const { candidate, cacheMiss } = await lookupCodeWithMeta(code, {
          fast: true,
        });
        // PHOTO-2: a catalog hit with no stock image reaches the review card
        // photo-less (Sonar rarely returns images). Resolve from the catalog
        // (free) before opening the card. Best-effort; unchanged on miss. The
        // scanned code doubles as the UPC for catalog hits, matching
        // makeQuickCandidate's upc derivation.
        const withPhoto = await withResolvedStockPhotos(candidate, {
          upc: candidate?.upc || code,
          asin: candidate?.asin,
        });
        // C2/C3: flag non-product codes (FNSKU/ASIN/LPN/roll-label) so a
        // no-match promotes the AI photo-identify path (the only way to
        // identify them). Harmless on a catalog hit (ignored when matched).
        startConfirmation(
          code,
          withPhoto,
          false,
          isNonUpcCode(code, symbology),
          source !== 'manual',
        );

        // `cacheMiss` means the fast path SKIPPED the web rungs rather than
        // trying and failing them — so run the full lookup off the critical
        // path and merge the result into the card that is already open.
        //
        // The auto-create timer is paused while that runs, so a thin
        // cache-level candidate can never be committed in place of what the
        // old blocking call would have found: time-to-commit is unchanged,
        // only the operator's wait is gone. Tap-to-skip still commits early.
        //
        // Pause ONLY when a timer is actually running. startConfirmation sets
        // remainingMs: 2000 even on a no-match (where it deliberately
        // schedules nothing — B2: "a no-match is never an auto-synthesized
        // bare lot"), and resumeAutoCreate guards only on awaitingPhoto and
        // remainingMs, so resuming blind would CREATE the auto-create B2
        // removed.
        if (cacheMiss) {
          const timerRunning =
            withPhoto !== null && !session.takePhotoAfterScan && !session.reviewBeforeSave;
          if (timerRunning) pauseAutoCreate();
          void (async () => {
            try {
              const { candidate: full } = await lookupCodeWithMeta(code);
              if (full) {
                const fullWithPhoto = await withResolvedStockPhotos(full, {
                  upc: full.upc || code,
                  asin: full.asin,
                });
                setConfirm((prev) =>
                  prev && prev.code === code ? { ...prev, candidate: fullWithPhoto } : prev,
                );
              }
            } catch {
              // Keep the cache-level candidate; this is strictly additive.
            } finally {
              if (timerRunning) resumeAutoCreate();
            }
          })();
        }
      } catch {
        // Network/proxy error — still create with no catalog data. Carry the
        // same non-UPC flag so the no-match card promotes photo-identify.
        startConfirmation(code, null, false, isNonUpcCode(code, symbology), source !== 'manual');
      } finally {
        setLooking(false);
      }
    },
    [
      role,
      looking,
      creating,
      confirm,
      startConfirmation,
      session.scanFieldKind,
      session.takePhotoAfterScan,
      session.reviewBeforeSave,
      pauseAutoCreate,
      resumeAutoCreate,
    ],
  );

  // ── Immediate confirm tap (skip the 2-second wait) ────────────────────────

  const skipAndCreate = useCallback(() => {
    if (!confirm) return;
    // R4.1: defer the creating-vs-not check to createLot's ref guard so
    // the timer-vs-tap race resolves to a single insert. Locally we just
    // clear the timers and dispatch — createLot will silently no-op if
    // it was already started by the auto-create timer microseconds prior.
    if (autoCreateTimer.current) clearTimeout(autoCreateTimer.current);
    if (countdownInterval.current) clearInterval(countdownInterval.current);
    void createLot(confirm.code, confirm.candidate);
  }, [confirm, createLot]);

  // ── Photo capture for takePhotoAfterScan ──────────────────────────────────

  // Photo capture for "Take photo after scan" flow. Before this commit
  // there were TWO silent fallthroughs that made the toggle feel broken:
  //   (a) cameraRef.current null → create without photo, no warning
  //   (b) catch block → create without photo, no warning
  // Both surface as "I tapped Add photo but the lot got saved without
  // one" which the operator reads as "the toggle isn't pausing." Now
  // we keep the confirmation card open with a user-visible warning so
  // they can either retry capturing or explicitly tap Skip.
  const [photoError, setPhotoError] = useState<string | null>(null);
  // B1: drives the shared CameraCaptureSheet. When the operator taps
  // "Take photo" on the awaiting-photo confirmation card, we open the sheet
  // (live viewfinder + real shutter) instead of firing a blind one-shot
  // capture. The fast path (takePhotoAfterScan OFF) never opens this — it
  // creates the lot with no photo, preserving sub-2s scanning.
  const [cameraSheetOpen, setCameraSheetOpen] = useState(false);
  // PHOTO-1: distinguishes the two ways the capture sheet is opened:
  //   - 'awaiting'  : the takePhotoAfterScan path (no lot yet, no stock to
  //                   keep). Confirm → createLot(captures only).
  //   - 'mergeMatch': the matched-confirmation "Add BinGo Auctions photo" path. The
  //                   sheet is seeded with the matched candidate's stock photos
  //                   so the operator sees them; on confirm we split the
  //                   returned list into stock (https, kept) + captures
  //                   (file://, uploaded) and createLot MERGES them.
  const [photoSheetMode, setPhotoSheetMode] = useState<'awaiting' | 'mergeMatch'>('awaiting');
  const captureAndCreate = useCallback(() => {
    if (!confirm || creating) return;
    setPhotoError(null);
    setPhotoSheetMode('awaiting');
    setCameraSheetOpen(true);
  }, [confirm, creating]);

  // PHOTO-1: open the capture sheet for a MATCHED candidate to add a real
  // BinGo Auctions photo alongside its stock photos. Pauses the 2s auto-create so the
  // lot doesn't save out from under the operator while the camera is up.
  const captureForMatch = useCallback(() => {
    if (!confirm || creating) return;
    pauseAutoCreate();
    setPhotoError(null);
    setPhotoSheetMode('mergeMatch');
    setCameraSheetOpen(true);
  }, [confirm, creating, pauseAutoCreate]);

  // PHOTO-1 (review + photo both ON): the photo step is done — open the review
  // card seeded from the matched candidate, merging any freshly-captured shot
  // into stockPhotos (stock first, captures appended, mirroring the union save
  // order). The review card's Save path already uploads file:// stockPhotos via
  // uploadPendingPhotos before persisting, so captures ride that channel. upc
  // seeding matches startConfirmation's review-immediate path exactly. No timer
  // is running (the reviewMatched branch returned before scheduling one).
  const openReviewFromPhoto = useCallback(
    (captures: string[]) => {
      setCameraSheetOpen(false);
      if (!confirm || !confirm.candidate) return;
      const cand = confirm.candidate;
      const seedUpc = confirm.isManifest ? cand.upc : cand.upc || confirm.code;
      const stock = (cand.stockPhotos ?? []).filter((u) => /^https:\/\//i.test(u.trim()));
      const cleanCaptures = captures.map((u) => u.trim()).filter(Boolean);
      // Warm the compression pipeline for each capture (best-effort, not awaited
      // — the upload-on-save path handles raw URIs too).
      for (const uri of cleanCaptures) void compressForVision(uri).catch(() => undefined);
      setReviewEditable(
        candidateToEditable(
          { ...cand, upc: seedUpc, stockPhotos: [...stock, ...cleanCaptures] },
          {
            defaultCondition: activeCondition,
            defaultStartBid: activeStartBid,
          },
        ),
      );
    },
    [confirm, activeCondition, activeStartBid],
  );

  // B1 / PHOTO-1: the operator confirmed photos in the sheet.
  //   awaiting  → createLot(captures) — captures become photo_urls.
  //               (review ON) → openReviewFromPhoto(captures) instead, so the
  //               photo flows into the review card rather than saving directly.
  //   mergeMatch→ split URIs by scheme: https stock URLs are passed as
  //               existingStockUrls (kept, hero preserved) and the new file://
  //               captures are uploaded + appended (union save).
  // Best-effort compression warms the pipeline but isn't awaited (upload
  // handles raw URIs too).
  const onCameraConfirm = useCallback(
    async (uris: string[]) => {
      uris = await Promise.all(uris.map((u) => (/^https:\/\//i.test(u) ? u : persistPhoto(u))));
      setCameraSheetOpen(false);
      if (!confirm) return;
      if (photoSheetMode === 'mergeMatch') {
        const stock = uris.filter((u) => /^https:\/\//i.test(u.trim()));
        const captures = uris.filter((u) => !/^https:\/\//i.test(u.trim()));
        if (captures.length === 0) {
          // No new shot taken — keep the matched candidate's stock photos by
          // saving normally (the RPC already seeds them). Resume nothing; just
          // create with no extra captures so the stock photos persist as-is.
          void createLot(confirm.code, confirm.candidate);
          return;
        }
        for (const uri of captures) void compressForVision(uri).catch(() => undefined);
        void createLot(confirm.code, confirm.candidate, captures, undefined, stock);
        return;
      }
      // 'awaiting' mode (takePhotoAfterScan). When reviewBeforeSave is ALSO ON
      // and the lot matched, the photo step feeds the review card instead of
      // saving directly — scan → match → photo → review → save. (uris here are
      // the new captures; the awaiting sheet is seeded with no initialUris.)
      // An empty uris array (operator confirmed the sheet without a shot) still
      // advances to review with no added photo.
      if (session.reviewBeforeSave && confirm.candidate) {
        openReviewFromPhoto(uris);
        return;
      }
      if (uris.length === 0) {
        // Treated as Skip — create without a photo (preserve skip behavior).
        void createLot(confirm.code, confirm.candidate);
        return;
      }
      for (const uri of uris) void compressForVision(uri).catch(() => undefined);
      void createLot(confirm.code, confirm.candidate, uris);
    },
    [confirm, createLot, photoSheetMode, session.reviewBeforeSave, openReviewFromPhoto],
  );

  // PHOTO-1: "Skip" on the photo row. When reviewBeforeSave is ON and the lot
  // matched, skipping the photo still advances to the review card (with no
  // added photo) — review is the next required step. Otherwise (photo-only
  // mode, or a no-match) it creates the lot immediately, preserving the prior
  // Skip behavior exactly.
  const skipPhotoStep = useCallback(() => {
    if (!confirm) return;
    if (session.reviewBeforeSave && confirm.candidate) {
      openReviewFromPhoto([]);
      return;
    }
    void createLot(confirm.code, confirm.candidate);
  }, [confirm, session.reviewBeforeSave, openReviewFromPhoto, createLot]);

  // Clear photo error + close the sheet when the confirmation card resets so
  // they don't bleed across multiple scans.
  useEffect(() => {
    if (!confirm) {
      setPhotoError(null);
      setCameraSheetOpen(false);
    }
  }, [confirm]);

  // SCAN-1: whenever the code scanner is NOT actively reading (a confirmation
  // is up, we're busy, the capture sheet is open, or the sticker modal is up),
  // drop any tap-to-select overlays and reset the hold-to-confirm streak so the
  // next live scan starts clean. The scanner prop itself is already gated to
  // `confirm === null`, but the overlays/streak are local state that must be
  // cleared explicitly.
  useEffect(() => {
    // NOTE: reference looking/creating directly (not the `busy` const, which is
    // declared further down — referencing it here would hit the TDZ at render).
    const scanning =
      confirm === null &&
      !looking &&
      !creating &&
      !cameraSheetOpen &&
      !pendingSticker &&
      !captureSticker;
    if (!scanning) {
      resetHoldConfirm(holdConfirmRef.current);
      setInFrameCodes((prev) => (prev.length ? [] : prev));
    }
  }, [confirm, looking, creating, cameraSheetOpen, pendingSticker]);

  // ── AI identify on catalog miss ───────────────────────────────────────────
  //
  // When the scanned code (UPC/ASIN/FNSKU) doesn't match the catalog —
  // common for Amazon FNSKUs which aren't in any of our identifier
  // columns — offer to identify with AI using a fresh camera frame.
  // The AI scan returns title + brand + model + MSRP + stock images;
  // we merge that into the pending confirmation so the operator saves
  // a richer lot. Cost: ~$0.005 per call (Gemini Flash + cache lookup).
  //
  // Pauses the auto-create timer while running; on success the card
  // re-renders with the enriched candidate and the user taps to save.
  // On failure the card stays as-is (still showing "no match"); user
  // can save the bare lot or retry.
  const [aiBusy, setAiBusy] = useState(false);
  const identifyWithAI = useCallback(async () => {
    if (!confirm || aiBusy) return;
    if (!cameraRef.current) return;
    pauseAutoCreate();
    setAiBusy(true);
    try {
      const photo = await cameraRef.current.takePhoto({
        flash: safeFlash(device, 'auto'),
        ...TAKE_PHOTO_OPTIONS,
      });
      const uri = `file://${photo.path}`;
      // PERF (2026-05-21): pass photo dimensions so compressForVision
      // skips its dims-probe round-trip (saves 300-500ms per shot).
      const base64 = await compressForVision(uri, { width: photo.width, height: photo.height });
      if (!base64) throw new Error('Compression returned empty base64');
      const aiCandidate = await scanPhoto(base64, 'image/jpeg');
      if (!aiCandidate) {
        Alert.alert("AI couldn't identify it", 'Try a clearer angle or save without details.');
        // C2/C3 safety: on a MATCHED confirmation a 2s auto-create timer was
        // paused above, so resume it (the matched lot still saves on its own
        // unless the user discards). On a NO-MATCH (candidate === null) NO
        // timer was ever scheduled — calling resumeAutoCreate() would
        // spuriously start one and mint a bare "Quick lot — <code>"
        // placeholder. So leave the no-match picker up (no-op) and let the
        // operator choose explicitly.
        if (confirm.candidate !== null) resumeAutoCreate();
        return;
      }
      // Merge the AI result into the confirmation. Preserve the user's
      // scanned code as the primary identifier (`upc`/external_code) so
      // intake-scan keeps working with the original FNSKU, but adopt
      // every other field from AI (title, brand, model, msrp, photos).
      setConfirm((prev) => {
        if (!prev) return prev;
        const merged = {
          ...aiCandidate,
          // Re-anchor to the originally-scanned code. AI may have read
          // a UPC off the photo that's different — that's fine for
          // catalog purposes but external_code on the lot must stay
          // the operator-scanned one.
          upc: prev.code,
        };
        return { ...prev, candidate: merged };
      });
      // After enrichment, leave the auto-timer paused so the operator
      // can review the enriched details before tapping to save. They
      // can either tap the card or hit Discard.
    } catch (err) {
      // err may be a camera capture failure (takePhoto) or an AI/network
      // failure (scanPhoto). translateCaptureError maps known capture codes
      // to friendly copy and falls back to a generic retry line otherwise —
      // never the raw developer message.
      Alert.alert("Couldn't identify with AI", translateCaptureError(err));
      // C2/C3 safety: same as above — only resume the (paused) timer on a
      // matched confirmation. A no-match never scheduled one, so resuming
      // would spuriously create a bare placeholder lot. Leave the picker up.
      if (confirm.candidate !== null) resumeAutoCreate();
    } finally {
      setAiBusy(false);
    }
  }, [confirm, aiBusy, pauseAutoCreate, resumeAutoCreate, device]);

  // ── Barcode scan ─────────────────────────────────────────────────────────

  const onBarcodeScanned = useCallback(
    (scan: DecodedCode) => {
      if (barcodeLockRef.current || looking || creating) return;
      // Also bail when there's an active confirmation card — the JSX
      // used to gate this via the CameraView prop; in v5 the camera is
      // always streaming codes, so we check inside the callback.
      if (confirm !== null) return;
      const trimmed = scan.data.trim().replace(/[\s]/g, '');
      if (!VALID_CODE_RE.test(trimmed)) return;
      barcodeLockRef.current = true;
      void processCode(trimmed, scan.type as Symbology);
    },
    [looking, creating, confirm, processCode],
  );

  // SCAN-1 tap-to-select: operator tapped one of the in-frame code overlays.
  // Route that exact value through the same acceptance path as an auto-scan
  // (onBarcodeScanned re-checks the busy / confirm gates + the VALID_CODE_RE),
  // then clear the overlay and reset the hold streak. Depends on
  // onBarcodeScanned so it always invokes the current (non-stale) closure.
  const onSelectInFrameCode = useCallback(
    (picked: RankedCode) => {
      setInFrameCodes([]);
      resetHoldConfirm(holdConfirmRef.current);
      onBarcodeScanned({ data: picked.data, type: picked.type });
    },
    [onBarcodeScanned],
  );

  // ── Camera permission gate ────────────────────────────────────────────────

  if (!hasPermission) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg, padding: 24 }}>
        <Text style={{ color: colors.text, fontSize: 16, marginBottom: 16 }}>
          Camera access is required to scan codes.
        </Text>
        <Pressable
          onPress={requestPermission}
          style={{ padding: 16, backgroundColor: colors.primary, borderRadius: 12 }}
        >
          <Text style={{ color: '#000', textAlign: 'center', fontWeight: '800' }}>
            Allow camera
          </Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const cameraHeight = Math.round(SCREEN_W * 0.65);
  const busy = looking || creating;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header */}
      <View style={s.header}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.primary, fontSize: 16, fontWeight: '900' }}>Quick Lot</Text>
          <Text style={{ color: colors.textMuted, fontSize: 11 }}>
            {sessionCount} lots this run · scan{' '}
            {session.takePhotoAfterScan ? '+ photo' : '→ done in <2 s'}
          </Text>
          {/* Active-source badge: visible reminder of which truck every
              scanned lot is being tagged with. Tap → back to the LotTR
              hub to switch trucks. Hidden when no source set. */}
          {activeLotSource(session) ? (
            <Pressable onPress={() => router.back()} hitSlop={6} style={{ marginTop: 4 }}>
              <Text
                style={{
                  color: colors.primary,
                  fontSize: 11,
                  fontWeight: '800',
                }}
                numberOfLines={1}
              >
                📦 {activeLotSource(session)}
              </Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable onPress={exitToLotting} style={s.doneBtn} hitSlop={12}>
          <Text style={{ color: colors.textMuted, fontSize: 15, fontWeight: '700' }}>Done</Text>
        </Pressable>
      </View>

      {/* Collapsible lotting settings: the three per-session toggles are set
          once then just eat vertical space above the camera. Collapse them
          behind a live summary header so the scan screen stays focused; tap to
          expand and change mode / photo / review. */}
      <Pressable
        onPress={() => setSettingsOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={settingsOpen ? 'Hide lotting settings' : 'Show lotting settings'}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 10,
        }}
      >
        <Text
          style={{ color: colors.textMuted, fontSize: 12, fontWeight: '800' }}
          numberOfLines={1}
        >
          {settingsOpen
            ? 'Lotting settings'
            : `⚙ ${lottingMode === 'generate' ? 'Generate' : 'Pre-stickered'} · ${
                session.takePhotoAfterScan ? 'photo on' : 'photo off'
              } · ${session.reviewBeforeSave ? 'review on' : 'review off'}`}
        </Text>
        <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '800' }}>
          {settingsOpen ? 'Hide ⌃' : 'Edit ⌄'}
        </Text>
      </Pressable>
      {settingsOpen && (
        <>
          <LottingModeToggle disabled={busy} />
          <PhotoToggleRow
            value={session.takePhotoAfterScan}
            onChange={(v) => setSession({ takePhotoAfterScan: v })}
            disabled={busy}
          />
          <ReviewToggleRow
            value={session.reviewBeforeSave}
            onChange={(v) => setSession({ reviewBeforeSave: v })}
            disabled={busy}
          />
        </>
      )}

      <ScrollView
        contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: 80 }}
        keyboardShouldPersistTaps="handled"
        // C3 #8: drag anywhere on the list to dismiss the keyboard. Pairs
        // with the tap-to-dismiss on the camera viewfinder below so the
        // decimal-pad / code keyboards don't trap the operator.
        keyboardDismissMode="on-drag"
      >
        {/* ── Camera viewfinder ─────────────────────────────────────────── */}
        <View style={{ borderRadius: 14, overflow: 'hidden', height: cameraHeight }}>
          {!pendingSticker && !captureSticker && !cameraSettling && device ? (
            <Camera
              ref={cameraRef}
              style={{ flex: 1 }}
              device={device}
              // Fully unmount this camera when the pre-stickered scanner modal
              // is open. iOS cannot drive two AVCaptureSessions simultaneously;
              // the earlier approach of isActive=false kept the session alive
              // and still starved the modal scanner of frames. Unmounting
              // releases the hardware so PreStickeredScanner gets clean frames.
              // B1: also pause while the CameraCaptureSheet is open — iOS
              // can't drive two AVCaptureSessions at once, so the sheet's
              // own Camera needs this one to release the hardware.
              isActive={cameraGate && !cameraIdle && !busy && !cameraSheetOpen}
              photo={true}
              codeScanner={confirm === null ? codeScanner : undefined}
              torch={torchMode(torchOn)}
            />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              {!pendingSticker && <ActivityIndicator color={colors.primary} />}
            </View>
          )}
          <Pressable
            style={StyleSheet.absoluteFillObject}
            onPress={(e) => {
              // C3 #8: tapping the viewfinder both focuses the camera and
              // dismisses any open keyboard (decimal-pad / manual code), so
              // the operator can tap back to scanning without a stray Done bar.
              // Pass the gesture event through — focus.onTap reads
              // e.nativeEvent.locationX/Y to focus at the tapped point.
              Keyboard.dismiss();
              if (cameraIdle) setCameraIdle(false);
              bumpIdle();
              focus.onTap(e);
            }}
          />
          {/* Idle-pause cover — camera slept after IDLE_PAUSE_MS with no
              decoded frames. pointerEvents none: the Pressable above owns
              the tap and wakes it. */}
          {cameraIdle && (
            <View
              pointerEvents="none"
              style={{
                ...StyleSheet.absoluteFillObject,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'rgba(6, 10, 18, 0.92)',
                gap: 6,
              }}
            >
              <Text style={{ fontSize: 28 }}>🔋</Text>
              <Text style={{ color: colors.text, fontWeight: '800', fontSize: 15 }}>
                Camera paused to save battery
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 13 }}>Tap to resume scanning</Text>
            </View>
          )}
          <CameraFlashButton type="torch" on={torchOn} onChange={setTorchOn} device={device} />
          {focus.indicator}
          {/* Scan guide — the reticle is now a REAL region of interest (SCAN-1):
              centerMostCode only accepts a code whose frame-center falls inside
              the matching tolerance band, so this box reflects where the
              operator must place the product barcode. */}
          {!confirm && (
            <View
              pointerEvents="none"
              style={{
                ...StyleSheet.absoluteFillObject,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <View style={s.scanGuide} />
              <Text style={s.scanGuideHint}>Center the product barcode</Text>
              {scanHint !== '' && <Text style={s.scanDebug}>{scanHint}</Text>}
            </View>
          )}
          {/* SCAN-1 tap-to-select overlays: when 2+ codes are inside the
              reticle band we don't guess — the operator taps the one they
              mean. Positioned by each code's normalized frame-center.
              DEVICE-TUNE: the camera preview is `cover`-cropped, so the
              normalized camera-output center maps only approximately onto the
              on-screen rect; chips can sit slightly off their barcode on
              extreme aspect ratios. They remain clearly tappable and labelled
              with the value, so selection is unambiguous regardless. */}
          {!confirm && inFrameCodes.length > 1 && (
            <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
              <View
                pointerEvents="none"
                style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(0,0,0,0.35)' }]}
              />
              <View
                pointerEvents="none"
                style={{ position: 'absolute', top: 8, left: 0, right: 0, alignItems: 'center' }}
              >
                <View style={s.tapHintPill}>
                  <Text style={s.tapHintPillText}>
                    {inFrameCodes.length} codes — tap the one to lot
                  </Text>
                </View>
              </View>
              {inFrameCodes.map((rc, i) => (
                <Pressable
                  key={`${rc.data}-${i}`}
                  onPress={() => onSelectInFrameCode(rc)}
                  accessibilityRole="button"
                  accessibilityLabel={`Lot code ${rc.data}`}
                  hitSlop={10}
                  style={[
                    s.codeChip,
                    {
                      left: `${Math.round(rc.cx * 100)}%`,
                      top: `${Math.round(rc.cy * 100)}%`,
                      // Nearest-to-center chip gets the primary tint as a hint.
                      borderColor: i === 0 ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text style={s.codeChipText} numberOfLines={1}>
                    {rc.data}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {/* Looking up overlay */}
          {looking && (
            <View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFillObject,
                {
                  backgroundColor: 'rgba(0,0,0,0.4)',
                  alignItems: 'center',
                  justifyContent: 'center',
                },
              ]}
            >
              <ActivityIndicator color={colors.primary} size="large" />
              <Text
                style={{ color: colors.primary, fontSize: 13, fontWeight: '800', marginTop: 10 }}
              >
                Looking up…
              </Text>
            </View>
          )}
          {/* Creating overlay */}
          {creating && (
            <View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFillObject,
                {
                  backgroundColor: 'rgba(0,0,0,0.4)',
                  alignItems: 'center',
                  justifyContent: 'center',
                },
              ]}
            >
              <ActivityIndicator color={colors.primary} size="large" />
              <Text
                style={{ color: colors.primary, fontSize: 14, fontWeight: '800', marginTop: 10 }}
              >
                Creating lot…
              </Text>
            </View>
          )}
        </View>

        {/* ── Review-before-save card (Batch 3, opt-in) ─────────────────── */}
        {/* When session.reviewBeforeSave is ON and a matched candidate
            resolved, show the full editable card instead of the timed
            confirmation. Button row mirrors scan.tsx: Save Lot / Edit
            (implicit — every field is live) / Scan Different Item /
            Create Custom Listing. The camera + barcode scanner stay paused
            because `confirm` is still set. */}
        {reviewEditable && confirm && !creating && (
          <>
            <View
              style={[
                s.matchBadge,
                {
                  alignSelf: 'flex-start',
                  backgroundColor: confirm.isManifest ? colors.surfaceHi : 'rgba(34,197,94,0.18)',
                },
              ]}
            >
              <Text
                style={[
                  s.matchBadgeText,
                  { color: confirm.isManifest ? colors.textMuted : '#22c55e' },
                ]}
              >
                {confirm.isManifest ? '📦 manifest match · review' : '✓ catalog match · review'}
              </Text>
            </View>
            <EditableCandidateCard
              value={reviewEditable}
              hideReserve
              onWebLookupEnrich={pauseAutoCreate}
              onChange={(patch) =>
                setReviewEditable((prev) => (prev ? { ...prev, ...patch } : prev))
              }
              onClearPhoto={(i) =>
                setReviewEditable((prev) =>
                  prev
                    ? { ...prev, stockPhotos: prev.stockPhotos.filter((_, idx) => idx !== i) }
                    : prev,
                )
              }
            />
            {/* Save Lot — map the edited card back to a candidate and reuse
                the existing createLot (staff-auth silent-retry + manifest
                flip + fire-and-forget enrichment all unchanged). The edited
                candidate is passed as overrideCandidate so the operator's
                title / condition / startBid / description win. */}
            <Pressable
              onPress={() => {
                if (!reviewEditable.title.trim()) {
                  Alert.alert('Title required', 'Enter a title before saving.');
                  return;
                }
                if (reviewSaveLockRef.current) return;
                reviewSaveLockRef.current = true;
                setSavingReview(true);
                void (async () => {
                  try {
                    let candidate = editableToCandidate(reviewEditable);
                    // D4: the review card's "+ Add photo" tile can add local
                    // file:// URIs to stockPhotos. createDraftLotFromCandidate
                    // runs them through filterSafeImageUrls (https-only) and
                    // would SILENTLY DROP them. Upload locals to lot-photos and
                    // swap for public URLs BEFORE save; remotes pass through.
                    if (
                      role.kind === 'staff' &&
                      candidate.stockPhotos.some((u) => isLocalPhotoUri(u))
                    ) {
                      const { urls, failedCount } = await uploadPendingPhotos(
                        role.operatorId,
                        candidate.stockPhotos,
                      );
                      candidate = { ...candidate, stockPhotos: urls };
                      // Surface silently-dropped photos (RLS/upload failure)
                      // instead of a clean success before the lot is created.
                      if (failedCount > 0) {
                        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                        Alert.alert(
                          'Some photos didn’t upload',
                          `${failedCount} photo${failedCount === 1 ? '' : 's'} couldn’t be uploaded and ${failedCount === 1 ? 'was' : 'were'} left off. The lot will still be created.`,
                        );
                      }
                    }
                    // Awaited, not fire-and-forget. createLot owns every
                    // failure alert, so `void` here let a refused save finish
                    // behind a button that had never looked busy — the tap read
                    // as "nothing happened" and got repeated.
                    await createLot(confirm.code, confirm.candidate, undefined, candidate);
                  } finally {
                    setSavingReview(false);
                    reviewSaveLockRef.current = false;
                  }
                })();
              }}
              disabled={!reviewEditable.title.trim() || savingReview || creating}
              style={[
                s.reviewSaveBtn,
                (!reviewEditable.title.trim() || savingReview || creating) && { opacity: 0.5 },
              ]}
            >
              {savingReview || creating ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <ActivityIndicator color="#000" size="small" />
                  <Text style={s.reviewSaveBtnText}>Saving…</Text>
                </View>
              ) : (
                <Text style={s.reviewSaveBtnText}>Save Lot</Text>
              )}
            </Pressable>
            {/* Scan Different Item — drop this pending scan; camera resumes. */}
            <Pressable onPress={discardConfirmation} style={s.reviewGhostBtn}>
              <Text style={s.reviewGhostBtnText}>Scan Different Item</Text>
            </Pressable>
            {/* Create Custom Listing — hand off to the manual lot form with
                the scanned code pre-filled (same as the no-match picker).
                B2: also pre-bind the code as the sticker in Pre-stickered
                mode so the operator doesn't re-scan the same label. */}
            <Pressable
              onPress={() => {
                const scanned = confirm.code;
                discardConfirmation();
                router.push({
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  pathname: '/lotting/manual' as any,
                  params: {
                    prefilledCode: scanned,
                    ...(lottingMode !== 'generate' ? { prefilledSticker: scanned } : {}),
                  },
                });
              }}
              style={s.reviewGhostBtn}
            >
              <Text style={s.reviewGhostBtnText}>Create Custom Listing</Text>
            </Pressable>
          </>
        )}

        {/* ── Confirmation card ─────────────────────────────────────────── */}
        {confirm && !creating && !reviewEditable && (
          <ConfirmationCard
            confirm={confirm}
            session={{ takePhotoAfterScan: session.takePhotoAfterScan }}
            photoError={photoError}
            onSkipWait={skipAndCreate}
            onAddPhoto={captureAndCreate}
            onSkipPhoto={skipPhotoStep}
            onDiscard={discardConfirmation}
            onIdentifyWithAI={identifyWithAI}
            aiBusy={aiBusy}
            showAiIdentify={role.kind === 'staff' && hasOperatorRole(role.role, 'manager')}
            onWebLookup={() => {
              // Pause the auto-create timer so the lot doesn't disappear
              // while the operator is on the web lookup screen.
              pauseAutoCreate();
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              router.push({
                pathname: '/lotting/web' as any,
                params: {
                  prefilledTitle: confirm.candidate?.title ?? '',
                  prefilledCode: confirm.code,
                  // Enrich the in-review item in place instead of spawning a
                  // second lot — quick.tsx merges the result on re-focus.
                  mode: 'enrich',
                },
              });
            }}
            onCreateManual={() => {
              // B2: snapshot the scanned code before discardConfirmation
              // clears `confirm`. The code becomes BOTH the external_code
              // (prefilledCode) AND — in Pre-stickered mode — the physical
              // sticker to pre-bind after create (prefilledSticker), so the
              // operator doesn't re-scan the same label and put-away never
              // dead-ends. Generate mode has no sticker, so we omit it.
              const scanned = confirm.code;
              // Discard the pending scan before navigating — barcode lock
              // releases and confirm state clears so the camera resumes
              // cleanly when the operator returns from the manual screen.
              discardConfirmation();
              router.push({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                pathname: '/lotting/manual' as any,
                params: {
                  prefilledCode: scanned,
                  ...(lottingMode !== 'generate' ? { prefilledSticker: scanned } : {}),
                },
              });
            }}
            onCancelScan={discardConfirmation}
            onAddBinGoPhoto={captureForMatch}
          />
        )}

        {/* ── Success toast ─────────────────────────────────────────────── */}
        {/* Two variants: clean success (green) vs success-with-photo-issue
            (amber) so the user sees the photo failure without confusing
            it with the lot itself failing. */}
        {justCreatedCode && (
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
                fontWeight: '900',
                fontSize: 16,
              }}
            >
              Created — {justCreatedDisplayCode ?? justCreatedCode}
              {justCreatedPhotoIssue ? '  ⚠' : ''}
            </Text>
            <Text
              style={{
                color: justCreatedPhotoIssue ? 'rgba(245,158,11,0.85)' : 'rgba(34,197,94,0.7)',
                fontSize: 12,
                marginTop: 2,
              }}
            >
              {justCreatedPhotoIssue
                ? `Photo upload failed: ${justCreatedPhotoIssue}. Open Inventory to retry.`
                : lottingMode === 'generate'
                  ? `${justCreatedDisplayCode ?? justCreatedCode} — saved with auto-generated QR. Print the label from Inventory → ${justCreatedDisplayCode ?? justCreatedCode} when ready.`
                  : justBoundSticker
                    ? 'Sticker bound — ready for next scan'
                    : 'Camera ready for next scan'}
            </Text>
            {/* Scan recovery (2026-07-08): honest mistakes shouldn't need a
                manager. Fix = rescan/typed rebind of the sticker code;
                Discard = soft-cancel with an audit trail (discard_lot RPC). */}
            {justCreatedLotId && (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <Pressable
                  onPress={() => {
                    setPendingSticker({
                      lotId: justCreatedLotId,
                      lotCode: justCreatedDisplayCode ?? justCreatedCode ?? '',
                      rebind: true,
                    });
                  }}
                  style={s.recoverBtn}
                >
                  <Text style={s.recoverBtnText}>Fix sticker / code</Text>
                </Pressable>
                <Pressable
                  disabled={discarding}
                  onPress={() => {
                    const lotId = justCreatedLotId;
                    const code = justCreatedDisplayCode ?? justCreatedCode;
                    Alert.alert(
                      `Discard ${code}?`,
                      'The lot is canceled (not deleted) and logged with your name. Use this for a mis-scan or accidental create.',
                      [
                        { text: 'Keep it', style: 'cancel' },
                        {
                          text: 'Discard',
                          style: 'destructive',
                          onPress: () => {
                            void (async () => {
                              setDiscarding(true);
                              try {
                                const { data, error } = await supabase.rpc('discard_lot', {
                                  p_lot_id: lotId,
                                  p_reason: 'mis-scan during lotting',
                                });
                                const res = data as { ok?: boolean; reason?: string } | null;
                                if (error || !res?.ok) {
                                  Alert.alert(
                                    "Couldn't discard",
                                    error?.message ?? res?.reason ?? 'unknown error',
                                  );
                                  return;
                                }
                                void Haptics.notificationAsync(
                                  Haptics.NotificationFeedbackType.Success,
                                );
                                setJustCreatedCode(null);
                                setJustCreatedDisplayCode(null);
                                setJustCreatedLotId(null);
                                setJustCreatedPhotoIssue(null);
                                setSessionCount((c) => Math.max(0, c - 1));
                              } finally {
                                setDiscarding(false);
                              }
                            })();
                          },
                        },
                      ],
                    );
                  }}
                  style={[s.recoverBtn, s.recoverBtnDanger, discarding && { opacity: 0.5 }]}
                >
                  <Text style={[s.recoverBtnText, { color: '#ef4444' }]}>
                    {discarding ? 'Discarding…' : 'Discard'}
                  </Text>
                </Pressable>
              </View>
            )}
          </View>
        )}

        {/* ── Bottom sheet: condition override + bid override ───────────── */}
        <View style={s.controlSheet}>
          <Text style={s.sheetLabel}>Next lot condition</Text>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {ALL_CONDITIONS.map((cond: DefaultCondition) => {
              const isActive = activeCondition === cond;
              const isSessionDefault =
                session.defaultCondition === cond && overrideCondition === null;
              const col = CONDITION_COLORS[cond];
              return (
                <Pressable
                  key={cond}
                  onPress={() => {
                    if (cond === session.defaultCondition) {
                      setOverrideCondition(null);
                    } else {
                      setOverrideCondition(cond);
                    }
                  }}
                  style={[
                    s.condChip,
                    isActive && {
                      backgroundColor: `${col}22`,
                      borderColor: `${col}66`,
                    },
                  ]}
                >
                  <Text style={[s.condChipText, isActive && { color: col }]}>
                    {CONDITION_LABELS[cond]}
                    {isSessionDefault ? ' ✶' : ''}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {overrideCondition !== null && (
            <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 4 }}>
              Override active for next scan only — resets to session default after each lot.
            </Text>
          )}

          {/* Starting bid override — R6.3: visual affordance when active.
              Without this the input always shows a number (either the
              override or the session default) and the user can't tell
              if they've changed the value or not. The "(override)" pill
              + amber border on the input clarify the state. Tap "Reset"
              to fall back to the session default. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={[s.sheetLabel, { marginTop: 0 }]}>Starting bid ($)</Text>
              {overrideStartBid !== null && (
                <>
                  <View style={s.overridePill}>
                    <Text style={s.overridePillText}>OVERRIDE</Text>
                  </View>
                  <Pressable onPress={() => setOverrideStartBid(null)} hitSlop={6}>
                    <Text
                      style={{
                        color: colors.textMuted,
                        fontSize: 11,
                        textDecorationLine: 'underline',
                      }}
                    >
                      reset
                    </Text>
                  </Pressable>
                </>
              )}
            </View>
            <TextInput
              value={overrideStartBid ?? String(session.defaultStartBid)}
              onChangeText={(t) => setOverrideStartBid(t)}
              onBlur={() => {
                if (overrideStartBid === null) return;
                const v = parseFloat(overrideStartBid);
                if (isNaN(v) || v <= 0) setOverrideStartBid(null);
              }}
              keyboardType="decimal-pad"
              style={[
                s.bidInput,
                overrideStartBid !== null && {
                  borderColor: '#f59e0b',
                  color: '#f59e0b',
                },
              ]}
              selectTextOnFocus
            />
          </View>
        </View>

        {/* ── Manual code entry fallback ────────────────────────────────── */}
        {/* The input is ALWAYS editable. When focused while a confirmation
            card is up, we pause the auto-create timer so the operator
            doesn't lose the pending scan to a background fire. They can
            either tap the card to commit it, tap Discard, then submit the
            manual code, or just keep typing — nothing will fire on its own. */}
        {/* ── Scan-field picker (D.1) ───────────────────────────────────── */}
        {/* Horizontal chip row scoping which manifest column a scanned/typed
            code matches against (find_import_row_by_scan p_kind, mig 0190).
            Reuses the condition-chip styling; primary tint marks the active
            chip. Default 'auto' = today's multi-column probe. Persisted on
            the session (SessionContext.scanFieldKind) so it sticks across
            screens + reloads. */}
        <View>
          <Text style={s.sheetLabel}>Match scanned code as</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              flexDirection: 'row',
              gap: 6,
              paddingVertical: 6,
              paddingRight: 8,
            }}
          >
            {ALL_SCAN_FIELD_KINDS.map((kind: ScanFieldKind) => {
              const isActive = session.scanFieldKind === kind;
              return (
                <Pressable
                  key={kind}
                  onPress={() => setSession({ scanFieldKind: kind })}
                  style={[
                    s.condChip,
                    isActive && {
                      backgroundColor: colors.primaryDim,
                      borderColor: colors.primary,
                    },
                  ]}
                >
                  <Text style={[s.condChipText, isActive && { color: colors.primary }]}>
                    {SCAN_FIELD_LABELS[kind]}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        <View>
          <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 6 }}>
            {confirm
              ? 'Tap card above to save the pending lot, or Discard. Manual input pauses the timer.'
              : "Can't scan? Type the code:"}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput
              ref={manualRef}
              placeholder={SCAN_FIELD_PLACEHOLDERS[session.scanFieldKind]}
              placeholderTextColor={colors.textMuted}
              value={manualCode}
              onChangeText={setManualCode}
              onFocus={pauseAutoCreate}
              onBlur={() => {
                // If the user blurs without submitting AND a confirm is
                // still pending, resume the timer. If they submitted
                // "Lot it", processCode/createLot already cleared confirm.
                if (confirm) resumeAutoCreate();
              }}
              autoCorrect={false}
              autoCapitalize="characters"
              style={[s.manualInput, { flex: 1 }]}
              returnKeyType="done"
              onSubmitEditing={() => {
                if (manualCode.trim() && !confirm) {
                  void processCode(manualCode, 'unknown', 'manual');
                }
              }}
            />
            <Pressable
              onPress={() => {
                if (manualCode.trim() && !confirm) {
                  void processCode(manualCode, 'unknown', 'manual');
                }
              }}
              disabled={!manualCode.trim() || busy || confirm !== null}
              style={[
                s.manualSubmitBtn,
                (!manualCode.trim() || busy || confirm !== null) && {
                  backgroundColor: colors.surfaceHi,
                },
              ]}
            >
              <Text
                style={{
                  color: manualCode.trim() && !busy && confirm === null ? '#000' : colors.textMuted,
                  fontSize: 14,
                  fontWeight: '900',
                }}
              >
                Lot it
              </Text>
            </Pressable>
          </View>
        </View>

        {/* ── Recent history (persistent clipboard) ───────────────────────── */}
        {/* Persisted via SessionContext + AsyncStorage so it survives
            navigation away (e.g. tapping into Inventory to verify a lot).
            Capped at 20 entries server-side (RECENT_HISTORY_MAX).
            C3 #9: show only the 5 most-recent (history is newest-first) and
            label the count to match what's actually rendered. Each row is a
            Pressable → the lot's worklist detail, guarded on entry.lotId
            (legacy AsyncStorage entries written before that field existed
            stay non-navigable, rendered at reduced opacity — same nav guard
            the LotTR hub uses). */}
        {history.length > 0 && (
          <View>
            <Text
              style={{
                color: colors.textMuted,
                fontSize: 11,
                ...typeTokens.label,
                marginBottom: 6,
              }}
            >
              {history.length > 5
                ? `Recent · ${Math.min(history.length, 5)} of ${history.length}`
                : `Recent ${history.length} lot${history.length !== 1 ? 's' : ''}`}
            </Text>
            {history.slice(0, 5).map((entry) => {
              const navigable = !!entry.lotId;
              return (
                <Pressable
                  key={entry.id}
                  onPress={
                    navigable
                      ? // Cast: the worklist detail is a dynamic route, so the
                        // template literal isn't a statically-known Href literal.
                        () => router.push(`/worklist/${entry.lotId}` as Href)
                      : undefined
                  }
                  disabled={!navigable}
                  style={[s.historyRow, !navigable && { opacity: 0.6 }]}
                  accessibilityRole={navigable ? 'button' : undefined}
                  accessibilityLabel={navigable ? `Open ${entry.lotCode} in worklist` : undefined}
                >
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{
                        color: colors.primary,
                        fontFamily: 'monospace',
                        fontSize: 12,
                        fontWeight: '900',
                      }}
                      numberOfLines={1}
                    >
                      {lotDisplayCode({ lot_code: entry.lotCode, sticker_code: entry.sticker }) ??
                        entry.lotCode}
                    </Text>
                    <Text
                      style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}
                      numberOfLines={1}
                    >
                      {entry.title || entry.externalCode}
                      {entry.source ? `  ·  ${entry.source}` : ''}
                    </Text>
                  </View>
                  <Text style={{ color: colors.textDim, fontSize: 10 }}>
                    {(() => {
                      const ms = Date.now() - new Date(entry.at).getTime();
                      if (ms < 60_000) return 'now';
                      const min = Math.floor(ms / 60_000);
                      if (min < 60) return `${min}m ago`;
                      const hr = Math.floor(min / 60);
                      if (hr < 24) return `${hr}h ago`;
                      return `${Math.floor(hr / 24)}d ago`;
                    })()}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>

      {captureSticker && (
        <PreStickeredScanner
          canSkip={role.kind === 'staff' && hasOperatorRole(role.role, 'manager')}
          onAssigned={() => {}}
          onCancel={() => {}}
          capture={{
            onCaptured: (sticker) => {
              const { args } = captureSticker;
              capturedStickerRef.current = sticker;
              setCaptureSticker(null);
              beginCameraSettle();
              void createLot(...args);
            },
            onAbort: () => {
              setCaptureSticker(null);
              beginCameraSettle();
              Alert.alert(NO_STICKER_SCANNED_TITLE, NO_STICKER_SCANNED_MESSAGE);
            },
          }}
        />
      )}
      {pendingSticker && (
        <PreStickeredScanner
          lotId={pendingSticker.lotId}
          lotCode={pendingSticker.lotCode}
          rebind={pendingSticker.rebind === true}
          // C2: skipping sticker binding is manager-only. `role` is from
          // useOperatorRole(); narrow to the 'staff' variant before reading
          // role.role (discriminated union — picker/manager/admin).
          canSkip={role.kind === 'staff' && hasOperatorRole(role.role, 'manager')}
          onAssigned={() => {
            // Toast already shows the lot code; just close the modal
            // and let the success haptic from the scanner carry the
            // feedback. Camera resumes after the settle window so its new
            // session doesn't race the modal's teardown (black-screen fix).
            setPendingSticker(null);
            beginCameraSettle();
          }}
          onCancel={() => {
            // Operator skipped — the auto-generated qr_token stays on
            // the lot. Same UX as Generate mode for this lot only;
            // the session mode preference is unchanged. Settle the camera
            // before it remounts (same black-screen fix as onAssigned).
            setPendingSticker(null);
            beginCameraSettle();
          }}
          // The lot is minted before this modal opens, so leaving used to
          // strand one every time — "it creates a quick lot and we have to go
          // back into our inventory and delete it" (staff member, 2026-08-20).
          // discard_lot is the same RPC the post-save panel and the detail
          // screen already use; doing it here means the cleanup happens where
          // the mistake is, while the operator still knows what the lot was.
          onDiscard={() => {
            const { lotId, lotCode } = pendingSticker;
            setPendingSticker(null);
            beginCameraSettle();
            void (async () => {
              const { data, error } = await supabase.rpc('discard_lot', {
                p_lot_id: lotId,
                p_reason: 'no sticker — discarded at the pre-sticker step',
              });
              const res = data as { ok?: boolean; reason?: string } | null;
              if (error || !res?.ok) {
                // Say WHICH lot survived. A failed discard the operator does
                // not know about is the junk lot all over again, except now
                // they think it is gone.
                Alert.alert(
                  'Could not discard',
                  `${lotCode} is still in inventory${
                    error?.message || res?.reason ? ` (${error?.message ?? res?.reason})` : ''
                  }. Delete it from Inventory when you get a chance.`,
                );
                return;
              }
              setJustCreatedCode(null);
              setJustCreatedLotId(null);
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            })();
          }}
        />
      )}

      {/* B1 / PHOTO-1: shared photo-capture sheet.
          - 'awaiting' (takePhotoAfterScan): blank strip, captures become the
            lot's photos.
          - 'mergeMatch' ("Add BinGo Auctions photo" on a stock match): seeded with
            the matched candidate's stock photos so the operator sees what's
            already attached and ADDS a real shot. onCameraConfirm splits the
            returned list into stock (kept) + captures (uploaded) for the union
            save. Only rendered while open so the underlying camera (paused via
            isActive above) can hand off the hardware. */}
      <CameraCaptureSheet
        open={cameraSheetOpen}
        title={
          photoSheetMode === 'mergeMatch'
            ? 'Add BinGo Auctions photo'
            : confirm?.candidate?.title
              ? `Photo · ${confirm.candidate.title}`
              : 'Take photo'
        }
        initialUris={
          photoSheetMode === 'mergeMatch'
            ? (confirm?.candidate?.stockPhotos ?? []).filter((u) => /^https:\/\//i.test(u.trim()))
            : undefined
        }
        onClose={() => {
          setCameraSheetOpen(false);
          // PHOTO-1: the matched "Add BinGo Auctions photo" flow paused the 2s
          // auto-create timer (captureForMatch). If the operator backs out of
          // the camera without confirming, resume the countdown so the card
          // behaves exactly as before they opened it. No-op for the awaiting-
          // photo flow (it has no running timer) and when confirm is cleared.
          if (photoSheetMode === 'mergeMatch') resumeAutoCreate();
        }}
        onConfirm={onCameraConfirm}
      />
    </SafeAreaView>
  );
}

// ── Confirmation card component ───────────────────────────────────────────────

type ConfirmationCardProps = {
  confirm: ConfirmState;
  session: { takePhotoAfterScan: boolean };
  /** Non-null when a recent photo capture attempt failed. Surfaced
   *  inline so the operator doesn't think the toggle is broken. */
  photoError: string | null;
  onSkipWait: () => void;
  onAddPhoto: () => void;
  onSkipPhoto: () => void;
  /** Drop the pending lot without saving. Clears the card; barcode lock releases. */
  onDiscard: () => void;
  /** Run AI identification using a fresh camera frame. Merges the result
   *  (title, brand, MSRP, photos) into the pending confirmation. Only
   *  surfaced when matched is false (no catalog hit). */
  onIdentifyWithAI: () => void;
  /** True while the AI scan is in flight — shows spinner on the button. */
  aiBusy: boolean;
  /** Role gate: AI button (and its spinner) only renders when true.
   *  Operator decision (2026-05-27): pickers should not be able to spend
   *  AI tokens — only managers and admins see the "Identify with AI"
   *  affordance. Web lookup remains visible to everyone. */
  showAiIdentify: boolean;
  /** Navigate to /lotting/web with context pre-filled. */
  onWebLookup: () => void;
  /** Navigate to /lotting/manual so the operator can fill in details
   *  manually for an unrecognised code. Only shown on the no-match path. */
  onCreateManual: () => void;
  /** Discard the no-match scan and resume the barcode camera without
   *  creating a lot. Same as onDiscard but surfaced as a labelled button
   *  on the no-match path so the action is unambiguous. */
  onCancelScan: () => void;
  /** PHOTO-1: open the capture sheet (seeded with the matched candidate's
   *  stock photos) to add a real BinGo Auctions photo alongside them. Only rendered
   *  on the MATCHED path and only when not in the takePhotoAfterScan flow
   *  (that path already has its own Take photo / Skip row). */
  onAddBinGoPhoto: () => void;
};

function ConfirmationCard({
  confirm,
  session,
  photoError,
  onSkipWait,
  onAddPhoto,
  onSkipPhoto,
  onDiscard,
  onIdentifyWithAI,
  aiBusy,
  showAiIdentify,
  onWebLookup,
  onCreateManual,
  onCancelScan,
  onAddBinGoPhoto,
}: ConfirmationCardProps) {
  const matched = confirm.candidate !== null;
  const isManifest = confirm.isManifest === true;
  const candidate = confirm.candidate;

  const borderColor = matched ? 'rgba(34,197,94,0.45)' : colors.border;
  const bgColor = matched ? 'rgba(34,197,94,0.08)' : colors.surface;

  function formatMsrp(msrp: number | null | undefined): string | null {
    if (msrp == null) return null;
    return `$${msrp.toFixed(2)}`;
  }

  // Progress bar fraction (0 → 1) for the 2-second countdown
  const progressFraction = confirm.awaitingPhoto ? 0 : 1 - confirm.remainingMs / 2000;

  return (
    <Pressable
      onPress={matched && !confirm.awaitingPhoto ? onSkipWait : undefined}
      style={[s.confirmCard, { borderColor, backgroundColor: bgColor }]}
    >
      {/* Match badge */}
      <View
        style={[
          s.matchBadge,
          { backgroundColor: matched ? 'rgba(34,197,94,0.18)' : colors.surfaceHi },
        ]}
      >
        <Text style={[s.matchBadgeText, { color: matched ? '#22c55e' : colors.textMuted }]}>
          {isManifest ? '📦 manifest match' : matched ? '✓ catalog match' : '✗ no match'}
        </Text>
      </View>

      {/* Content */}
      {matched && candidate ? (
        <View style={{ gap: 3, marginTop: 8 }}>
          <Text
            style={{ color: colors.text, fontSize: 14, fontWeight: '800', lineHeight: 20 }}
            numberOfLines={2}
          >
            {candidate.title}
          </Text>
          {candidate.brand ? (
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>
              {candidate.brand}
              {candidate.model ? `  ·  ${candidate.model}` : ''}
            </Text>
          ) : null}
          {formatMsrp(candidate.msrp) ? (
            <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '700', marginTop: 2 }}>
              MSRP {formatMsrp(candidate.msrp)}
              {candidate.avg ? `  ·  avg $${candidate.avg.toFixed(2)}` : ''}
            </Text>
          ) : null}

          {/* PHOTO-1: add a REAL BinGo Auctions photo alongside the matched stock
              photo. Only in the non-takePhotoAfterScan flow (that path already
              shows its own Take photo / Skip row below). Tapping opens the
              capture sheet seeded with the candidate's stock photos; the new
              shot is UNIONED with them on save (stock kept, capture appended).
              stopPropagation so it doesn't trigger the card's tap-to-save. */}
          {!confirm.awaitingPhoto && (
            <Pressable
              onPress={(e) => {
                e.stopPropagation();
                onAddBinGoPhoto();
              }}
              accessibilityRole="button"
              accessibilityLabel="Add BinGo Auctions photo"
              accessibilityHint="Opens the camera to add a real photo of this item alongside the stock photo"
              style={s.addRealPhotoBtn}
            >
              <Text style={s.addRealPhotoBtnText}>
                📷 Add BinGo Auctions photo
                {(() => {
                  const n = (candidate.stockPhotos ?? []).filter((u) =>
                    /^https:\/\//i.test(u.trim()),
                  ).length;
                  return n > 0 ? `  ·  keeps ${n} stock` : '';
                })()}
              </Text>
            </Pressable>
          )}
        </View>
      ) : (
        (() => {
          // C2/C3: a no-match on a NON-UPC code (FNSKU/ASIN/LPN/roll-label)
          // can never be resolved by a catalog/manifest lookup — a photo is
          // the only way to identify it. When the operator is allowed to spend
          // AI tokens (showAiIdentify, manager+), PROMOTE the AI photo-identify
          // path to the PRIMARY filled action and demote "Create Custom
          // Listing" to a secondary/outlined choice. Pickers (no showAiIdentify)
          // and real-barcode misses keep today's picker (manual entry primary).
          const promoteAi = confirm.nonUpc === true && showAiIdentify;
          return (
            <View style={{ gap: 6, marginTop: 8 }}>
              {/* B2: explicit no-match state. No auto-save in any mode — the
                  operator must choose. The scanned code is shown so they can
                  confirm it scanned correctly before deciding. C2/C3: when the
                  code isn't a product barcode, lead with the photo affordance
                  in the heading + copy since a lookup can't help. */}
              <Text style={{ color: colors.text, fontSize: 16, fontWeight: '900' }}>
                {promoteAi ? 'Not a product barcode — take a photo to identify' : 'No Match Found'}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 17 }}>
                {promoteAi
                  ? "This code (FNSKU/ASIN/LPN) isn't a product barcode, so a catalog lookup can't find it. Take a photo to identify it with AI, or create a custom listing."
                  : 'Nothing in the catalog or manifest matched this code. Create a custom listing for it, or scan a different item.'}
              </Text>
              <Text
                style={{
                  color: colors.textDim,
                  fontSize: 12,
                  fontFamily: 'monospace',
                  marginTop: 2,
                }}
              >
                {confirm.code}
              </Text>

              {/* AI identify — role-gated to manager+ to control token spend
                  (~$0.005, Gemini Flash). Merges the result into this same
                  confirmation so the operator reviews before saving. On a
                  non-UPC miss it's the PRIMARY filled action (a photo is the
                  only identifier); otherwise it stays an outlined enrichment
                  shortcut above the explicit choices. */}
              {showAiIdentify && (
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation();
                    onIdentifyWithAI();
                  }}
                  disabled={aiBusy}
                  style={
                    promoteAi
                      ? {
                          marginTop: 6,
                          padding: 14,
                          borderRadius: 10,
                          backgroundColor: colors.primary,
                          alignItems: 'center',
                        }
                      : {
                          marginTop: 6,
                          padding: 12,
                          borderRadius: 8,
                          borderWidth: 1.5,
                          borderColor: colors.primary,
                          backgroundColor: colors.primaryDim,
                          alignItems: 'center',
                        }
                  }
                >
                  {aiBusy ? (
                    <ActivityIndicator color={promoteAi ? '#000' : colors.primary} size="small" />
                  ) : (
                    <Text
                      style={{
                        color: promoteAi ? '#000' : colors.primary,
                        fontSize: promoteAi ? 14 : 13,
                        fontWeight: '900',
                      }}
                    >
                      {promoteAi ? '📷 Identify with AI (~$0.005)' : 'Identify with AI (~$0.005)'}
                    </Text>
                  )}
                </Pressable>
              )}

              {/* [Create Custom Listing] — hands off to manual.tsx with the
                  scanned code pre-filled as external_code AND (in Pre-stickered
                  mode) pre-bound as the sticker, so put-away never dead-ends and
                  the operator doesn't re-scan the same label. Primary (filled)
                  by default; demoted to secondary (outlined) when AI is the
                  promoted primary on a non-UPC miss. */}
              <Pressable
                onPress={(e) => {
                  e.stopPropagation();
                  onCreateManual();
                }}
                accessibilityRole="button"
                accessibilityLabel="Create custom listing"
                style={
                  promoteAi
                    ? {
                        marginTop: 2,
                        padding: 12,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: colors.border,
                        backgroundColor: colors.surface,
                        alignItems: 'center',
                      }
                    : {
                        marginTop: 2,
                        padding: 14,
                        borderRadius: 10,
                        backgroundColor: colors.primary,
                        alignItems: 'center',
                      }
                }
              >
                <Text
                  style={{
                    color: promoteAi ? colors.text : '#000',
                    fontSize: promoteAi ? 13 : 14,
                    fontWeight: promoteAi ? '700' : '900',
                  }}
                >
                  Create Custom Listing
                </Text>
              </Pressable>

              {/* [Scan Another Item] — drop this scan, resume the camera, no lot
                  created. */}
              <Pressable
                onPress={(e) => {
                  e.stopPropagation();
                  onCancelScan();
                }}
                accessibilityRole="button"
                accessibilityLabel="Scan another item"
                style={{
                  padding: 12,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>
                  Scan Another Item
                </Text>
              </Pressable>
            </View>
          );
        })()
      )}

      {/* Photo-after-scan action row */}
      {confirm.awaitingPhoto ? (
        <View style={{ marginTop: 14, gap: 8 }}>
          {photoError && (
            <View
              style={{
                padding: 8,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: 'rgba(245,158,11,0.5)',
                backgroundColor: 'rgba(245,158,11,0.12)',
              }}
            >
              <Text style={{ color: '#f59e0b', fontSize: 12, fontWeight: '700' }}>
                {photoError}
              </Text>
            </View>
          )}
          {/* B1: opens the shared CameraCaptureSheet (live viewfinder +
              real circular shutter), replacing the old blind one-shot
              "Add photo" tap. The 📷 + "Take photo" copy makes the
              affordance unmistakable — the reported gap was that operators
              couldn't tell how to actually take the photo. */}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable
              onPress={onAddPhoto}
              style={s.photoBtn}
              accessibilityRole="button"
              accessibilityLabel="Take photo"
            >
              <Text style={s.photoBtnText}>
                {photoError ? '📷 Try photo again' : '📷 Take photo'}
              </Text>
            </Pressable>
            <Pressable onPress={onSkipPhoto} style={s.skipPhotoBtn}>
              <Text style={s.skipPhotoBtnText}>Skip</Text>
            </Pressable>
          </View>
        </View>
      ) : matched ? (
        // Auto-create countdown progress bar + action row — only for matched lots.
        // On no-match, awaitingPhoto is forced false by startConfirmation but there
        // is no running timer. Rendering countdown text here would show a static
        // "Creating in 2.0s" bar that never decrements — misleading and the source
        // of the tap-to-create bug (C2). Gate on matched so the no-match card is
        // inert below the 3-button picker.
        <View style={{ marginTop: 12, gap: 8 }}>
          <View style={s.progressTrack}>
            <View style={[s.progressFill, { width: `${Math.round(progressFraction * 100)}%` }]} />
          </View>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <Text style={{ color: colors.textDim, fontSize: 11, flex: 1 }}>
              {confirm.remainingMs > 0
                ? `Creating in ${(confirm.remainingMs / 1000).toFixed(1)}s · tap card to save now`
                : 'Saving…'}
            </Text>
            {/* SCAN-1 #5: one-tap fast rescan. This is the "wrong code → rescan"
                escape hatch — it stops the auto-create timer, drops the pending
                lot, and resumes the camera immediately (onDiscard →
                discardConfirmation). Labelled explicitly (not just "Discard")
                so a mis-scan is corrected in a single obvious tap. hitSlop +
                stopPropagation so it never triggers the card's tap-to-save. */}
            <Pressable
              onPress={(e) => {
                e.stopPropagation();
                onDiscard();
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Wrong code, rescan"
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: 'rgba(220,38,38,0.4)',
              }}
            >
              <Text style={{ color: '#dc2626', fontSize: 11, fontWeight: '800' }}>
                ✗ Wrong code — rescan
              </Text>
            </Pressable>
          </View>
        </View>
      ) : // No-match: no countdown, no "tap to save" affordance.
      // The 3 action buttons in the content section above are the only affordances.
      null}
    </Pressable>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
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
  scanGuide: {
    width: '75%',
    height: 72,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: 'transparent',
  },
  // SCAN-1: small instruction under the reticle so staff know the box is a
  // real target now (only the centered barcode is read), not decoration.
  scanGuideHint: {
    marginTop: 10,
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  // Live scan diagnostic readout under the reticle hint (dim, monospace-ish).
  scanDebug: {
    marginTop: 4,
    color: 'rgba(255,255,255,0.65)',
    fontSize: 10,
    fontWeight: '600',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  // SCAN-1 tap-to-select: header pill + per-code chips.
  tapHintPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 99,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderWidth: 1,
    borderColor: colors.primary,
  },
  tapHintPillText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '900',
  },
  // Positioned absolutely via left/top % (the code's normalized frame-center).
  // translate offsets center the chip on that point.
  codeChip: {
    position: 'absolute',
    transform: [{ translateX: -54 }, { translateY: -16 }],
    maxWidth: 130,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
    backgroundColor: 'rgba(15,17,21,0.92)',
  },
  codeChipText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  // Confirmation card
  confirmCard: {
    borderRadius: 14,
    borderWidth: 1.5,
    padding: 14,
  },
  matchBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 99,
  },
  matchBadgeText: {
    fontSize: 11,
    fontWeight: '800',
  },
  progressTrack: {
    height: 4,
    backgroundColor: colors.surfaceHi,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    backgroundColor: '#22c55e',
    borderRadius: 2,
  },
  photoBtn: {
    flex: 1,
    paddingVertical: 12,
    backgroundColor: colors.primary,
    borderRadius: 10,
    alignItems: 'center',
  },
  photoBtnText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '900',
  },
  // PHOTO-1: "Add BinGo Auctions photo" affordance on a matched card. Outlined (not
  // filled) so it reads as a secondary action next to the primary tap-to-save.
  addRealPhotoBtn: {
    marginTop: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.primaryDim,
    alignItems: 'center',
  },
  addRealPhotoBtnText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: '900',
  },
  skipPhotoBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  skipPhotoBtnText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '700',
  },
  // Success toast
  successToast: {
    padding: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderWidth: 1.5,
    borderColor: 'rgba(34,197,94,0.4)',
    alignItems: 'center',
  },
  // Scan-recovery actions on the toast (2026-07-08)
  recoverBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  recoverBtnDanger: {
    borderColor: 'rgba(239,68,68,0.5)',
  },
  recoverBtnText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: '800',
  },
  // Control sheet
  controlSheet: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 8,
  },
  sheetLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  condChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  condChipText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  bidInput: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    width: 80,
    textAlign: 'right',
  },
  manualInput: {
    padding: 12,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    fontSize: 15,
    fontFamily: 'monospace',
  },
  manualSubmitBtn: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Batch 3 — review-before-save action row. Mirrors scan.tsx's
  // createBtn / ghostBtn so the Save / discard affordances feel identical
  // across the scan→review→save flows.
  reviewSaveBtn: {
    padding: 18,
    backgroundColor: '#22c55e',
    borderRadius: 14,
    alignItems: 'center',
    minHeight: 60,
    justifyContent: 'center',
  },
  reviewSaveBtnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '900',
  },
  reviewGhostBtn: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  reviewGhostBtnText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: '700',
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 6,
    gap: 8,
  },
  // R6.3: visual affordance when starting-bid is overridden away from session default.
  overridePill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(245,158,11,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.45)',
  },
  overridePillText: {
    color: '#f59e0b',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
});
