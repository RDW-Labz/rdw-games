// Image compression for AI vision uploads.
//
// CRITICAL: Vision models care a LOT about aspect ratio. A distorted
// image makes the AI worse at reading model numbers, brand logos, and
// barcodes. The original LotTR PWA used canvas with proportional scaling
// (Math.min(max/w, max/h)) which preserved aspect ratio. expo-image-
// manipulator's `resize: { width: N, height: N }` STRETCHES the image
// to the exact dimensions — that's the bug.
//
// This helper mirrors the PWA's behavior: longer dimension capped at
// MAX_DIM, shorter dimension scales proportionally.

import * as ImageManipulator from 'expo-image-manipulator';

const MAX_DIM = 1200;
const QUALITY = 0.85; // bumped from 0.75 — vision likes detail, file size is still manageable

/**
 * Compress a captured image URI to a base64 JPEG, preserving aspect ratio.
 * Resizes so the longer dimension is at most MAX_DIM.
 *
 * PERF (2026-05-21): when the caller already knows the source dimensions
 * (e.g. react-native-vision-camera's `takePhoto()` returns `width` and
 * `height` on the photo object), pass them via the second arg to skip
 * the dimensions-probe round-trip. Previously this function did TWO
 * `manipulateAsync` calls: one to read width/height (no transform), then
 * the actual resize. On a 12MP iPhone 16 frame the probe alone is
 * 300-500ms of wasted native-bridge time.
 *
 * If `sourceDims` is omitted we still probe — back-compat for callers
 * that don't have dimensions handy.
 */
export async function compressForVision(
  uri: string,
  sourceDims?: { width: number; height: number },
): Promise<string> {
  // PERF (2026-05-21): skip the dims-probe call when the caller already
  // knows the photo's width/height (vision-camera's `takePhoto()` does).
  let width: number;
  let height: number;
  let sourceUri = uri;
  if (sourceDims && Number.isFinite(sourceDims.width) && Number.isFinite(sourceDims.height)) {
    width = sourceDims.width;
    height = sourceDims.height;
  } else {
    // Fallback for callers that don't know dimensions up front. This is
    // the slow path that the 2026-05-21 perf fix avoids when possible.
    const info = await ImageManipulator.manipulateAsync(uri, [], { base64: false });
    width = info.width;
    height = info.height;
    sourceUri = info.uri;
  }

  let resize: { width?: number; height?: number };
  if (width >= height) {
    // Landscape (or square): cap width
    resize = width > MAX_DIM ? { width: MAX_DIM } : {};
  } else {
    // Portrait: cap height
    resize = height > MAX_DIM ? { height: MAX_DIM } : {};
  }

  const result = await ImageManipulator.manipulateAsync(
    sourceUri,
    Object.keys(resize).length > 0 ? [{ resize }] : [],
    {
      compress: QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    },
  );

  return result.base64 ?? '';
}

/**
 * Compress an image URI to a JPEG on disk (aspect ratio preserved, longer
 * dimension capped at MAX_DIM) and return the NEW file URI. Same sizing as
 * compressForVision, but returns a `uri` (not base64) for the UPLOAD path.
 *
 * WHY (staff report 2026-07-17 — "app crashes when returning with a saved
 * stock photo"): gallery picks (CameraCaptureSheet's 🖼 picker) arrive at full
 * resolution (8-12MP / multi-MB). uploadImageFromUri reads the raw file to
 * base64 + decodes to a Uint8Array — three full copies alive at once, ~15-25MB
 * PER photo. Uploading raw gallery picks (esp. several concurrently) OOM-kills
 * the app natively (no JS trace), losing the unsaved lot. Compressing first
 * (≈200-400KB) removes the memory blow-up. Camera captures already go through
 * this via useLotCreation.compressToJpeg; this is the upload-path equivalent.
 */
export async function compressToJpegUri(
  uri: string,
  sourceDims?: { width: number; height: number },
): Promise<string> {
  let width: number;
  let height: number;
  let sourceUri = uri;
  if (sourceDims && Number.isFinite(sourceDims.width) && Number.isFinite(sourceDims.height)) {
    width = sourceDims.width;
    height = sourceDims.height;
  } else {
    const info = await ImageManipulator.manipulateAsync(uri, [], { base64: false });
    width = info.width;
    height = info.height;
    sourceUri = info.uri;
  }

  let resize: { width?: number; height?: number };
  if (width >= height) {
    resize = width > MAX_DIM ? { width: MAX_DIM } : {};
  } else {
    resize = height > MAX_DIM ? { height: MAX_DIM } : {};
  }

  const result = await ImageManipulator.manipulateAsync(
    sourceUri,
    Object.keys(resize).length > 0 ? [{ resize }] : [],
    {
      compress: QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: false,
    },
  );

  return result.uri;
}
