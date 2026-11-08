// Vision-camera v4 helpers + bridges.
//
// v4.7.3 (pinned) uses a simpler, prop-driven API than v5: photo capture
// goes through `<Camera photo={true} />` + `cameraRef.takePhoto({...})`,
// and barcode scanning uses `useCodeScanner({codeTypes, onCodeScanned})`
// composed in as a single `codeScanner` prop. No output objects, no
// manual dispose, no Nitro modules. We're on v4 (not v5) because v5
// triggers an Xcode 26 Swift compiler LLVM-IR verifier crash on EAS
// Build that's blocked upstream (see issue #3743). v4 has none of the
// Nitro/C++ interop surface that hits that bug.
//
// This file centralizes the bits every camera screen reuses:
//   - toVisionCodeTypes(): translate our legacy expo-camera barcode-
//     type strings ('upc_a', 'ean13', ...) to v4's kebab-case CodeType
//     ('upc-a', 'ean-13', ...). v4 does have a separate 'upc-a' type
//     (unlike v5 where UPC-A reports as 'ean-13').
//   - The pre-mapped retail-code + QR-only arrays so each screen just
//     imports the right constant.
//   - DecodedCode shape that mirrors expo-camera's old
//     BarcodeScanningResult — lets us keep callback signatures stable.
//   - TAKE_PHOTO_OPTIONS — the defaults we pass to takePhoto() everywhere
//     (speed-prioritized, no shutter sound). Matches what
//     compressForVision expects downstream.

import type {
  CameraDevice,
  Code,
  CodeScannerFrame,
  CodeType,
} from 'react-native-vision-camera';

/**
 * Translate expo-camera-style barcode-type strings to vision-camera v4's
 * kebab-case CodeType. Unknown values are dropped silently.
 *
 * v4 (unlike v5) keeps 'upc-a' distinct from 'ean-13', so we map
 * 'upc_a' → 'upc-a' directly.
 */
export function toVisionCodeTypes(input: readonly string[]): CodeType[] {
  const out = new Set<CodeType>();
  for (const t of input) {
    switch (t) {
      case 'qr':            out.add('qr'); break;
      case 'upc_a':         out.add('upc-a'); break;
      case 'upc_e':         out.add('upc-e'); break;
      case 'ean8':          out.add('ean-8'); break;
      case 'ean13':         out.add('ean-13'); break;
      case 'code128':       out.add('code-128'); break;
      case 'code39':        out.add('code-39'); break;
      case 'code93':        out.add('code-93'); break;
      case 'codabar':       out.add('codabar'); break;
      // 2026-08-14 CRASH FIX — 'itf', NOT 'itf-14'.
      //
      // vision-camera 4.7.3's Android CodeType.fromUnionValue() knows exactly
      // 13 strings and 'itf-14' is not one of them; ITF is spelled 'itf' there
      // (Barcode.FORMAT_ITF). Anything unrecognized hits:
      //
      //   else -> throw InvalidTypeScriptUnionError("codeType", unionValue)
      //
      // That throws while parsing the <Camera codeScanner={...}> prop on the
      // native side, unhandled, so the PROCESS ABORTS the moment the camera
      // mounts. Samsung reports it as "BinGo Staff closed because this app has
      // a bug". iOS was unaffected because AVFoundation really does have a
      // distinct .itf14, which is why the iPad never showed this.
      //
      // Every screen on ALL_RETAIL_CODE_TYPES was therefore dead on Android:
      // all three put-away modes, quick lot, relot, lot find, walk, bin audit,
      // and checkout's verify camera. The ones that kept working are exactly
      // the ones that never ask for this set — QR_ONLY screens (checkout token
      // scan, bin contents, stage) and AI-lotting photo capture, which mounts
      // no codeScanner at all.
      //
      // 'itf' is valid on BOTH platforms (iOS maps it to .interleaved2of5), and
      // an ITF-14 symbol IS an Interleaved 2-of-5 symbol carrying 14 digits, so
      // master-carton GTINs still decode. Nothing is lost by using the name
      // both platforms accept.
      case 'itf14': case 'itf-14': out.add('itf'); break;
      case 'pdf417':        out.add('pdf-417'); break;
      case 'aztec':         out.add('aztec'); break;
      case 'datamatrix':    out.add('data-matrix'); break;
      // Native v4 names pass through unchanged.
      case 'upc-a': case 'upc-e':
      case 'ean-8': case 'ean-13':
      case 'code-128': case 'code-39': case 'code-93':
      // 'itf-14' is NOT passed through — it is folded to 'itf' above, because
      // Android throws on it. Adding it back here would reintroduce the crash.
      case 'itf':
      case 'pdf-417':
      case 'data-matrix':
        out.add(t as CodeType); break;
    }
  }
  return [...out];
}

/** All retail-relevant barcode formats accepted on any-format screens. */
export const ALL_RETAIL_CODE_TYPES: CodeType[] = toVisionCodeTypes([
  'upc_a', 'upc_e', 'ean8', 'ean13',
  'code128', 'code39', 'code93',
  'codabar', 'itf14',
  'qr', 'pdf417', 'aztec', 'datamatrix',
]);

/**
 * PRODUCT-scan barcodes (SCAN-1).
 *
 * Quick Lot scans the manufacturer's UPC/EAN off the *product itself* (catalog
 * lookup) AND, for the Wayfair/liquidation flow, the carrier-tracking barcode
 * on the box (manifest lookup via find_import_row_by_scan). The full
 * ALL_RETAIL_CODE_TYPES set additionally enables QR, PDF417, Aztec, Data-Matrix
 * and the exotic linear formats (Code-39/93, Codabar) — which is exactly why
 * the floor team reported the scanner "grabs any barcode": an off-center
 * shipping-label QR or a manufacturer Data-Matrix got decoded the instant it
 * drifted into frame, before the real product UPC was centered. Dropping those
 * here removes the wrong-grabs at the decoder level (the cheapest filter — the
 * engine never even reports the unwanted symbology).
 *
 * WHAT STAYS, and why (this is intentionally NOT just the 5 retail formats):
 *   - upc-a / upc-e / ean-13 / ean-8 — the product GTIN we look up.
 *   - itf-14 — master-carton / case GTIN on liquidation pallets; same lookup.
 *   - code-128 — REQUIRED: carrier tracking labels (FedEx/UPS/USPS, SSCC) are
 *     Code-128, and quick.tsx's manifest-tracking scan (buildManifestCandidate
 *     → "📦 manifest match") depends on decoding them. Code-128 is an
 *     internal/shipping label format, NOT one of the reported wrong-grab 2D
 *     codes, so keeping it preserves the Wayfair flow with no regression.
 * Everything 2D (QR / PDF417 / Aztec / Data-Matrix) and Code-39/93/Codabar are
 * dropped. Over-sensitivity is further contained by the reticle region-of-
 * interest + hold-to-confirm (see quick.tsx), which gate ALL symbologies —
 * those are the real fix for "grabs anything the moment it appears".
 *
 * Screens that genuinely need the dropped formats (bin/lot QR in checkout +
 * put-away, pre-stickered labels, the mixed layout walk) keep
 * ALL_RETAIL_CODE_TYPES or QR_ONLY — this constant is Quick-Lot-specific.
 *
 * NOTE (2026-07-01): Quick Lot itself no longer uses this narrow set —
 * operators need to scan any label (incl. Amazon LPN / FNSKU Code-39), so it
 * switched to ALL_RETAIL_CODE_TYPES and the reticle + hold-to-confirm gate now
 * carries the anti-over-scan job (see quick.tsx). This constant is retained as
 * the conservative option for any future narrow-scan screen.
 */
export const PRODUCT_CODE_TYPES: CodeType[] = toVisionCodeTypes([
  'upc_a', 'upc_e', 'ean13', 'ean8', 'itf14', 'code128',
]);

/** QR-only — used for internal bin / lot QR labels. */
export const QR_ONLY: CodeType[] = ['qr'];

/**
 * Stable callback shape for downstream code-scan handlers. Mirrors
 * expo-camera's old `BarcodeScanningResult` so handlers don't need to
 * change.
 */
export type DecodedCode = {
  data: string;
  type: CodeType | 'unknown';
};

/**
 * Take the first decoded code with a non-empty `value` out of a
 * scanned-codes array. Use inside `useCodeScanner`'s `onCodeScanned`
 * callback to drop straight into existing `onBarcodeScanned` handlers.
 *
 *     const codeScanner = useCodeScanner({
 *       codeTypes: ALL_RETAIL_CODE_TYPES,
 *       onCodeScanned: (codes) => {
 *         const c = firstCodeValue(codes);
 *         if (c) onScan(c);
 *       },
 *     });
 */
export function firstCodeValue(codes: readonly Code[]): DecodedCode | null {
  for (const c of codes) {
    if (typeof c.value === 'string' && c.value.length > 0) {
      return { data: c.value, type: c.type };
    }
  }
  return null;
}

// ── Region-of-interest helpers (SCAN-1) ──────────────────────────────────────
//
// COORDINATE SPACE (verified against vision-camera v4.7.3 native source):
//   iOS  (CameraSession+CodeScanner.swift): each Code.frame is the metadata
//        object's normalized bounds multiplied by device.activeFormat
//        .videoDimensions, and CodeScannerFrame = those same videoDimensions.
//   Android (CameraView+Events.kt / CodeScannerPipeline.kt): Code.frame is the
//        ML-Kit barcode boundingBox (input-image pixels) and CodeScannerFrame
//        = (inputImage.width, inputImage.height).
// On BOTH platforms Code.frame and the CodeScannerFrame are expressed in the
// SAME coordinate space (camera output, not screen dp). So we can normalize a
// code's frame-center by the scan frame's width/height to get a stable 0..1
// fraction that is directly comparable to the on-screen reticle, which sits at
// the preview's center (~0.5, 0.5).
//
// We deliberately do NOT use vision-camera's `regionOfInterest` prop: it is
// iOS-only (no Android support in v4) and would silently do nothing on the
// warehouse Android devices. Filtering in JS by frame-center keeps both
// platforms identical.

/** A code annotated with its decoded value, normalized 0..1 center within the
 *  scan frame, and distance from the frame center. Returned by
 *  `centerMostCode` so the caller (tap-to-select overlay) can position hit
 *  targets and know which one is the auto-pick. */
export type RankedCode = {
  data: string;
  type: CodeType | 'unknown';
  /** Normalized 0..1 center X within the scan frame (camera-output space). */
  cx: number;
  /** Normalized 0..1 center Y within the scan frame. */
  cy: number;
  /** Euclidean distance (in normalized units) from the frame center (0.5,0.5). */
  distance: number;
  /** The raw vision-camera Code (for corner overlays etc.). */
  raw: Code;
};

/**
 * Normalized 0..1 center of a code within the scan frame, or null when the
 * geometry is unavailable (frame absent AND no usable corners). Falls back to
 * the corner centroid when `frame` is missing — on Android ML-Kit can report
 * `cornerPoints` without a `boundingBox`.
 */
export function codeCenterFraction(
  code: Code,
  frame: CodeScannerFrame,
): { cx: number; cy: number } | null {
  const fw = frame?.width ?? 0;
  const fh = frame?.height ?? 0;
  if (fw <= 0 || fh <= 0) return null;

  if (code.frame && code.frame.width >= 0 && code.frame.height >= 0) {
    const cx = (code.frame.x + code.frame.width / 2) / fw;
    const cy = (code.frame.y + code.frame.height / 2) / fh;
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      return { cx: clamp01(cx), cy: clamp01(cy) };
    }
  }

  // Fallback: centroid of the corner points (Android edge case).
  if (code.corners && code.corners.length > 0) {
    let sx = 0;
    let sy = 0;
    for (const p of code.corners) {
      sx += p.x;
      sy += p.y;
    }
    const cx = sx / code.corners.length / fw;
    const cy = sy / code.corners.length / fh;
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      return { cx: clamp01(cx), cy: clamp01(cy) };
    }
  }

  return null;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * DEVICE-TUNE: half-width of the square acceptance band around the frame
 * center, in normalized units. 0.30 → a code is "in the reticle" when its
 * center lies within the central 60%×60% of the frame. The on-screen reticle
 * (quick.tsx `s.scanGuide`) is ~75% wide × short, so 0.30 is intentionally a
 * little more generous than the visible box to tolerate the camera-output↔
 * preview aspect/orientation crop (the preview is `cover`-fitted, so the
 * visible region is a sub-rect of the output). Loosen toward 0.5 if staff
 * report "it won't read a code I've clearly centered"; tighten toward 0.2 if
 * it still grabs codes off to the side. Re-tune after real-device testing.
 */
export const RETICLE_TOLERANCE = 0.3;

/**
 * Rank every decoded code with a non-empty value by how close its center is to
 * the scan-frame center, nearest first. Codes whose geometry can't be derived
 * are dropped from ranking BUT, so we never regress to "won't scan at all" on a
 * device that reports no frame/corners, the caller can fall back to
 * `firstCodeValue`. Returns [] when no code carries a value.
 */
export function rankCodesByCenter(
  codes: readonly Code[],
  frame: CodeScannerFrame,
): RankedCode[] {
  const ranked: RankedCode[] = [];
  for (const c of codes) {
    if (typeof c.value !== 'string' || c.value.length === 0) continue;
    const center = codeCenterFraction(c, frame);
    if (!center) continue;
    const dx = center.cx - 0.5;
    const dy = center.cy - 0.5;
    ranked.push({
      data: c.value,
      type: c.type,
      cx: center.cx,
      cy: center.cy,
      distance: Math.sqrt(dx * dx + dy * dy),
      raw: c,
    });
  }
  ranked.sort((a, b) => a.distance - b.distance);
  return ranked;
}

/**
 * The single code to auto-accept from a scan callback: the one whose center is
 * nearest the frame center AND within `tolerance` (half-width of the square
 * band) on BOTH axes. Returns null when nothing is centered enough — that's
 * the desired "don't grab the off-center shipping label" behavior.
 *
 * GEOMETRY-UNAVAILABLE FALLBACK: when NONE of the codes expose usable frame /
 * corner geometry (e.g. a device/driver that omits it), we can't filter by
 * position, so we fall back to the first valued code — preserving the legacy
 * `firstCodeValue` behavior rather than silently refusing every scan. This is
 * surfaced via the `geometryMissing` flag so callers don't double-handle it.
 */
export function centerMostCode(
  codes: readonly Code[],
  frame: CodeScannerFrame,
  tolerance: number = RETICLE_TOLERANCE,
): { code: DecodedCode | null; ranked: RankedCode[]; geometryMissing: boolean } {
  const ranked = rankCodesByCenter(codes, frame);
  // Any valued codes at all?
  const hasValued = codes.some(
    (c) => typeof c.value === 'string' && c.value.length > 0,
  );
  if (ranked.length === 0) {
    // No geometry on any valued code → legacy fallback so we never dead-stop.
    return {
      code: hasValued ? firstCodeValue(codes) : null,
      ranked: [],
      geometryMissing: hasValued,
    };
  }
  const best = ranked[0];
  if (!best) {
    // Unreachable (ranked.length > 0 was checked above) but required by
    // noUncheckedIndexedAccess — ranked[0] is typed RankedCode | undefined.
    return {
      code: hasValued ? firstCodeValue(codes) : null,
      ranked: [],
      geometryMissing: hasValued,
    };
  }
  const within =
    Math.abs(best.cx - 0.5) <= tolerance && Math.abs(best.cy - 0.5) <= tolerance;
  return {
    code: within ? { data: best.data, type: best.type } : null,
    ranked,
    geometryMissing: false,
  };
}

// ── Hold-to-confirm debounce (SCAN-1) ────────────────────────────────────────
//
// Stops the scanner from accepting a barcode that merely *flickered* through
// the reticle for a single frame. The same decoded value must persist across
// N consecutive scan callbacks before it's accepted. vision-camera fires the
// code-scanned callback per analyzed frame, so N frames ≈ N × frame interval;
// at the typical ~10 fps metadata cadence, N=3 ≈ 300ms of steady aim. Any
// frame whose centered value differs (or is null) resets the streak.

/**
 * DEVICE-TUNE: consecutive identical-value frames required before a product
 * scan is accepted. 3 ≈ 300-400ms of steady centered aim on a ~10fps metadata
 * stream. Raise to 4-5 if staff report accidental grabs as a code sweeps past;
 * lower to 2 if the scanner feels sluggish on a fast operator. Re-tune on real
 * devices.
 */
export const HOLD_CONFIRM_FRAMES = 3;

/** Mutable streak counter for hold-to-confirm. Store one of these in a ref. */
export type HoldConfirmState = {
  value: string | null;
  count: number;
};

export function makeHoldConfirmState(): HoldConfirmState {
  return { value: null, count: 0 };
}

/**
 * Feed the current frame's centered value into the streak counter and report
 * whether it has now been held long enough to accept.
 *
 * - Same value as last frame → increment; accept once count >= frames.
 * - Different/!null value → restart the streak at 1 for the new value.
 * - null (nothing centered) → reset the streak (must re-acquire).
 *
 * Mutates `state` in place (it lives in a ref) and returns true on the frame
 * that crosses the threshold. After returning true it does NOT auto-reset —
 * the caller locks scanning and resets via `resetHoldConfirm` when it resumes,
 * so a held code isn't re-accepted every subsequent frame.
 */
export function pushHoldConfirm(
  state: HoldConfirmState,
  value: string | null,
  frames: number = HOLD_CONFIRM_FRAMES,
): boolean {
  if (value === null) {
    state.value = null;
    state.count = 0;
    return false;
  }
  if (state.value === value) {
    state.count += 1;
  } else {
    state.value = value;
    state.count = 1;
  }
  return state.count >= frames;
}

export function resetHoldConfirm(state: HoldConfirmState): void {
  state.value = null;
  state.count = 0;
}

/**
 * Default options for `cameraRef.current.takePhoto(...)`. `flash` is
 * merged in at the call site.
 *
 * Note: an earlier version of this file set `qualityPrioritization:
 * 'speed'` here. That's a vision-camera v5 field — v4's TakePhotoOptions
 * doesn't recognize it (silently ignored). Removed during the
 * 2026-05-15 audit. For speed-vs-quality control on v4, use the
 * `photoQualityBalance="speed"` prop on the Camera component itself.
 */
export const TAKE_PHOTO_OPTIONS = {
  enableShutterSound: false,
};

/** Flash mode strings — same set v4 accepts on `takePhoto({flash})`. */
export type FlashMode = 'off' | 'on' | 'auto';

/** Map a boolean torch state to v4's `torch` prop string. */
export function torchMode(on: boolean): 'on' | 'off' {
  return on ? 'on' : 'off';
}

/**
 * Resolve a safe `flash` value for `takePhoto({ flash })`.
 *
 * vision-camera REJECTS any non-'off' flash on a device that has no flash
 * unit (`device.hasFlash === false`) — the capture promise throws and the
 * employee can't attach a photo at all. Most iPads (and the warehouse
 * iPad in particular) have no flash, so a hard-coded `flash: 'auto'` is a
 * P0 capture failure there.
 *
 * This returns the caller's desired flash mode only when the active device
 * actually has a flash; otherwise it falls back to 'off' so the shot still
 * succeeds. Route EVERY `takePhoto({ flash })` call through this:
 *
 *     const photo = await cameraRef.current.takePhoto({
 *       flash: safeFlash(device, flashMode),
 *       ...TAKE_PHOTO_OPTIONS,
 *     });
 */
export function safeFlash(
  device: CameraDevice | null | undefined,
  desired: FlashMode = 'auto',
): FlashMode {
  return device?.hasFlash ? desired : 'off';
}

/**
 * Translate a vision-camera capture error into employee-friendly copy.
 *
 * Staff must NEVER see raw `CameraCaptureError.code` strings (e.g.
 * `capture/insufficient-storage`) or developer-facing `.message` text
 * (e.g. "flash unit not available"). We map the codes we can act on to
 * plain guidance and fall back to a generic "try again / Skip" line for
 * everything else.
 *
 * `err` is typed `unknown` because it arrives from a `catch` block; we
 * narrow on the `code` shape that `CameraCaptureError` exposes.
 */
export function translateCaptureError(err: unknown): string {
  const GENERIC =
    "Couldn't take the photo. Hold steady and tap the photo button again, or tap Skip to save the lot without a photo.";

  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined;

  if (typeof code !== 'string') return GENERIC;

  switch (code) {
    case 'capture/insufficient-storage':
      return "This device is out of storage, so the photo couldn't be saved. Free up some space, or tap Skip to save the lot without a photo.";
    case 'capture/file-io-error':
    case 'capture/create-temp-file-error':
    case 'capture/invalid-path':
    case 'capture/image-data-access-error':
    case 'capture/no-data':
      return "Couldn't save the photo to this device. Tap the photo button to try again, or tap Skip to save the lot without a photo.";
    case 'capture/photo-not-enabled':
    case 'session/camera-not-ready':
      return 'The camera isn’t ready yet. Wait a second and tap the photo button again, or tap Skip to save the lot without a photo.';
    case 'capture/timed-out':
      return 'The camera took too long. Hold steady and tap the photo button again, or tap Skip to save the lot without a photo.';
    default:
      return GENERIC;
  }
}
